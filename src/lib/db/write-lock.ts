import fs from "node:fs";
import Database, { type SqliteDatabase } from "better-sqlite3";

/**
 * Cross-process write lock (M1.4, refinement B and safeguard A).
 *
 * Imports (and delete-all in M1.7) must not run concurrently, even from
 * different processes (e.g. `next dev` and `next start` on one database).
 * The lock is an exclusive SQLite transaction on a separate, empty SQLite
 * file next to the database (`<database>.lock`), held by a dedicated
 * better-sqlite3 connection:
 *
 * - Atomic: `BEGIN EXCLUSIVE` with a busy timeout of 0 either takes the lock
 *   or fails at once; it never blocks the event loop. Contention → retried a
 *   few times after short random delays (about 150 ms in total; imports and
 *   delete-all keep retrying for `IMPORT_LOCK_WAIT_MS`), then
 *   `IMPORT_BUSY`; any other problem → `IMPORT_LOCK_FAILED`. Both fail
 *   closed: nothing is imported. The retries matter: two processes trying at
 *   the same instant each hold SQLite's transient SHARED lock while
 *   upgrading, so without a retry both can be refused (measured in M1.4).
 * - Released by the operating system when the holding process dies, even on
 *   SIGKILL (measured: about 4 ms), so a crash never leaves a stale lock.
 * - Also exclusive between two connections in the same process.
 * - The file is never unlinked or replaced: deleting it while it is held
 *   would let a second process lock a new file at the same path. Release
 *   only rolls back and closes the connection.
 * - Mode 0600, inside the database's 0700 directory. Symlinks and
 *   non-regular files are refused (checked by path just before SQLite opens
 *   it). The file is never opened with a raw descriptor once it exists:
 *   closing one would release this process's lock (see `prepareLockFile`).
 * - No writes are made to the lock file, so it stays empty. While the lock is
 *   held, SQLite keeps an empty `<database>.lock-journal` next to it and removes
 *   it on release (measured in M1.7; it holds no data).
 *
 * Limitation: SQLite's file locking is reliable only on local filesystems,
 * not on network drives (NFS/SMB). ThreadAtlas keeps its database locally.
 * No new dependency: better-sqlite3 is already used by the Prisma adapter.
 */

export const LOCK_FILE_SUFFIX = ".lock";

export function lockPathFor(dbPath: string): string {
  return `${dbPath}${LOCK_FILE_SUFFIX}`;
}

/**
 * The indexer lock (M5.1b, design §6): the same mechanism on `<database>.index-lock`.
 * Held by the indexing session from Start until it ends, so at most one indexer runs
 * per database across processes. Lock order: indexer lock, then write lock; import and
 * delete-all never take it.
 */
export const INDEX_LOCK_FILE_SUFFIX = ".index-lock";

export function indexLockPathFor(dbPath: string): string {
  return `${dbPath}${INDEX_LOCK_FILE_SUFFIX}`;
}

export type WriteLock = {
  /** Idempotent. Never deletes the lock file. */
  release(): void;
};

export type LockResult = { ok: true; lock: WriteLock } | { ok: false; code: "IMPORT_BUSY" | "IMPORT_LOCK_FAILED" };

export type IndexerLockResult = { ok: true; lock: WriteLock } | { ok: false; code: "INDEXER_BUSY" | "INDEXER_LOCK_FAILED" };

type FileLockResult = { ok: true; lock: WriteLock } | { ok: false; busy: boolean };

function isBusy(e: unknown): boolean {
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof code === "string" && (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"));
}

/**
 * Creates the lock file if needed (0600) and checks that it is a regular file
 * owned by this user, not a symlink. Throws otherwise.
 *
 * Never opens an existing lock file with a raw descriptor: under POSIX
 * record locking, closing *any* descriptor of a file releases every lock this
 * process holds on it, so an in-process contender would silently drop the
 * holder's lock (found in M1.4 verification). SQLite guards only the
 * descriptors it opened itself. Existing files are therefore checked and
 * fixed by path only (`lstat`, `chmod`); a descriptor is opened only with
 * O_EXCL to create a new file, which cannot carry a lock yet.
 */
function prepareLockFile(lockPath: string): void {
  try {
    const fd = fs.openSync(lockPath, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.closeSync(fd);
  } catch (e) {
    if ((e as { code?: unknown }).code !== "EEXIST") throw e;
  }
  const st = fs.lstatSync(lockPath);
  if (!st.isFile()) throw new Error("lock path is not a regular file");
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new Error("lock file is owned by another user");
  }
  if ((st.mode & 0o077) !== 0) fs.chmodSync(lockPath, 0o600);
}

export const LOCK_ATTEMPTS = 6;
const RETRY_MIN_MS = 10;
const RETRY_JITTER_MS = 30;

/**
 * How long an import or delete-all keeps retrying a busy write lock before `IMPORT_BUSY`
 * (M5.1b-1): at least this long and at least `LOCK_ATTEMPTS` attempts, so at most about
 * this long plus one retry delay. It covers the longest write the indexer makes (T2 at
 * the 20,000-chunk cap: about 155–210 ms measured, 500 ms budget) with margin, so an
 * import that starts during it waits instead of failing. A lock that stays busy (another
 * import) is still refused after about 1 s. The indexer keeps the short default: it has
 * its own wait loop and yields to imports.
 */
export const IMPORT_LOCK_WAIT_MS = 1_000;

/**
 * Takes the lock, retrying (asynchronously) while another holder or a simultaneous
 * contender has it: `attempts` times, and for at least `waitMs` if given.
 */
export async function acquireWriteLock(dbPath: string, opts: { attempts?: number; waitMs?: number } = {}): Promise<LockResult> {
  return asWriteLock(await acquireFileLock(lockPathFor(dbPath), opts.attempts ?? LOCK_ATTEMPTS, opts.waitMs ?? 0));
}

/** One attempt; never waits. */
export function tryAcquireWriteLock(dbPath: string): LockResult {
  return asWriteLock(tryAcquireFileLock(lockPathFor(dbPath)));
}

/**
 * Attempts for the indexer lock: more than the write lock's, about 0.5 s in total, so a
 * liveness probe from another process (which holds the lock for a moment) never makes a
 * Start fail. Measured in M5.1b-1: with 6 attempts, probes every 1–3 ms from another
 * process made 1 Start fail; a Start is a user action, so waiting longer costs nothing.
 */
export const INDEXER_LOCK_ATTEMPTS = 20;

/** The indexer lock, retried briefly (see `INDEXER_LOCK_ATTEMPTS`). */
export async function acquireIndexerLock(dbPath: string, opts: { attempts?: number } = {}): Promise<IndexerLockResult> {
  const r = await acquireFileLock(indexLockPathFor(dbPath), opts.attempts ?? INDEXER_LOCK_ATTEMPTS);
  return r.ok ? r : { ok: false, code: r.busy ? "INDEXER_BUSY" : "INDEXER_LOCK_FAILED" };
}

/**
 * Liveness probe of the indexer lock (design §5.8): one attempt, released at once.
 * Never creates the lock file: a missing file means nobody holds the lock. "unknown"
 * when the lock could not be checked safely.
 */
export function probeIndexerLock(dbPath: string): "held" | "free" | "unknown" {
  const lockPath = indexLockPathFor(dbPath);
  try {
    fs.lstatSync(lockPath);
  } catch (e) {
    return (e as { code?: unknown }).code === "ENOENT" ? "free" : "unknown";
  }
  const r = tryAcquireFileLock(lockPath);
  if (!r.ok) return r.busy ? "held" : "unknown";
  r.lock.release();
  return "free";
}

function asWriteLock(r: FileLockResult): LockResult {
  return r.ok ? r : { ok: false, code: r.busy ? "IMPORT_BUSY" : "IMPORT_LOCK_FAILED" };
}

async function acquireFileLock(lockPath: string, attempts: number, waitMs = 0): Promise<FileLockResult> {
  const t0 = performance.now();
  for (let i = 1; ; i++) {
    const r = tryAcquireFileLock(lockPath);
    if (r.ok || !r.busy) return r;
    if (i >= attempts && performance.now() - t0 >= waitMs) return r;
    await new Promise((res) => setTimeout(res, RETRY_MIN_MS + Math.random() * RETRY_JITTER_MS));
  }
}

function tryAcquireFileLock(lockPath: string): FileLockResult {
  let conn: SqliteDatabase | undefined;
  try {
    prepareLockFile(lockPath);
    conn = new Database(lockPath, { timeout: 0, fileMustExist: true });
    conn.exec("BEGIN EXCLUSIVE");
  } catch (e) {
    try {
      conn?.close();
    } catch {
      // closing a connection that failed to lock cannot leave a lock behind
    }
    return { ok: false, busy: isBusy(e) };
  }
  const held = conn;
  let released = false;
  return {
    ok: true,
    lock: {
      release() {
        if (released) return;
        released = true;
        try {
          if (held.inTransaction) held.exec("ROLLBACK");
        } finally {
          // Closing the connection always releases the OS lock.
          held.close();
        }
      },
    },
  };
}
