import { Prisma } from "@/generated/prisma/client";
import { DatabaseConfigError, DatabaseIsolationError } from "./path";

/**
 * Central database-error sanitiser (A50, D56).
 *
 * Every exception from Prisma, the SQLite adapter or the persistence code is
 * mapped here to one fixed code, and the original error object is dropped.
 *
 * Only structured, content-free fields are read: the error class, the Prisma
 * `code` (e.g. "P2002"), and the adapter's `kind` and `originalCode`
 * (e.g. "SQLITE_BUSY"). `.message`, `.stack`, `meta.*.originalMessage`,
 * `meta.*.message` and query arguments are never read: they can quote stored
 * or imported content (Prisma validation errors quote query arguments; the
 * adapter copies SQLite's raw message into `originalMessage`). Measured in
 * M1.4 step 0.
 */

export const DB_ERROR_DEFINITIONS = {
  DB_NOT_INITIALIZED: { systemic: true, message: "The database file does not exist. Run `npm run db:deploy` first." },
  DB_NOT_MIGRATED: { systemic: true, message: "The database is missing tables or columns. Run `npm run db:deploy`." },
  DB_BUSY: { systemic: true, message: "The database is locked by another program. Try again later." },
  DB_TIMEOUT: { systemic: false, message: "A database operation took too long and was cancelled." },
  DB_CONSTRAINT: { systemic: false, message: "A database constraint rejected a write." },
  DB_CONFLICT: { systemic: false, message: "The stored data changed during the write, so the write was cancelled." },
  DB_DISK_FULL: { systemic: true, message: "The disk is full." },
  DB_READ_ONLY: { systemic: true, message: "The database cannot be written to (read-only)." },
  DB_CORRUPT: { systemic: true, message: "The database file is damaged or is not a ThreadAtlas database." },
  DB_CONFIG: { systemic: true, message: "The database is not configured correctly." },
  DB_INVALID_QUERY: { systemic: false, message: "A database query was invalid." },
  DB_WRITER_UNUSABLE: {
    systemic: true,
    message: "A database transaction could not be closed cleanly, so ThreadAtlas stopped writing. Restart ThreadAtlas to continue.",
  },
  DB_UNKNOWN: { systemic: false, message: "An unexpected database error occurred." },
  IMPORT_INTERNAL_ERROR: { systemic: false, message: "An unexpected internal error occurred." },
} as const satisfies Record<string, { systemic: boolean; message: string }>;

export type DbErrorCode = keyof typeof DB_ERROR_DEFINITIONS;

/**
 * Systemic errors stop an import: continuing would fail the same way for
 * every remaining conversation (missing file or tables, disk full,
 * read-only, corrupt, misconfigured, or locked by a foreign program).
 */
export function isSystemicDbError(code: DbErrorCode): boolean {
  return DB_ERROR_DEFINITIONS[code].systemic;
}

export function dbErrorMessage(code: DbErrorCode): string {
  return DB_ERROR_DEFINITIONS[code].message;
}

/**
 * Thrown by the persistence code when a guarded update affected no row
 * (the stored conversation changed after it was read). Carries no data.
 */
export class ConcurrentChangeError extends Error {
  constructor() {
    super("Stored conversation changed during the write.");
    this.name = "ConcurrentChangeError";
  }
}

/** Reads one string property without invoking getters on unexpected types. */
function stringProp(obj: unknown, key: string): string | undefined {
  if (obj === null || typeof obj !== "object") return undefined;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

function objectProp(obj: unknown, key: string): unknown {
  if (obj === null || typeof obj !== "object") return undefined;
  return (obj as Record<string, unknown>)[key];
}

/** SQLite primary result code (e.g. "SQLITE_CONSTRAINT_UNIQUE" → "SQLITE_CONSTRAINT"). */
function sqlitePrimary(code: string | undefined): string | undefined {
  if (code === undefined) return undefined;
  const m = /^SQLITE_[A-Z]+/.exec(code);
  return m ? m[0] : undefined;
}

function fromSqliteCode(code: string | undefined): DbErrorCode | undefined {
  switch (sqlitePrimary(code)) {
    case "SQLITE_BUSY":
    case "SQLITE_LOCKED":
      return "DB_BUSY";
    case "SQLITE_FULL":
      return "DB_DISK_FULL";
    case "SQLITE_READONLY":
    case "SQLITE_PERM":
      return "DB_READ_ONLY";
    case "SQLITE_CORRUPT":
    case "SQLITE_NOTADB":
      return "DB_CORRUPT";
    case "SQLITE_CANTOPEN":
      return "DB_NOT_INITIALIZED";
    case "SQLITE_CONSTRAINT":
      return "DB_CONSTRAINT";
    default:
      return undefined;
  }
}

function fromAdapterKind(kind: string | undefined): DbErrorCode | undefined {
  switch (kind) {
    case "UniqueConstraintViolation":
    case "ForeignKeyConstraintViolation":
    case "NullConstraintViolation":
      return "DB_CONSTRAINT";
    case "TableDoesNotExist":
    case "ColumnNotFound":
      return "DB_NOT_MIGRATED";
    case "SocketTimeout":
      return "DB_BUSY";
    case "TransactionWriteConflict":
      return "DB_CONFLICT";
    default:
      return undefined;
  }
}

function fromPrismaCode(code: string | undefined): DbErrorCode | undefined {
  switch (code) {
    case "P2002":
    case "P2003":
    case "P2004":
    case "P2011":
    case "P2014":
      return "DB_CONSTRAINT";
    case "P2021":
    case "P2022":
      return "DB_NOT_MIGRATED";
    case "P2024":
    case "P2028":
      return "DB_TIMEOUT";
    case "P2034":
      return "DB_CONFLICT";
    case "P1008":
      return "DB_BUSY";
    case "P1003":
      return "DB_NOT_INITIALIZED";
    default:
      return undefined;
  }
}

/**
 * Maps any thrown value to a fixed code. Never throws, never logs, and never
 * reads messages, stacks or query arguments.
 */
export function sanitizeDbError(error: unknown): DbErrorCode {
  try {
    if (error instanceof ConcurrentChangeError) return "DB_CONFLICT";
    if (error instanceof DatabaseConfigError || error instanceof DatabaseIsolationError) return "DB_CONFIG";
    if (error instanceof Prisma.PrismaClientValidationError) return "DB_INVALID_QUERY";
    if (error instanceof Prisma.PrismaClientInitializationError) return "DB_CONFIG";
    if (error instanceof Prisma.PrismaClientRustPanicError) return "DB_UNKNOWN";
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      const code = stringProp(error, "code");
      const cause = objectProp(objectProp(objectProp(error, "meta"), "driverAdapterError"), "cause");
      const kind = stringProp(cause, "kind");
      const originalCode = stringProp(cause, "originalCode");
      // Most specific first: the adapter's SQLite code, then its error kind,
      // then the Prisma code. (P2039 and P2010 wrap many SQLite conditions.)
      return (
        fromSqliteCode(originalCode) ??
        fromAdapterKind(kind) ??
        fromSqliteCode(code) ?? // the missing-file error uses "SQLITE_CANTOPEN" as its code
        fromPrismaCode(code) ??
        "DB_UNKNOWN"
      );
    }
    if (error instanceof Prisma.PrismaClientUnknownRequestError) return "DB_UNKNOWN";
    // The adapter's own error, unwrapped: a failed interactive-transaction
    // COMMIT reaches the caller this way (measured in M1.7: SQLITE_BUSY at
    // commit while another connection holds a read transaction). Only the
    // structured `cause.originalCode` and `cause.kind` are read, never
    // `cause.originalMessage`.
    if (error instanceof Error && error.name === "DriverAdapterError") {
      const cause = objectProp(error, "cause");
      return fromSqliteCode(stringProp(cause, "originalCode")) ?? fromAdapterKind(stringProp(cause, "kind")) ?? "DB_UNKNOWN";
    }
    // A raw better-sqlite3 SqliteError (e.g. from the lock connection).
    if (error instanceof Error && error.name === "SqliteError") {
      return fromSqliteCode(stringProp(error, "code")) ?? "DB_UNKNOWN";
    }
    return "IMPORT_INTERNAL_ERROR";
  } catch {
    return "IMPORT_INTERNAL_ERROR";
  }
}
