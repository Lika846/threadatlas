import fs from "node:fs";
import { configureWriterConnection, getWriterDb, type DbClient, type WriterDb } from "../db/client";
import { sanitizeDbError, type DbErrorCode } from "../db/errors";
import { isWriterUnusable, runWriterTransaction } from "../db/transaction-recovery";
import { acquireWriteLock, IMPORT_LOCK_WAIT_MS } from "../db/write-lock";
import { checkSearchIndex, clearSearchIndex, searchIndexIsEmpty, vacuumDatabase } from "../search/fts-index";
import { clearSemanticIndex, semanticRowCounts } from "../semantic/index/store";

/**
 * Delete all imported data, and storage cleanup (M1.7; A76–A82; design and
 * step-0 measurements in `docs/import-format.md`, *Deleting imported data*).
 *
 * Two phases, both under the cross-process write lock (A57), which is held
 * from before the transaction until verification has finished:
 *
 * 1. Logical deletion: one transaction deletes every Message, Conversation
 *    and ImportBatch row (A44), with `secure_delete = ON` (read back first:
 *    if SQLite does not confirm it and `temp_store = MEMORY`, nothing is
 *    deleted), then empties the search index (M2.1, A89). It also deletes every
 *    semantic chunk and status row explicitly (M5.1b, I3; the cascade is a
 *    second line) and increases the index epoch, so an indexing commit in
 *    flight is refused. The `EmbeddingIndex` row is kept: it holds versions and
 *    counters only. A failure rolls the whole transaction back: nothing is
 *    deleted.
 * 2. Storage cleanup: the search index is emptied again (a no-op after
 *    phase 1; it removes leftovers when cleanup runs on its own), then
 *    `VACUUM` with `temp_store = MEMORY` (no temporary copy on disk), then
 *    checks, including that the index is empty and passes its integrity
 *    check, and that no semantic chunk or status row remains. Full success is
 *    reported only if every check passes.
 *    secure_delete alone is not enough (step 0 found deleted text in the
 *    unused space of a live page), so VACUUM is required.
 *
 * Cleanup can also run on its own (`finishStorageCleanup`): it never deletes
 * rows, refuses to run while any imported row or semantic chunk or status row
 * exists, and is safe to repeat.
 * Emptying the index while the tables are empty removes no records: the index
 * holds only terms of rows that no longer exist.
 *
 * Best effort only: this removes deleted text from the database's own files
 * as SQLite sees them. It cannot erase copies in unlinked journal or
 * temporary-file blocks, APFS snapshots, SSD blocks or backups.
 *
 * Errors are mapped to codes; no error object, message, path or content is
 * logged or returned (A50).
 */

export type DataCounts = { conversations: number; messages: number; imports: number };

/** Why a run stopped before deleting anything. Rows are untouched. */
export type NotDeletedCode = "WRITE_BUSY" | "WRITE_LOCK_FAILED" | "WRITER_SETTINGS_UNAVAILABLE" | DbErrorCode;

/** Why storage cleanup did not reach a verified finish. */
export type CleanupCode = "CLEANUP_DB_BUSY" | "CLEANUP_FAILED" | "CLEANUP_UNVERIFIED";

/** Why a standalone cleanup did not run. Nothing was changed. */
export type CleanupNotRunCode = "WRITE_BUSY" | "WRITE_LOCK_FAILED" | "WRITER_SETTINGS_UNAVAILABLE" | "IMPORTED_DATA_PRESENT" | DbErrorCode;

/**
 * `writerSettingsRestored` is false when resetting the writer's pragmas
 * failed after the run. It never changes `status`: the outcome reported is
 * the one that happened. Imports reset the same pragmas before they start,
 * so a failed reset does not carry over to them.
 */
export type DeleteAllResult =
  | { status: "complete"; deleted: DataCounts; writerSettingsRestored: boolean }
  | { status: "deleted_cleanup_incomplete"; deleted: DataCounts; code: CleanupCode; writerSettingsRestored: boolean }
  | { status: "not_deleted"; code: NotDeletedCode; writerSettingsRestored: boolean };

export type CleanupResult =
  | { status: "complete"; writerSettingsRestored: boolean }
  | { status: "incomplete"; code: CleanupCode; writerSettingsRestored: boolean }
  | { status: "not_run"; code: CleanupNotRunCode; writerSettingsRestored: boolean };

/** Test-only fault-injection seams (as in the import service); production callers never pass them. */
export type DeleteAllHooks = {
  inTransaction?: (db: DbClient) => void | Promise<void>;
  afterCommit?: () => void | Promise<void>;
  beforeVacuum?: (db: DbClient) => void | Promise<void>;
  afterVacuum?: (db: DbClient) => void | Promise<void>;
  beforeRestore?: () => void | Promise<void>;
};

export type DeleteAllDeps = { writer?: WriterDb; hooks?: DeleteAllHooks };

/** Interactive-transaction limits. Deleting 20,000 messages took about 160 ms in step 0. */
const TX_OPTIONS = { maxWait: 10_000, timeout: 120_000 } as const;

// ---- Reading state (page renders; reader connection) ----------------------

export async function getImportedDataCounts(db: DbClient): Promise<DataCounts> {
  const [conversations, messages, imports] = await Promise.all([
    db.conversation.count(),
    db.message.count(),
    db.importBatch.count(),
  ]);
  return { conversations, messages, imports };
}

export const isEmpty = (c: DataCounts) => c.conversations === 0 && c.messages === 0 && c.imports === 0;

async function pragmaValue(db: DbClient, name: string): Promise<unknown> {
  const rows = (await db.$queryRawUnsafe(`PRAGMA ${name}`)) as Record<string, unknown>[];
  const first = rows[0];
  return first === undefined ? undefined : Object.values(first)[0];
}

async function freePages(db: DbClient): Promise<number> {
  return Number(await pragmaValue(db, "freelist_count"));
}

/** The main database file, as SQLite opened it (never logged or returned). */
async function mainFile(db: DbClient): Promise<string | null> {
  const rows = (await db.$queryRawUnsafe("PRAGMA database_list")) as { name?: unknown; file?: unknown }[];
  const main = rows.find((r) => r.name === "main");
  return typeof main?.file === "string" && main.file !== "" ? main.file : null;
}

/** A leftover rollback journal (or WAL) next to the database. Checked by path only, never opened. */
function sidecarPresent(dbPath: string): boolean {
  return [`${dbPath}-journal`, `${dbPath}-wal`].some((f) => {
    try {
      fs.lstatSync(f);
      return true;
    } catch {
      return false;
    }
  });
}

export type DataState = {
  counts: DataCounts;
  /**
   * Only when every imported table is empty: true if the database shows
   * evidence that deleted text may remain (free pages, a leftover journal, or
   * entries left in the search index), null if that could not be checked. False is NOT proof that a previous
   * cleanup succeeded (A80): cleanup stays available either way.
   */
  cleanupMayBeIncomplete: boolean | null;
};

export async function getDataState(db: DbClient): Promise<DataState> {
  const counts = await getImportedDataCounts(db);
  if (!isEmpty(counts)) return { counts, cleanupMayBeIncomplete: null };
  try {
    const file = await mainFile(db);
    if (file === null) return { counts, cleanupMayBeIncomplete: null };
    const evidence = (await freePages(db)) > 0 || sidecarPresent(file) || !(await searchIndexIsEmpty(db));
    return { counts, cleanupMayBeIncomplete: evidence };
  } catch {
    return { counts, cleanupMayBeIncomplete: null };
  }
}

// ---- Writer settings ---------------------------------------------------------

/** secure_delete and in-memory temp storage on; true only if SQLite confirms both. */
async function applyCleanupSettings(db: DbClient): Promise<boolean> {
  await configureWriterConnection(db);
  await db.$executeRawUnsafe("PRAGMA secure_delete = ON");
  await db.$executeRawUnsafe("PRAGMA temp_store = MEMORY");
  return Number(await pragmaValue(db, "secure_delete")) === 1 && Number(await pragmaValue(db, "temp_store")) === 2;
}

/** Back to the import defaults. Never throws: a failure is reported, not hidden. */
async function restoreSettings(db: DbClient, hooks: DeleteAllHooks | undefined): Promise<boolean> {
  try {
    await hooks?.beforeRestore?.();
    await configureWriterConnection(db);
    return Number(await pragmaValue(db, "secure_delete")) === 0 && Number(await pragmaValue(db, "temp_store")) === 0;
  } catch {
    return false;
  }
}

// ---- Cleanup ---------------------------------------------------------------

/**
 * Empty the search index (only while the imported tables are empty), VACUUM,
 * then checks. Call only under the write lock with the cleanup settings applied.
 */
async function cleanUpStorage(
  db: DbClient,
  dbPath: string,
  hooks: DeleteAllHooks | undefined,
): Promise<{ ok: true } | { ok: false; code: CleanupCode }> {
  try {
    if (isEmpty(await getImportedDataCounts(db)) && !(await searchIndexIsEmpty(db))) await clearSearchIndex(db);
    await hooks?.beforeVacuum?.(db);
    await vacuumDatabase(db);
    await hooks?.afterVacuum?.(db);
  } catch (e) {
    return { ok: false, code: sanitizeDbError(e) === "DB_BUSY" ? "CLEANUP_DB_BUSY" : "CLEANUP_FAILED" };
  }
  try {
    const counts = await getImportedDataCounts(db);
    const semantic = await semanticRowCounts(db);
    const check = await pragmaValue(db, "quick_check");
    const verified =
      isEmpty(counts) &&
      semantic.chunks === 0 &&
      semantic.statuses === 0 &&
      (await freePages(db)) === 0 &&
      check === "ok" &&
      !sidecarPresent(dbPath) &&
      (await searchIndexIsEmpty(db)) &&
      (await checkSearchIndex(db));
    return verified ? { ok: true } : { ok: false, code: "CLEANUP_UNVERIFIED" };
  } catch {
    return { ok: false, code: "CLEANUP_UNVERIFIED" };
  }
}

type SessionFailure = "WRITE_BUSY" | "WRITE_LOCK_FAILED" | "WRITER_SETTINGS_UNAVAILABLE" | DbErrorCode;
type Session<T> = { ok: true; value: T; restored: boolean } | { ok: false; code: SessionFailure; restored: boolean };

/**
 * Takes the write lock, applies the cleanup settings, runs `body`, then
 * restores the settings and releases the lock, whatever happened. The lock
 * file is handled only by `write-lock.ts` (never opened, closed or unlinked here).
 */
async function withCleanupSession<T>(deps: DeleteAllDeps, body: (writer: WriterDb) => Promise<T>): Promise<Session<T>> {
  let writer: WriterDb;
  try {
    writer = deps.writer ?? getWriterDb();
  } catch (e) {
    return { ok: false, code: sanitizeDbError(e), restored: true };
  }
  if (isWriterUnusable(writer.db)) return { ok: false, code: "DB_WRITER_UNUSABLE", restored: true };
  const lock = await acquireWriteLock(writer.dbPath, { waitMs: IMPORT_LOCK_WAIT_MS });
  if (!lock.ok) return { ok: false, code: lock.code === "IMPORT_BUSY" ? "WRITE_BUSY" : "WRITE_LOCK_FAILED", restored: true };
  let outcome: { ok: true; value: T } | { ok: false; code: SessionFailure };
  let restored = false;
  try {
    let applied = false;
    try {
      applied = await applyCleanupSettings(writer.db);
    } catch {
      applied = false;
    }
    outcome = applied ? { ok: true, value: await body(writer) } : { ok: false, code: "WRITER_SETTINGS_UNAVAILABLE" };
  } catch (e) {
    // `body` handles its own errors; this is a last line of defence.
    outcome = { ok: false, code: sanitizeDbError(e) };
  } finally {
    // Runs before the lock is released, so no import can start with these
    // settings. Never through an unusable writer: no statement is sent on it,
    // and imports refuse it anyway.
    restored = isWriterUnusable(writer.db) ? false : await restoreSettings(writer.db, deps.hooks);
    lock.lock.release();
  }
  return { ...outcome, restored };
}

/**
 * Deletes every imported record, then cleans up storage. Call only after the
 * request and the confirmation phrase have been checked.
 */
export async function deleteAllImportedData(deps: DeleteAllDeps = {}): Promise<DeleteAllResult> {
  const hooks = deps.hooks;
  type Phases = { ok: false; code: DbErrorCode } | { ok: true; deleted: DataCounts; cleanup: Awaited<ReturnType<typeof cleanUpStorage>> };
  const session = await withCleanupSession<Phases>(deps, async ({ db, dbPath }) => {
    let deleted: DataCounts;
    try {
      // A failed transaction (including a busy COMMIT) is rolled back
      // explicitly; see `transaction-recovery.ts`.
      deleted = await runWriterTransaction(
        db,
        async (tx) => {
          // I3 first: explicit, so the derived rows never depend on the cascade.
          await clearSemanticIndex(tx);
          const messages = (await tx.message.deleteMany()).count;
          const conversations = (await tx.conversation.deleteMany()).count;
          const imports = (await tx.importBatch.deleteMany()).count;
          // After the row deletes, whose triggers need the index entries.
          await clearSearchIndex(tx);
          await hooks?.inTransaction?.(tx as unknown as DbClient);
          return { conversations, messages, imports };
        },
        TX_OPTIONS,
      );
    } catch (e) {
      // Rolled back: nothing deleted. If that could not be shown, the writer
      // is marked unusable; the uncommitted deletes end with the connection.
      return { ok: false, code: sanitizeDbError(e) };
    }
    // Committed: from here on, any failure is reported as an incomplete
    // cleanup, never as "nothing deleted".
    try {
      await hooks?.afterCommit?.();
      return { ok: true, deleted, cleanup: await cleanUpStorage(db, dbPath, hooks) };
    } catch {
      return { ok: true, deleted, cleanup: { ok: false, code: "CLEANUP_FAILED" } };
    }
  });
  const writerSettingsRestored = session.restored;
  if (!session.ok) return { status: "not_deleted", code: session.code, writerSettingsRestored };
  const r = session.value;
  if (!r.ok) return { status: "not_deleted", code: r.code, writerSettingsRestored };
  return r.cleanup.ok
    ? { status: "complete", deleted: r.deleted, writerSettingsRestored }
    : { status: "deleted_cleanup_incomplete", deleted: r.deleted, code: r.cleanup.code, writerSettingsRestored };
}

/**
 * Storage cleanup on its own (after an incomplete or interrupted run). Never
 * deletes rows: it issues no DELETE, and refuses while any imported row
 * exists (checked under the lock), so data imported meanwhile is untouched.
 * Safe to repeat.
 */
export async function finishStorageCleanup(deps: DeleteAllDeps = {}): Promise<CleanupResult> {
  type Run = { ok: false; code: "IMPORTED_DATA_PRESENT" | DbErrorCode } | { ok: true; cleanup: Awaited<ReturnType<typeof cleanUpStorage>> };
  const session = await withCleanupSession<Run>(deps, async ({ db, dbPath }) => {
    let counts: DataCounts;
    let semantic: { chunks: number; statuses: number };
    try {
      counts = await getImportedDataCounts(db);
      semantic = await semanticRowCounts(db);
    } catch (e) {
      return { ok: false, code: sanitizeDbError(e) };
    }
    if (!isEmpty(counts) || semantic.chunks > 0 || semantic.statuses > 0) return { ok: false, code: "IMPORTED_DATA_PRESENT" };
    return { ok: true, cleanup: await cleanUpStorage(db, dbPath, deps.hooks) };
  });
  const writerSettingsRestored = session.restored;
  if (!session.ok) return { status: "not_run", code: session.code, writerSettingsRestored };
  const r = session.value;
  if (!r.ok) return { status: "not_run", code: r.code, writerSettingsRestored };
  return r.cleanup.ok
    ? { status: "complete", writerSettingsRestored }
    : { status: "incomplete", code: r.cleanup.code, writerSettingsRestored };
}
