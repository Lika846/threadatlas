import { describe, expect, it } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import {
  ConcurrentChangeError,
  DB_ERROR_DEFINITIONS,
  dbErrorMessage,
  isSystemicDbError,
  sanitizeDbError,
  type DbErrorCode,
} from "./errors";
import { DatabaseConfigError, DatabaseIsolationError } from "./path";

const CANARY = "synthetic-canary-7f3a";
const V = "7.10.1";

function known(code: string, cause?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError(`failed near ${CANARY}`, {
    code,
    clientVersion: V,
    meta: cause ? { modelName: "Message", driverAdapterError: { name: "DriverAdapterError", cause: { originalMessage: CANARY, ...cause } } } : { modelName: "Message" },
  });
}

/**
 * Wraps an error so that reading `message`, `stack`, `originalMessage`,
 * `cause.message` or calling `toString` is recorded. The sanitiser must never
 * touch any of them.
 */
function trap<E extends Error>(e: E): { e: E; touched: string[] } {
  const touched: string[] = [];
  const watch = (obj: object, key: string, label: string) => {
    Object.defineProperty(obj, key, {
      configurable: true,
      get() {
        touched.push(label);
        return CANARY;
      },
    });
  };
  watch(e, "message", "message");
  watch(e, "stack", "stack");
  Object.defineProperty(e, "toString", { configurable: true, value: () => (touched.push("toString"), CANARY) });
  const cause = (e as unknown as { meta?: { driverAdapterError?: { cause?: object } } }).meta?.driverAdapterError?.cause;
  if (cause) {
    watch(cause, "originalMessage", "originalMessage");
    watch(cause, "message", "cause.message");
  }
  return { e, touched };
}

describe("sanitizeDbError: measured Prisma 7.10.1 / adapter shapes (step 0)", () => {
  it.each<[string, () => Error, DbErrorCode]>([
    ["unique P2002", () => known("P2002", { kind: "UniqueConstraintViolation", originalCode: "SQLITE_CONSTRAINT_UNIQUE" }), "DB_CONSTRAINT"],
    ["foreign key P2003", () => known("P2003", { kind: "ForeignKeyConstraintViolation", originalCode: "SQLITE_CONSTRAINT_FOREIGNKEY" }), "DB_CONSTRAINT"],
    ["raw not-null P2010", () => known("P2010", { kind: "NullConstraintViolation", originalCode: "SQLITE_CONSTRAINT_NOTNULL" }), "DB_CONSTRAINT"],
    ["P2011 without adapter detail", () => known("P2011"), "DB_CONSTRAINT"],
    ["transaction timeout P2028", () => known("P2028"), "DB_TIMEOUT"],
    ["busy P1008", () => known("P1008", { kind: "SocketTimeout", originalCode: "SQLITE_BUSY" }), "DB_BUSY"],
    ["disk full P2039", () => known("P2039", { kind: "sqlite", originalCode: "SQLITE_FULL", extendedCode: 1, message: CANARY }), "DB_DISK_FULL"],
    ["read-only P2039", () => known("P2039", { kind: "sqlite", originalCode: "SQLITE_READONLY", extendedCode: 1, message: CANARY }), "DB_READ_ONLY"],
    ["not a database P2039", () => known("P2039", { kind: "sqlite", originalCode: "SQLITE_NOTADB", extendedCode: 1, message: CANARY }), "DB_CORRUPT"],
    ["corrupt P2039", () => known("P2039", { kind: "sqlite", originalCode: "SQLITE_CORRUPT", extendedCode: 1, message: CANARY }), "DB_CORRUPT"],
    ["missing table P2021", () => known("P2021", { kind: "TableDoesNotExist", originalCode: "SQLITE_ERROR", table: "Message" }), "DB_NOT_MIGRATED"],
    ["missing column P2022", () => known("P2022"), "DB_NOT_MIGRATED"],
    ["missing file (code SQLITE_CANTOPEN)", () => known("SQLITE_CANTOPEN"), "DB_NOT_INITIALIZED"],
    ["unknown Prisma code", () => known("P9999"), "DB_UNKNOWN"],
    ["generic sqlite kind without a known code", () => known("P2039", { kind: "sqlite", originalCode: "SQLITE_IOERR" }), "DB_UNKNOWN"],
    ["validation error", () => new Prisma.PrismaClientValidationError(`Argument contentText: ${CANARY}`, { clientVersion: V }), "DB_INVALID_QUERY"],
    ["initialization error", () => new Prisma.PrismaClientInitializationError(CANARY, V), "DB_CONFIG"],
    ["unknown request error", () => new Prisma.PrismaClientUnknownRequestError(CANARY, { clientVersion: V }), "DB_UNKNOWN"],
    ["rust panic", () => new Prisma.PrismaClientRustPanicError(CANARY, V), "DB_UNKNOWN"],
    ["database config error", () => new DatabaseConfigError(CANARY), "DB_CONFIG"],
    ["isolation error", () => new DatabaseIsolationError(CANARY), "DB_CONFIG"],
    ["guarded update conflict", () => new ConcurrentChangeError(), "DB_CONFLICT"],
    ["our own error", () => new Error(CANARY), "IMPORT_INTERNAL_ERROR"],
    ["TypeError", () => new TypeError(CANARY), "IMPORT_INTERNAL_ERROR"],
  ])("%s → code, without reading message, stack or originalMessage", (_label, make, expected) => {
    const { e, touched } = trap(make());
    expect(sanitizeDbError(e)).toBe(expected);
    expect(touched).toEqual([]);
  });

  it("maps a raw better-sqlite3 SqliteError by its code only", () => {
    const busy = Object.assign(new Error(CANARY), { name: "SqliteError", code: "SQLITE_BUSY" });
    const { e, touched } = trap(busy);
    expect(sanitizeDbError(e)).toBe("DB_BUSY");
    expect(sanitizeDbError(Object.assign(new Error(CANARY), { name: "SqliteError", code: "SQLITE_MISUSE" }))).toBe("DB_UNKNOWN");
    expect(touched).toEqual([]);
  });

  it("maps an unwrapped DriverAdapterError (failed COMMIT, measured in M1.7) by its structured cause only", () => {
    const adapterError = (cause: Record<string, unknown>) => Object.assign(new Error(CANARY), { name: "DriverAdapterError", cause });
    const cause: Record<string, unknown> = { originalCode: "SQLITE_BUSY", kind: "SocketTimeout" };
    const { e, touched } = trap(adapterError(cause));
    Object.defineProperty(cause, "originalMessage", { get: () => (touched.push("originalMessage"), CANARY) });
    expect(sanitizeDbError(e)).toBe("DB_BUSY");
    expect(touched).toEqual([]);
    expect(sanitizeDbError(adapterError({ kind: "SocketTimeout", originalMessage: CANARY }))).toBe("DB_BUSY");
    expect(sanitizeDbError(adapterError({ originalCode: "SQLITE_FULL" }))).toBe("DB_DISK_FULL");
    expect(sanitizeDbError(adapterError({ originalMessage: CANARY }))).toBe("DB_UNKNOWN");
    expect(sanitizeDbError(Object.assign(new Error(CANARY), { name: "DriverAdapterError" }))).toBe("DB_UNKNOWN");
  });

  it.each([undefined, null, 42, CANARY, { code: "P2002" }, Symbol("x")])("treats non-Error value %s as internal", (value) => {
    expect(sanitizeDbError(value)).toBe("IMPORT_INTERNAL_ERROR");
  });

  it("never throws, even if property access throws", () => {
    const hostile = known("P2002");
    Object.defineProperty(hostile, "meta", { get() { throw new Error(CANARY); } });
    expect(sanitizeDbError(hostile)).toBe("IMPORT_INTERNAL_ERROR");
  });

  it("has a static message for every code, none mentioning content", () => {
    for (const code of Object.keys(DB_ERROR_DEFINITIONS) as DbErrorCode[]) {
      expect(dbErrorMessage(code)).toMatch(/^[A-Z`].+\.$/);
      expect(typeof isSystemicDbError(code)).toBe("boolean");
    }
  });

  it("classifies systemic errors (stop the import) and per-conversation errors", () => {
    const systemic = (Object.keys(DB_ERROR_DEFINITIONS) as DbErrorCode[]).filter(isSystemicDbError).sort();
    expect(systemic).toEqual(["DB_BUSY", "DB_CONFIG", "DB_CORRUPT", "DB_DISK_FULL", "DB_NOT_INITIALIZED", "DB_NOT_MIGRATED", "DB_READ_ONLY", "DB_WRITER_UNUSABLE"]);
  });
});
