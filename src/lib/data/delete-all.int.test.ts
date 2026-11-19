import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { killChild, spawnChild, waitForFile, type Child } from "../../../tests/helpers/child/spawn";
import { dumpConversations, importText } from "../../../tests/helpers/import";
import { exportText, syntheticConversation, syntheticExport } from "../../../tests/helpers/synthetic-export";
import { createTestDb, type TestDb } from "../../../tests/helpers/test-db";
import type { DbClient } from "../db/client";
import { acquireWriteLock, lockPathFor } from "../db/write-lock";
import { importAdapterResult } from "../import/import-service";
import { validateExportText } from "../import/validate-export";
import { deleteAllImportedData, finishStorageCleanup, getDataState, getImportedDataCounts } from "./delete-all";
import { deleteResultState } from "./messages";
import { indexWith } from "../../../tests/helpers/semantic-index";

/**
 * Delete-all and storage cleanup (M1.7) on isolated temporary databases with
 * synthetic canaries. "Canary absent" means absent from the database's own
 * files as written; it is not a forensic erasure check (A78).
 */

const CANARY = "ZQXDELCANARY7714";

/** Synthetic export with the canary in titles, short and long (overflow) texts, and an unsupported raw payload. */
function canaryExport(): string {
  const many = syntheticExport(40, { messages: 8, tag: CANARY, textLength: 1200, title: `${CANARY} title` });
  const long = syntheticExport(5, { idPrefix: "long", messages: 3, tag: CANARY, textLength: 9000 });
  const raw = syntheticConversation({
    id: "raw-0",
    messages: 2,
    messageExtra: { content: { content_type: "synthetic_unsupported", payload: `${CANARY} raw payload` } },
  });
  return exportText([...many, ...long, raw]);
}

function canaryCount(file: string): number {
  if (!fs.existsSync(file)) return 0;
  const b = fs.readFileSync(file);
  let n = 0;
  for (let i = b.indexOf(CANARY); i !== -1; i = b.indexOf(CANARY, i + 1)) n++;
  return n;
}

/** A PRAGMA's value; integers as numbers (SQLite returns them as BigInt). */
async function pragma(db: DbClient, name: string): Promise<unknown> {
  const rows = (await db.$queryRawUnsafe(`PRAGMA ${name}`)) as Record<string, unknown>[];
  const v = Object.values(rows[0]!)[0];
  return typeof v === "bigint" ? Number(v) : v;
}

async function seed(t: TestDb): Promise<void> {
  const r = await importText(canaryExport(), { writer: t.writer });
  expect(r.complete).toBe(true);
  expect(canaryCount(t.file)).toBeGreaterThan(0);
  expect(await t.db.message.count({ where: { rawContentJson: { contains: CANARY } } })).toBeGreaterThan(0);
}

/** A gate a hook can wait on. */
function gate() {
  let open!: () => void;
  let reached!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  const arrived = new Promise<void>((r) => (reached = r));
  return { wait: async () => (reached(), await opened), open, arrived };
}

let t: TestDb;
const extra: (() => void | Promise<void>)[] = [];
beforeEach(() => {
  t = createTestDb();
});
afterEach(async () => {
  for (const f of extra.splice(0)) await f();
  await t.cleanup();
});

describe("deleteAllImportedData", () => {
  it("deletes all three tables in one run, keeps the schema and migrations, and removes the canary from the database files", async () => {
    await seed(t);
    const before = await getImportedDataCounts(t.db);
    const migrations = await t.db.$queryRawUnsafe('SELECT "migration_name" FROM "_prisma_migrations"');

    const r = await deleteAllImportedData({ writer: t.writer });

    expect(r).toEqual({ status: "complete", deleted: before, writerSettingsRestored: true });
    expect(await getImportedDataCounts(t.db)).toEqual({ conversations: 0, messages: 0, imports: 0 });
    expect(await t.db.$queryRawUnsafe('SELECT "migration_name" FROM "_prisma_migrations"')).toEqual(migrations);
    expect(await pragma(t.db, "integrity_check")).toBe("ok");
    expect(await pragma(t.db, "freelist_count")).toBe(0);
    expect(canaryCount(t.file)).toBe(0);
    expect(fs.existsSync(`${t.file}-journal`)).toBe(false);
    // Writer back to the import defaults; the lock is free again.
    expect(await pragma(t.db, "secure_delete")).toBe(0);
    expect(await pragma(t.db, "temp_store")).toBe(0);
    expect(await getDataState(t.db)).toEqual({ counts: { conversations: 0, messages: 0, imports: 0 }, cleanupMayBeIncomplete: false });
  });

  it("the normal import pipeline works after deletion", async () => {
    await seed(t);
    await deleteAllImportedData({ writer: t.writer });
    const again = await importText(canaryExport(), { writer: t.writer });
    expect(again.complete).toBe(true);
    expect(again.counts.added).toBe(46);
    expect((await getImportedDataCounts(t.db)).conversations).toBe(46);
  });

  it("works on an empty database (nothing imported yet)", async () => {
    const r = await deleteAllImportedData({ writer: t.writer });
    expect(r).toEqual({ status: "complete", deleted: { conversations: 0, messages: 0, imports: 0 }, writerSettingsRestored: true });
  });

  it("rolls back completely when the transaction fails: nothing deleted, no success reported", async () => {
    await seed(t);
    const dump = await dumpConversations(t.db);
    const r = await deleteAllImportedData({
      writer: t.writer,
      hooks: {
        inTransaction: () => {
          throw new Error(`injected ${CANARY}`);
        },
      },
    });
    expect(r).toEqual({ status: "not_deleted", code: "IMPORT_INTERNAL_ERROR", writerSettingsRestored: true });
    expect(JSON.stringify(r)).not.toContain(CANARY);
    expect(await dumpConversations(t.db)).toBe(dump);
    expect(await t.db.importBatch.count()).toBe(1);
    expect(await pragma(t.db, "secure_delete")).toBe(0);
  });

  /** Opens a reader transaction (as another process could) and holds it until `release`. */
  async function holdReadTransaction(reader: DbClient) {
    const g = gate();
    const done = reader.$transaction(
      async (tx) => {
        await tx.conversation.count();
        await g.wait();
      },
      { timeout: 60_000 },
    );
    await g.arrived;
    return async () => {
      g.open();
      await done;
    };
  }

  it("a reader transaction blocking the commit (SQLITE_BUSY) rolls back: nothing deleted, retryable", async () => {
    await seed(t);
    const dump = await dumpConversations(t.db);
    const reader = t.reader();
    const release = await holdReadTransaction(reader);
    const r = await deleteAllImportedData({ writer: t.writer });
    await release();
    expect(r).toEqual({ status: "not_deleted", code: "DB_BUSY", writerSettingsRestored: true });
    expect(deleteResultState(r, 1).message).toMatch(/^Nothing was deleted\. /);
    // The failed COMMIT left no open transaction behind: the writer sees the
    // rows again and other connections are not blocked.
    const t0 = performance.now();
    expect(await reader.conversation.count()).toBe(46);
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(await dumpConversations(t.db)).toBe(dump);
    expect(await dumpConversations(reader)).toBe(dump);
    expect((await deleteAllImportedData({ writer: t.writer })).status).toBe("complete");
  }, 30_000);

  it("reports deletion without cleanup when VACUUM is blocked (SQLITE_BUSY), and cleanup can then finish", async () => {
    await seed(t);
    let release: (() => Promise<void>) | undefined;
    const r = await deleteAllImportedData({
      writer: t.writer,
      // A reader transaction that starts after the commit blocks VACUUM's exclusive lock.
      hooks: { afterCommit: async () => void (release = await holdReadTransaction(t.reader())) },
    });
    await release?.();

    expect(r).toMatchObject({ status: "deleted_cleanup_incomplete", code: "CLEANUP_DB_BUSY", writerSettingsRestored: true });
    expect(await getImportedDataCounts(t.db)).toEqual({ conversations: 0, messages: 0, imports: 0 });
    const state = deleteResultState(r, 1);
    expect(state.tone).toBe("warning");
    expect(state.message).toMatch(/^All imported data was deleted: 46 conversations, .* Storage cleanup is incomplete or unverified/);
    expect(state.message).not.toMatch(/finished/);
    expect((await getDataState(t.db)).cleanupMayBeIncomplete).toBe(true);

    expect(await finishStorageCleanup({ writer: t.writer })).toEqual({ status: "complete", writerSettingsRestored: true });
    expect((await getDataState(t.db)).cleanupMayBeIncomplete).toBe(false);
    expect(canaryCount(t.file)).toBe(0);
  }, 30_000);

  it("an unexpected failure after the commit is reported as deleted with cleanup incomplete, never as nothing deleted", async () => {
    await seed(t);
    const r = await deleteAllImportedData({
      writer: t.writer,
      hooks: {
        afterCommit: () => {
          throw new Error("injected");
        },
      },
    });
    expect(r).toMatchObject({ status: "deleted_cleanup_incomplete", code: "CLEANUP_FAILED", writerSettingsRestored: true });
    expect(await getImportedDataCounts(t.db)).toEqual({ conversations: 0, messages: 0, imports: 0 });
  });

  it("a failed verification is never reported as full success", async () => {
    await seed(t);
    const journal = `${t.file}-journal`;
    extra.push(() => fs.rmSync(journal, { force: true }));
    // An empty leftover journal file (never hot) appears after VACUUM.
    const r = await deleteAllImportedData({ writer: t.writer, hooks: { afterVacuum: () => fs.writeFileSync(journal, "") } });
    expect(r).toMatchObject({ status: "deleted_cleanup_incomplete", code: "CLEANUP_UNVERIFIED" });
    expect(deleteResultState(r, 1).tone).toBe("warning");
    expect((await getDataState(t.db)).cleanupMayBeIncomplete).toBe(true);

    const c = await finishStorageCleanup({ writer: t.writer, hooks: { afterVacuum: () => fs.writeFileSync(journal, "") } });
    expect(c).toMatchObject({ status: "incomplete", code: "CLEANUP_UNVERIFIED" });
  });

  it("a settings-restore failure is reported and does not change the outcome; the next import resets the settings", async () => {
    await seed(t);
    const r = await deleteAllImportedData({
      writer: t.writer,
      hooks: {
        beforeRestore: () => {
          throw new Error("injected");
        },
      },
    });
    expect(r).toMatchObject({ status: "complete", writerSettingsRestored: false });
    expect(deleteResultState(r, 1).message).toMatch(/could not be reset afterwards/);
    expect(await pragma(t.db, "secure_delete")).toBe(1); // left on by the failed restore
    await importText(canaryExport(), { writer: t.writer });
    expect(await pragma(t.db, "secure_delete")).toBe(0);
    expect(await pragma(t.db, "temp_store")).toBe(0);
  });
});

describe("finishStorageCleanup", () => {
  it("is available and succeeds when the tables are empty, even with no free pages and no journal; repeating is safe", async () => {
    expect(await getDataState(t.db)).toEqual({ counts: { conversations: 0, messages: 0, imports: 0 }, cleanupMayBeIncomplete: false });
    for (let i = 0; i < 3; i++) {
      expect(await finishStorageCleanup({ writer: t.writer })).toEqual({ status: "complete", writerSettingsRestored: true });
    }
    expect(await pragma(t.db, "integrity_check")).toBe("ok");
    expect(await pragma(t.db, "secure_delete")).toBe(0);
  });

  it("never deletes imported records, including data imported after the page was shown", async () => {
    await seed(t);
    const dump = await dumpConversations(t.db);
    const batches = await t.db.importBatch.count();
    expect(await finishStorageCleanup({ writer: t.writer })).toEqual({ status: "not_run", code: "IMPORTED_DATA_PRESENT", writerSettingsRestored: true });
    expect(await dumpConversations(t.db)).toBe(dump);
    expect(await t.db.importBatch.count()).toBe(batches);
  });
});

describe("semantic index (M5.1b, I3)", () => {
  /** A distinctive 388-byte vector (int8-absmax-v1 length for 384 dimensions). */
  const VECTOR_CANARY = Buffer.from("M51B-DELETE-ALL-VECTOR-CANARY-".repeat(13)).subarray(0, 388);
  const vectorCanaryCount = (file: string) => {
    const b = fs.readFileSync(file);
    let n = 0;
    for (let i = b.indexOf(VECTOR_CANARY); i !== -1; i = b.indexOf(VECTOR_CANARY, i + 1)) n++;
    return n;
  };
  const semanticCounts = async () => {
    const [r] = await t.db.$queryRawUnsafe<{ s: bigint; c: bigint; i: bigint }[]>(
      `SELECT (SELECT COUNT(*) FROM "EmbeddingStatus") AS s, (SELECT COUNT(*) FROM "EmbeddingChunk") AS c, (SELECT COUNT(*) FROM "EmbeddingIndex") AS i`,
    );
    return { statuses: Number(r!.s), chunks: Number(r!.c), indexRows: Number(r!.i) };
  };
  const indexRowOf = async () => (await t.db.embeddingIndex.findUniqueOrThrow({ where: { id: "main" } }));

  async function seedIndexed() {
    expect((await importText(exportText(syntheticExport(6, { messages: 6, textLength: 400 })), { writer: t.writer })).complete).toBe(true);
    expect((await indexWith(t)).status).toBe("finished");
    await t.db.$executeRawUnsafe(`UPDATE "EmbeddingChunk" SET "vector" = ?`, VECTOR_CANARY);
    expect(vectorCanaryCount(t.file)).toBeGreaterThan(0);
  }

  it("deletes every chunk and status row, keeps the index row with a higher epoch, and leaves no vector bytes in the file", async () => {
    await seedIndexed();
    const before = await indexRowOf();
    const r = await deleteAllImportedData({ writer: t.writer });
    expect(r.status).toBe("complete");
    expect(await semanticCounts()).toEqual({ statuses: 0, chunks: 0, indexRows: 1 });
    const after = await indexRowOf();
    expect([after.epoch, after.changeCounter]).toEqual([before.epoch + 1, before.changeCounter + 1]);
    expect(after.embeddingVersion).toBe(before.embeddingVersion);
    expect(vectorCanaryCount(t.file)).toBe(0);
    expect(await pragma(t.db, "freelist_count")).toBe(0);
    expect(await pragma(t.db, "quick_check")).toBe("ok");
  });

  it("the epoch only ever increases across delete-all, re-import and reindex", async () => {
    const epochs: number[] = [];
    for (let i = 0; i < 3; i++) {
      await seedIndexed();
      epochs.push((await indexRowOf()).epoch);
      expect((await deleteAllImportedData({ writer: t.writer })).status).toBe("complete");
      epochs.push((await indexRowOf()).epoch);
    }
    expect(epochs).toEqual([1, 2, 2, 3, 3, 4]);
  });

  it("a failed delete-all rolls the semantic rows back with everything else", async () => {
    await seedIndexed();
    const before = [await semanticCounts(), await indexRowOf()];
    const r = await deleteAllImportedData({ writer: t.writer, hooks: { inTransaction: () => { throw new Error("injected"); } } });
    expect(r.status).toBe("not_deleted");
    expect([await semanticCounts(), await indexRowOf()]).toEqual(before);
  });

  it("on a database not yet migrated to M5.1b, delete-all refuses with DB_NOT_MIGRATED and deletes nothing", async () => {
    await seed(t);
    const dump = await dumpConversations(t.db);
    const Database = (await import("better-sqlite3")).default;
    const raw = new Database(t.file);
    raw.exec(`DROP TABLE "EmbeddingChunk"; DROP TABLE "EmbeddingStatus"; DROP TABLE "EmbeddingIndex"`);
    raw.close();
    const r = await deleteAllImportedData({ writer: t.writer });
    expect(r).toEqual({ status: "not_deleted", code: "DB_NOT_MIGRATED", writerSettingsRestored: true });
    expect(await dumpConversations(t.db)).toBe(dump);
  });

  it("standalone cleanup refuses while any chunk or status row exists, and changes nothing", async () => {
    // Orphan rows can only appear with foreign keys off (a damaged or hand-edited file).
    const Database = (await import("better-sqlite3")).default;
    const raw = new Database(t.file);
    raw.exec("PRAGMA foreign_keys = OFF");
    raw.prepare(`INSERT INTO "EmbeddingChunk" VALUES ('orphan', 'h', 'p', 1, 'n', 0, 0, 1, 1, 'k', ?)`).run(VECTOR_CANARY);
    raw.close();
    expect(await finishStorageCleanup({ writer: t.writer })).toEqual({ status: "not_run", code: "IMPORTED_DATA_PRESENT", writerSettingsRestored: true });
    expect((await semanticCounts()).chunks).toBe(1);
    // Delete-all removes it, and its verification then passes.
    expect((await deleteAllImportedData({ writer: t.writer })).status).toBe("complete");
    expect(await semanticCounts()).toMatchObject({ statuses: 0, chunks: 0 });
    expect(vectorCanaryCount(t.file)).toBe(0);
  });
});

describe("concurrency (the shared write lock is held throughout)", () => {
  it("a delete-all that starts while another process holds the write lock for 500 ms (the indexer's T2 budget) waits and completes", async () => {
    await importText(exportText(syntheticExport(2)), { writer: t.writer });
    const out = path.join(path.dirname(t.file), "holder-out");
    const holder = spawnChild(t.file, { CHILD_TASK: "lock-try", CHILD_OUT: out, CHILD_HOLD_MS: "500" });
    try {
      expect(await waitForFile(out)).toBe("ACQUIRED");
      expect((await deleteAllImportedData({ writer: t.writer })).status).toBe("complete");
      expect(await t.db.conversation.count()).toBe(0);
    } finally {
      await killChild(holder);
    }
  }, 60_000);

  it("while a delete holds the lock, imports, deletes and cleanups are refused and change nothing", async () => {
    await seed(t);
    const g = gate();
    const first = deleteAllImportedData({ writer: t.writer, hooks: { afterCommit: g.wait } });
    await g.arrived;

    const other = { db: t.reader(), dbPath: t.file };
    const parsed = validateExportText(exportText([syntheticConversation({ id: "late", messages: 2 })]));
    if (!parsed.ok) throw new Error("synthetic export must parse");
    const imp = await importAdapterResult(parsed, { filename: "x.json", sha256: "0".repeat(64), byteLength: 1 }, { writer: other });
    expect(imp).toMatchObject({ batchId: null, errorCode: "IMPORT_BUSY" });
    expect(await deleteAllImportedData({ writer: other })).toEqual({ status: "not_deleted", code: "WRITE_BUSY", writerSettingsRestored: true });
    expect(await finishStorageCleanup({ writer: other })).toEqual({ status: "not_run", code: "WRITE_BUSY", writerSettingsRestored: true });

    g.open();
    expect((await first).status).toBe("complete");
    expect(await getImportedDataCounts(t.db)).toEqual({ conversations: 0, messages: 0, imports: 0 });
  });

  it("while an import holds the lock, delete-all and cleanup are refused and delete nothing", async () => {
    await seed(t);
    const dump = await dumpConversations(t.db);
    const g = gate();
    const parsed = validateExportText(exportText([syntheticConversation({ id: "late", messages: 2 })]));
    if (!parsed.ok) throw new Error("synthetic export must parse");
    const imp = importAdapterResult(parsed, { filename: "x.json", sha256: "0".repeat(64), byteLength: 1 }, { writer: t.writer, hooks: { afterBatchCreated: g.wait } });
    await g.arrived;
    const other = { db: t.reader(), dbPath: t.file };
    expect(await deleteAllImportedData({ writer: other })).toEqual({ status: "not_deleted", code: "WRITE_BUSY", writerSettingsRestored: true });
    expect(await finishStorageCleanup({ writer: other })).toEqual({ status: "not_run", code: "WRITE_BUSY", writerSettingsRestored: true });
    expect(await dumpConversations(t.db)).toBe(dump);
    g.open();
    expect((await imp).complete).toBe(true);
    expect((await getImportedDataCounts(t.db)).conversations).toBe(47);
  });

  it("a lock held by another process makes delete-all fail closed", async () => {
    await seed(t);
    const out = path.join(path.dirname(t.file), `${path.basename(t.file)}.out`);
    const child: Child = spawnChild(t.file, { CHILD_TASK: "lock-hold", CHILD_OUT: out });
    extra.push(async () => {
      await killChild(child);
      fs.rmSync(out, { force: true });
    });
    expect(await waitForFile(out)).toBe("ACQUIRED");
    expect(await deleteAllImportedData({ writer: t.writer })).toEqual({ status: "not_deleted", code: "WRITE_BUSY", writerSettingsRestored: true });
    expect((await getImportedDataCounts(t.db)).conversations).toBe(46);
  }, 60_000);

  it("the lock stays held through VACUUM and verification, for delete-all and for cleanup", async () => {
    await seed(t);
    const probes: string[] = [];
    const probe = async () => {
      const r = await acquireWriteLock(t.file, { attempts: 1 });
      probes.push(r.ok ? "ACQUIRED" : r.code);
      if (r.ok) r.lock.release();
    };
    const hooks = { inTransaction: probe, afterCommit: probe, beforeVacuum: probe, afterVacuum: probe };
    expect((await deleteAllImportedData({ writer: t.writer, hooks })).status).toBe("complete");
    expect((await finishStorageCleanup({ writer: t.writer, hooks })).status).toBe("complete");
    expect(probes).toEqual(Array(6).fill("IMPORT_BUSY"));
    await probe();
    expect(probes.at(-1)).toBe("ACQUIRED"); // released afterwards
  });

  it("fails closed when the lock cannot be acquired safely (symlinked lock path), leaving the target alone", async () => {
    await seed(t);
    const target = path.join(path.dirname(t.file), `${path.basename(t.file)}.elsewhere`);
    fs.writeFileSync(target, "synthetic");
    fs.rmSync(lockPathFor(t.file), { force: true }); // created by the seed import; not held
    fs.symlinkSync(target, lockPathFor(t.file));
    extra.push(() => fs.rmSync(target, { force: true }));
    expect(await deleteAllImportedData({ writer: t.writer })).toEqual({ status: "not_deleted", code: "WRITE_LOCK_FAILED", writerSettingsRestored: true });
    expect(await finishStorageCleanup({ writer: t.writer })).toEqual({ status: "not_run", code: "WRITE_LOCK_FAILED", writerSettingsRestored: true });
    expect(fs.readFileSync(target, "utf8")).toBe("synthetic");
    expect((await getImportedDataCounts(t.db)).conversations).toBe(46);
  });
});
