import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { createTestDb, type TestDb } from "../../../tests/helpers/test-db";
import { CLIENT_OPTIONS, createPrismaClient, type DbClient } from "./client";
import { sanitizeDbError, type DbErrorCode } from "./errors";
import { assertDatabaseIsolation, toDatabaseUrl } from "./path";

/**
 * Real failures from SQLite through Prisma 7.10.1 and the better-sqlite3
 * adapter, each mapped to its code. A synthetic canary sits in the written
 * values; where Prisma's own error text quotes it, the test first proves that,
 * so the sanitiser's output being canary-free is meaningful.
 */

const CANARY = "synthetic-canary-int-5d1c";

/** A client with custom adapter options, behind the same isolation guard. */
function clientFor(file: string, adapterOpts: Record<string, unknown> = {}): DbClient {
  assertDatabaseIsolation({ env: { THREADATLAS_TEST: "1" }, root: process.cwd(), dbPath: file });
  const adapter = new PrismaBetterSqlite3({ url: toDatabaseUrl(file), fileMustExist: true, ...adapterOpts });
  return new PrismaClient({ adapter, ...CLIENT_OPTIONS, log: [] }) as unknown as DbClient;
}

const convData = (sourceId: string) => ({
  source: "chatgpt",
  sourceId,
  idSource: "id",
  pathStrategy: "current_node",
  visibleMessageCount: 0,
  nodeCount: 0,
  contentHash: `v1:${"a".repeat(64)}`,
  parserVersion: "0.3.0",
});

async function failure(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a failure");
}

function expectMapped(e: unknown, code: DbErrorCode) {
  const mapped = sanitizeDbError(e);
  expect(mapped).toBe(code);
  expect(mapped).not.toContain(CANARY);
}

let t: TestDb;
beforeEach(() => {
  t = createTestDb();
});
afterEach(async () => {
  await t.cleanup();
});

describe("sanitizeDbError on real database failures", () => {
  it("unique constraint → DB_CONSTRAINT", async () => {
    await t.db.conversation.create({ data: convData(CANARY) });
    expectMapped(await failure(t.db.conversation.create({ data: convData(CANARY) })), "DB_CONSTRAINT");
  });

  it("foreign key → DB_CONSTRAINT", async () => {
    const e = await failure(t.db.message.create({ data: { conversationId: "missing", sourceNodeId: "n", siblingIndex: 0, contentText: CANARY } }));
    expectMapped(e, "DB_CONSTRAINT");
  });

  it("validation error, whose message quotes the canary → DB_INVALID_QUERY", async () => {
    const e = await failure(
      t.db.conversation.create({ data: { ...convData("v"), title: CANARY, nodeCount: CANARY as unknown as number } }),
    );
    expect(String((e as Error).message)).toContain(CANARY); // the raw error does leak
    expectMapped(e, "DB_INVALID_QUERY");
  });

  it("missing table → DB_NOT_MIGRATED", async () => {
    await t.db.$executeRawUnsafe('DROP TABLE "Message"');
    expectMapped(await failure(t.db.message.count()), "DB_NOT_MIGRATED");
  });

  it("missing database file → DB_NOT_INITIALIZED (never created)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "threadatlas-err-"));
    const file = path.join(dir, "missing.db");
    const db = createPrismaClient({ env: { THREADATLAS_TEST: "1", DATABASE_URL: toDatabaseUrl(file) } });
    try {
      expectMapped(await failure(db.conversation.count()), "DB_NOT_INITIALIZED");
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      await db.$disconnect();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("read-only database → DB_READ_ONLY", async () => {
    const ro = clientFor(t.file, { readonly: true });
    try {
      expectMapped(await failure(ro.conversation.create({ data: convData(CANARY) })), "DB_READ_ONLY");
    } finally {
      await ro.$disconnect();
    }
  });

  it("disk full (page limit reached) → DB_DISK_FULL", async () => {
    const [pc] = await t.db.$queryRawUnsafe<{ page_count: bigint }[]>("PRAGMA page_count");
    await t.db.$queryRawUnsafe(`PRAGMA max_page_count = ${Number(pc!.page_count)}`);
    const c = await failure(
      t.db.conversation.create({ data: { ...convData("full"), title: CANARY.repeat(20_000) } }),
    );
    expectMapped(c, "DB_DISK_FULL");
  });

  it("not a database → DB_CORRUPT", async () => {
    fs.writeFileSync(t.file, Buffer.alloc(8192, 0x41));
    const db = clientFor(t.file);
    try {
      expectMapped(await failure(db.conversation.count()), "DB_CORRUPT");
    } finally {
      await db.$disconnect();
    }
  });

  it("locked by another connection → DB_BUSY", async () => {
    const holder = new Database(t.file, { timeout: 0 });
    holder.exec("BEGIN EXCLUSIVE");
    const db = clientFor(t.file, { timeout: 20 });
    try {
      expectMapped(await failure(db.conversation.count()), "DB_BUSY");
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
      await db.$disconnect();
    }
  });

  it("transaction timeout → DB_TIMEOUT", async () => {
    const e = await failure(
      t.db.$transaction(
        async (tx) => {
          await tx.conversation.create({ data: convData(CANARY) });
          await new Promise((r) => setTimeout(r, 150));
          await tx.conversation.count();
        },
        { timeout: 30 },
      ),
    );
    expectMapped(e, "DB_TIMEOUT");
    expect(await t.db.conversation.count()).toBe(0);
  });

  it("our own error inside a transaction passes through unchanged → IMPORT_INTERNAL_ERROR", async () => {
    const e = await failure(
      t.db.$transaction(async (tx) => {
        await tx.conversation.create({ data: convData("own") });
        throw new Error(CANARY);
      }),
    );
    expect((e as Error).message).toBe(CANARY);
    expectMapped(e, "IMPORT_INTERNAL_ERROR");
    expect(await t.db.conversation.count()).toBe(0);
  });
});
