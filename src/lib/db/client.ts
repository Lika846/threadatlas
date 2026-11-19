import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@/generated/prisma/client";
import { assertDatabaseIsolation, resolveDatabasePath, toDatabaseUrl } from "./path";

/**
 * Prisma Clients for server code. Nothing here runs at import time.
 *
 * - The path comes from `path.ts`, the same resolver the CLI config uses.
 * - Under a test runner, `assertDatabaseIsolation` refuses anything but an
 *   isolated temporary database (fails closed).
 * - `fileMustExist`: the app never creates a database; `npm run db:deploy`
 *   does, so an un-migrated empty file can't appear by accident.
 * - `rawContentJson` is omitted from every query by default (A37). A query
 *   that needs it must opt in with `omit: { rawContentJson: false }`.
 * - No query logging (`log: []`). Prisma error messages can quote query
 *   arguments, so callers map every error to a code with `sanitizeDbError`
 *   (`errors.ts`) and never log or return the error itself (A50).
 *
 * Two connections (M1.4, F4): the adapter gives each client exactly one
 * SQLite connection, and queries outside a transaction run on that same
 * connection, inside any transaction that is open on it. Pages therefore use
 * `getDb()`, and imports (and later delete-all) use the separate writer from
 * `getWriterDb()`, so readers only ever see committed data.
 */

/** better-sqlite3 busy timeout: how long a statement waits for a lock. Synchronous: it blocks the event loop. */
export const BUSY_TIMEOUT_MS = 5_000;

export const CLIENT_OPTIONS = {
  omit: { message: { rawContentJson: true } },
  errorFormat: "minimal",
} as const;

export type ClientFactoryOptions = { env?: Record<string, string | undefined>; root?: string };

export function createPrismaClient(opts: ClientFactoryOptions = {}) {
  return openClient(opts).db;
}

function openClient(opts: ClientFactoryOptions) {
  const env = opts.env ?? process.env;
  const root = opts.root ?? process.cwd();
  const dbPath = resolveDatabasePath({ env, root });
  assertDatabaseIsolation({ env, root, dbPath });
  const adapter = new PrismaBetterSqlite3({
    url: toDatabaseUrl(dbPath),
    fileMustExist: true,
    timeout: BUSY_TIMEOUT_MS,
  });
  return { db: new PrismaClient({ adapter, ...CLIENT_OPTIONS, log: [] }), dbPath };
}

export type DbClient = ReturnType<typeof createPrismaClient>;

/** The writer connection and the database file it opened (the lock file is derived from it). */
export type WriterDb = { db: DbClient; dbPath: string };

/**
 * Per-connection settings for the writer. Idempotent; run before each import.
 *
 * `cache_spill = OFF`: by default SQLite writes dirty pages to the database
 * file once a transaction outgrows the page cache, which takes an EXCLUSIVE
 * lock until commit and makes readers fail with SQLITE_BUSY. Off, pages stay
 * in memory until commit, so readers keep reading the last committed state
 * (measured in M1.4 step 0). Cost: one transaction's pages are held in memory.
 *
 * `secure_delete = OFF`, `temp_store = DEFAULT` (M1.7): delete-all switches
 * both on for its own run (`src/lib/data/delete-all.ts`) and restores them
 * with this function. Setting them explicitly here also means an import
 * never inherits them if a restore failed (import-time secure_delete is
 * deferred, A79).
 */
export async function configureWriterConnection(db: DbClient): Promise<void> {
  await db.$executeRawUnsafe("PRAGMA cache_spill = OFF");
  await db.$executeRawUnsafe("PRAGMA secure_delete = OFF");
  await db.$executeRawUnsafe("PRAGMA temp_store = DEFAULT");
}

/** A new writer client. Tests inject one; the app uses `getWriterDb()`. */
export function createWriterClient(opts: ClientFactoryOptions = {}): WriterDb {
  return openClient(opts);
}

const globalForDb = globalThis as unknown as { threadatlasDb?: DbClient; threadatlasWriter?: WriterDb };

/** Process-wide reader client, created on first use and reused across dev hot reloads. */
export function getDb(): DbClient {
  globalForDb.threadatlasDb ??= createPrismaClient();
  return globalForDb.threadatlasDb;
}

/**
 * Process-wide writer client. Used only while holding the write lock
 * (`write-lock.ts`). Never disconnected while the process runs: closing it
 * during an open transaction rolls the data back but leaves the transaction's
 * promise pending forever (M1.4 step 0).
 */
export function getWriterDb(): WriterDb {
  globalForDb.threadatlasWriter ??= createWriterClient();
  return globalForDb.threadatlasWriter;
}
