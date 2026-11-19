import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Database location and test isolation (A41). Shared by `prisma.config.ts`
 * (Prisma CLI) and the runtime client, so both always agree on one absolute
 * path. Prisma does not document how relative SQLite `file:` URLs resolve, so
 * only absolute paths are accepted.
 *
 * - Default: `<project root>/data/threadatlas.db` (`data/` is git-ignored).
 * - `DATABASE_URL`, if set, must be `file:` followed by an absolute path.
 * - Under a test runner the database must be inside the system temp
 *   directory and must not be the real database. Anything that cannot be
 *   verified fails closed (throws).
 *
 * No function here creates, opens or modifies a database.
 */

export const DEFAULT_DATABASE_FILE = path.join("data", "threadatlas.db");

export class DatabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseConfigError";
  }
}

export class DatabaseIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseIsolationError";
  }
}

type Env = Record<string, string | undefined>;

/** Absolute path of the real database for a project root. */
export function realDatabasePath(root: string): string {
  return path.resolve(root, DEFAULT_DATABASE_FILE);
}

/**
 * Parses a `file:` URL into an absolute path. Rejects relative paths, other
 * schemes, and `?`, `#` or control characters, which the adapter would take
 * literally but other tools may treat as URL syntax.
 */
export function databasePathFromUrl(url: string): string {
  if (!url.startsWith("file:")) {
    throw new DatabaseConfigError("DATABASE_URL must start with file: (SQLite).");
  }
  const p = url.slice("file:".length);
  if (/[?#\u0000-\u001f]/.test(p)) {
    throw new DatabaseConfigError("DATABASE_URL must be a plain file path without ?, # or control characters.");
  }
  if (!path.isAbsolute(p)) {
    throw new DatabaseConfigError("DATABASE_URL must use an absolute path, e.g. file:/absolute/path/threadatlas.db.");
  }
  return path.normalize(p);
}

/** The database file to use: `DATABASE_URL` if set, otherwise the real database. */
export function resolveDatabasePath(opts: { env: Env; root: string }): string {
  const url = opts.env.DATABASE_URL?.trim();
  if (url === undefined || url === "") return realDatabasePath(opts.root);
  return databasePathFromUrl(url);
}

/** `file:` URL for an absolute path. */
export function toDatabaseUrl(absolutePath: string): string {
  if (!path.isAbsolute(absolutePath)) {
    throw new DatabaseConfigError("Database path must be absolute.");
  }
  return `file:${absolutePath}`;
}

/** True under any test runner: ThreadAtlas test flag, Vitest, or NODE_ENV=test. */
export function isTestContext(env: Env): boolean {
  return env.THREADATLAS_TEST === "1" || env.VITEST !== undefined || env.NODE_ENV === "test";
}

/**
 * Fails closed in tests: the database must resolve (through directory symlinks) to a
 * file strictly inside the system temp directory, and must not be the real database.
 * Throws if any of this cannot be established. Outside tests it does nothing.
 *
 * The real database is never touched: no stat, open or realpath of it, its sidecar
 * files, its lock, `data/backups/` or the backup manifest (M5.1b-1 final verification).
 * - The real path is compared as a string first, before any filesystem call. The
 *   comparison ignores case and Unicode normalisation, as macOS file systems do, so a
 *   case variant (`DATA/`, `ThreadAtlas.db`, another spelling of the project folder) is
 *   refused too. It also refuses anything inside the real `data/` directory (sidecars,
 *   lock, backups, manifest, models). It may refuse a harmless path; it never lets a
 *   protected one through on spelling.
 * - Only the candidate is inspected. A candidate that is a symlink, or a file with more
 *   than one hard link, is refused without being followed or compared, so a link to the
 *   real database can never pass.
 * - For a project root inside the temp directory (the guard's own tests), the real path
 *   is also compared after resolving its *directory* (`data/`), never the file itself.
 */
export function assertDatabaseIsolation(opts: { env: Env; root: string; dbPath: string }): void {
  if (!isTestContext(opts.env)) return;
  const realPath = realDatabasePath(opts.root);
  refuseProtected(opts.dbPath, realPath);
  let tmp: string;
  let entry: fs.Stats | undefined;
  try {
    tmp = fs.realpathSync(os.tmpdir());
    entry = fs.lstatSync(opts.dbPath, { throwIfNoEntry: false });
  } catch {
    throw new DatabaseIsolationError("Cannot verify that the test database is isolated; refusing to continue.");
  }
  if (entry?.isSymbolicLink()) throw new DatabaseIsolationError("Test databases must not be symbolic links.");
  if (entry && entry.nlink > 1) throw new DatabaseIsolationError("Test databases must not be hard links.");
  let candidate: string;
  try {
    candidate = realpathOfFile(opts.dbPath);
  } catch {
    throw new DatabaseIsolationError("Cannot verify that the test database is isolated; refusing to continue.");
  }
  const rel = path.relative(tmp, candidate);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new DatabaseIsolationError("Test databases must be inside the system temp directory.");
  }
  let realResolved: string;
  try {
    realResolved = path.join(realpathOfFile(path.dirname(realPath)), path.basename(realPath));
  } catch {
    throw new DatabaseIsolationError("Cannot verify that the test database is isolated; refusing to continue.");
  }
  refuseProtected(candidate, realResolved);
}

/**
 * Comparison keys that ignore case and Unicode normalisation (APFS and HFS+ defaults).
 * Both a lower- and an upper-case key are compared, so characters whose case mappings
 * differ (`ſ`, `K`, `ß`) still match their ASCII spellings: this errs towards refusing.
 */
function foldKeys(p: string): readonly [string, string] {
  const n = path.resolve(p).normalize("NFC");
  return [n.toLowerCase(), n.toUpperCase()];
}

function refuseProtected(candidate: string, realPath: string): void {
  const c = foldKeys(candidate);
  const db = foldKeys(realPath);
  const dir = foldKeys(path.dirname(realPath));
  if (c[0] === db[0] || c[1] === db[1]) throw new DatabaseIsolationError("Tests must never use the real database.");
  if ([0, 1].some((i) => c[i] === dir[i] || c[i]!.startsWith(dir[i] + path.sep))) {
    throw new DatabaseIsolationError("Tests must never use the real data directory.");
  }
}

/** realpath of a path that may not exist yet: resolves its deepest existing ancestor. */
function realpathOfFile(p: string): string {
  const abs = path.resolve(p);
  if (fs.existsSync(abs)) return fs.realpathSync(abs);
  const rest: string[] = [];
  let dir = abs;
  while (!fs.existsSync(dir)) {
    rest.unshift(path.basename(dir));
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("no existing ancestor");
    dir = parent;
  }
  return path.join(fs.realpathSync(dir), ...rest);
}
