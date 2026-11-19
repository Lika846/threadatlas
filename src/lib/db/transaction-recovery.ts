import type { DbClient } from "./client";

/**
 * Recovery after a failed interactive transaction on the writer (M1.7).
 *
 * Measured in M1.7: when COMMIT fails with SQLITE_BUSY (another connection
 * holds a read transaction), Prisma rejects the transaction, but SQLite keeps
 * it open on the connection, with its locks. Later queries on the writer then
 * run inside it (they see the uncommitted changes and are never committed),
 * and other connections stay blocked. An explicit ROLLBACK ends it.
 *
 * Single statements outside a transaction (the batch-row updates) are not
 * affected: SQLite rolls back an autocommit statement whose commit fails
 * (regression-tested in `import-recovery.int.test.ts`).
 *
 * If the transaction cannot be shown to be closed, the writer is marked
 * unusable for the rest of the process: imports, delete-all and cleanup then
 * refuse with `DB_WRITER_UNUSABLE` instead of writing through it. A restart
 * closes the connection, which rolls the transaction back. The connection is
 * not closed here: the writer is never disconnected while the process runs
 * (A55).
 */

const unusable = new WeakSet<DbClient>();

export function isWriterUnusable(db: DbClient): boolean {
  return unusable.has(db);
}

/** Test-only: a writer client is never marked usable again in production. */
export function markWriterUnusableForTest(db: DbClient): void {
  unusable.add(db);
}

/**
 * Ends any transaction left open on the connection and proves it: a
 * deferred BEGIN (takes no lock) succeeds only outside a transaction, and is
 * rolled back at once. Never throws; error objects are not inspected.
 */
export async function ensureNoOpenTransaction(db: DbClient): Promise<"clean" | "stuck"> {
  try {
    await db.$executeRawUnsafe("ROLLBACK");
  } catch {
    // Usually "no transaction is active": Prisma already rolled back.
  }
  try {
    await db.$executeRawUnsafe("BEGIN DEFERRED");
  } catch {
    return "stuck"; // a transaction is still open
  }
  try {
    await db.$executeRawUnsafe("ROLLBACK");
    return "clean";
  } catch {
    return "stuck";
  }
}

type TxClient = Parameters<Parameters<DbClient["$transaction"]>[0]>[0];

/**
 * `db.$transaction(fn, options)` for the writer. On any failure it makes sure
 * no transaction stays open (marking the writer unusable if that cannot be
 * shown), then rethrows the original error unchanged, so callers report the
 * real cause.
 */
export async function runWriterTransaction<T>(
  db: DbClient,
  fn: (tx: TxClient) => Promise<T>,
  options?: { maxWait?: number; timeout?: number },
): Promise<T> {
  try {
    return await db.$transaction(fn, options);
  } catch (e) {
    if ((await ensureNoOpenTransaction(db)) === "stuck") unusable.add(db);
    throw e;
  }
}
