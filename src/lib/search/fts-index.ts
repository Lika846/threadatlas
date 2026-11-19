import type { DbClient } from "../db/client";

/**
 * The full-text search index (M2.1; A85–A92; design in `docs/import-format.md`,
 * *Search index*).
 *
 * Two external-content FTS5 tables, created by the migration
 * `20261107190000_search_index`: `message_fts` over `Message.contentText` and
 * `conversation_fts` over `Conversation.title`. They store terms and positions
 * only and read text from those tables by rowid. Triggers keep them in sync in
 * the same transaction as every row change, including cascaded deletes, so
 * nothing in this module is needed for correctness during imports.
 *
 * This module holds the maintenance operations, each run by the writer under
 * the write lock (A57):
 * - `clearSearchIndex`: delete-all, after the rows are deleted;
 * - `optimizeSearchIndex`: after an import that replaced conversations;
 * - `vacuumDatabase`: the only sanctioned VACUUM, for empty tables only (A90);
 * - `checkSearchIndex` / `searchIndexIsEmpty`: verification.
 *
 * Errors propagate to the caller, which maps them to codes (A50). Nothing is
 * logged.
 */

export const SEARCH_INDEX_TABLES = ["message_fts", "conversation_fts"] as const;

/** FTS5 creates these shadow tables for each index (`detail=full`, external content). */
export const SEARCH_INDEX_SHADOW_SUFFIXES = ["config", "data", "docsize", "idx"] as const;

/** Every table the search index adds to the database (2 virtual + 8 shadow). */
export const SEARCH_INDEX_ALL_TABLES: readonly string[] = SEARCH_INDEX_TABLES.flatMap((t) => [
  t,
  ...SEARCH_INDEX_SHADOW_SUFFIXES.map((s) => `${t}_${s}`),
]);

/** The triggers that keep the index in sync (created by the same migration). */
export const SEARCH_INDEX_TRIGGERS = [
  "conversation_fts_after_delete",
  "conversation_fts_after_insert",
  "conversation_fts_after_update",
  "message_fts_after_delete",
  "message_fts_after_insert",
  "message_fts_after_update",
] as const;

/** FTS5's own records in `<table>_data` that an empty index keeps: averages (1) and structure (10). */
const EMPTY_INDEX_DATA_IDS = "(1, 10)";

type Executor = Pick<DbClient, "$executeRawUnsafe">;
type Querier = Pick<DbClient, "$queryRawUnsafe">;

/**
 * Thrown by `vacuumDatabase` when `Message` or `Conversation` has rows. Carries
 * no content; nothing was changed.
 */
export class NonEmptyVacuumError extends Error {
  constructor() {
    super("compaction refused: the database holds conversations");
    this.name = "NonEmptyVacuumError";
  }
}

/**
 * Empties both indexes completely: terms, positions and document sizes. For
 * delete-all, run it in the same transaction AFTER the rows are deleted (the
 * delete triggers need the index to still contain those rows). Never deletes
 * rows of any other table.
 */
export async function clearSearchIndex(db: Executor): Promise<void> {
  for (const t of SEARCH_INDEX_TABLES) await db.$executeRawUnsafe(`INSERT INTO "${t}"("${t}") VALUES ('delete-all')`);
}

/**
 * Merges each index into a single segment. This drops the entries of deleted
 * or replaced rows from the index's own data, so the index shrinks and stops
 * holding replaced terms (measured in M2.0: about 0.3 s for 52,000 messages).
 * Each statement is atomic; a failure leaves a correct, unmerged index.
 */
export async function optimizeSearchIndex(db: Executor): Promise<void> {
  for (const t of SEARCH_INDEX_TABLES) await db.$executeRawUnsafe(`INSERT INTO "${t}"("${t}") VALUES ('optimize')`);
}

/** Rebuilds both indexes from the current rows (about 0.7 s per 52,000 messages). */
export async function rebuildSearchIndex(db: Executor): Promise<void> {
  for (const t of SEARCH_INDEX_TABLES) await db.$executeRawUnsafe(`INSERT INTO "${t}"("${t}") VALUES ('rebuild')`);
}

/**
 * FTS5's integrity check, including the comparison with the content tables
 * (rank 1): every indexed entry matches the current row text and nothing is
 * missing. True when both indexes pass; false if either reports a problem.
 */
export async function checkSearchIndex(db: Executor): Promise<boolean> {
  try {
    for (const t of SEARCH_INDEX_TABLES) await db.$executeRawUnsafe(`INSERT INTO "${t}"("${t}", rank) VALUES ('integrity-check', 1)`);
    return true;
  } catch {
    return false;
  }
}

/**
 * True only if both indexes hold nothing: no document sizes, no segment index
 * entries, and no data records other than FTS5's own averages and structure
 * records. Throws if the index tables are missing (the caller maps the error).
 */
export async function searchIndexIsEmpty(db: Querier): Promise<boolean> {
  const parts = SEARCH_INDEX_TABLES.flatMap((t) => [
    `(SELECT COUNT(*) FROM "${t}_docsize")`,
    `(SELECT COUNT(*) FROM "${t}_idx")`,
    `(SELECT COUNT(*) FROM "${t}_data" WHERE id NOT IN ${EMPTY_INDEX_DATA_IDS})`,
  ]);
  const rows = (await db.$queryRawUnsafe(`SELECT ${parts.join(" + ")} AS n`)) as { n: number | bigint }[];
  return Number(rows[0]?.n) === 0;
}

/**
 * The only sanctioned VACUUM (A90; `tests/vacuum-guard.test.ts` rejects any
 * other), and only while `Message` and `Conversation` are both empty, as in
 * delete-all's cleanup. With rows present it refuses (`NonEmptyVacuumError`)
 * and changes nothing.
 *
 * Why (reviewed 2026-11-08): SQLite documents that VACUUM may change the
 * rowids of tables without an INTEGER PRIMARY KEY, and the index refers to
 * rows by rowid. VACUUM cannot run inside a transaction, so a rebuild can only
 * follow it as a separate step. Between the two, any other connection (a page
 * render, a search, another process) could read an index that points at the
 * wrong rows, and a crash in that gap would leave it stale until the next
 * rebuild. With both tables empty the index is empty too, so there is no gap.
 * Compacting a database that holds conversations is offline maintenance only:
 * app stopped, backup taken, then VACUUM, rebuild and integrity check (see
 * `docs/import-format.md`, *Search index*). No such tool exists yet.
 *
 * Call under the write lock, outside any transaction. The emptiness check and
 * the VACUUM are separate statements; the write lock keeps ThreadAtlas writers
 * out between them, and delete-all's cleanup verifies emptiness again after.
 */
export async function vacuumDatabase(db: Pick<DbClient, "$executeRawUnsafe" | "$queryRawUnsafe">): Promise<void> {
  const rows = (await db.$queryRawUnsafe(
    `SELECT EXISTS(SELECT 1 FROM "Message") OR EXISTS(SELECT 1 FROM "Conversation") AS hasRows`,
  )) as { hasRows: number | bigint }[];
  if (Number(rows[0]?.hasRows) !== 0) throw new NonEmptyVacuumError();
  await db.$executeRawUnsafe("VACUUM");
}
