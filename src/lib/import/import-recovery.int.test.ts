import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dumpConversations, importText } from "../../../tests/helpers/import";
import { exportText, syntheticConversation } from "../../../tests/helpers/synthetic-export";
import { createTestDb, type TestDb } from "../../../tests/helpers/test-db";
import type { DbClient } from "../db/client";
import { isWriterUnusable, markWriterUnusableForTest } from "../db/transaction-recovery";
import { acquireWriteLock } from "../db/write-lock";
import { deleteAllImportedData, finishStorageCleanup } from "../data/delete-all";

/**
 * Import transaction recovery (M1.7, Part B). A competing read transaction
 * (as another process could hold) makes a conversation's COMMIT fail with
 * SQLITE_BUSY after the 5 s busy timeout. SQLite then keeps the transaction
 * open on the writer; the import must roll it back, report the original
 * failure, leave the writer usable and release the lock. Synthetic data and
 * isolated temporary databases only.
 */

const FILE = exportText(["c0", "c1", "c2"].map((id) => syntheticConversation({ id, messages: 4, tag: `v1-${id}` })));

let t: TestDb;
beforeEach(() => {
  t = createTestDb();
});
afterEach(async () => {
  await t.cleanup();
});

/** Opens a read transaction on `reader` and holds it until the returned release function is awaited. */
async function holdReadTransaction(reader: DbClient): Promise<() => Promise<void>> {
  let open!: () => void;
  let arrived!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  const ready = new Promise<void>((r) => (arrived = r));
  const done = reader.$transaction(
    async (tx) => {
      await tx.importBatch.count();
      arrived();
      await opened;
    },
    { timeout: 60_000 },
  );
  await ready;
  return async () => {
    open();
    await done;
  };
}

async function referenceDump(): Promise<string> {
  const ref = createTestDb();
  try {
    await importText(FILE, { writer: ref.writer });
    return await dumpConversations(ref.db);
  } finally {
    await ref.cleanup();
  }
}

async function quick<T>(f: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const v = await f();
  expect(performance.now() - t0, "not blocked by a leftover transaction").toBeLessThan(1_000);
  return v;
}

describe("busy COMMIT during an import", () => {
  it("rolls the conversation back, reports DB_BUSY, releases the lock and leaves the writer usable", async () => {
    const reader = t.reader();
    let release: (() => Promise<void>) | undefined;
    const r = await importText(FILE, {
      writer: t.writer,
      hooks: {
        // Conversation c1: a reader transaction starts just before its COMMIT.
        inTransaction: async (stage, index) => {
          if (stage === "beforeCommit" && index === 1) release = await holdReadTransaction(reader);
        },
        // Lets finalisation write the batch row.
        beforeFinalize: async () => {
          await release?.();
        },
      },
    });

    expect(r).toMatchObject({ status: "failed", errorCode: "DB_BUSY", complete: false });
    expect(r.counts).toMatchObject({ added: 1, seen: 3 });
    expect(r.notAccounted).toBe(2);
    expect(isWriterUnusable(t.db)).toBe(false);

    // c1's writes were rolled back, not left pending: other connections read
    // at once and see only c0; the writer sees the same committed state.
    const ids = async (db: DbClient) => (await db.conversation.findMany({ select: { sourceId: true }, orderBy: { sourceId: "asc" } })).map((c) => c.sourceId);
    expect(await quick(() => ids(reader))).toEqual(["c0"]);
    expect(await quick(() => ids(t.db))).toEqual(["c0"]);
    const batch = await reader.importBatch.findFirstOrThrow({ select: { status: true, errorCode: true, conversationsAdded: true } });
    expect(batch).toEqual({ status: "failed", errorCode: "DB_BUSY", conversationsAdded: 1 });

    // The lock was released; the writer works: importing again completes and
    // reaches the same state as one clean import (deduplication intact).
    const lock = await acquireWriteLock(t.file);
    expect(lock.ok).toBe(true);
    if (lock.ok) lock.lock.release();
    const again = await importText(FILE, { writer: t.writer });
    expect(again).toMatchObject({ status: "succeeded", complete: true, recoveredInterrupted: 0 });
    expect(again.counts).toMatchObject({ added: 2, unchanged: 1 });
    expect(await dumpConversations(t.db)).toBe(await referenceDump());
  }, 60_000);

  it("a busy single-statement write (finalisation) leaves no transaction open either", async () => {
    const reader = t.reader();
    let release: (() => Promise<void>) | undefined;
    const r = await importText(FILE, {
      writer: t.writer,
      hooks: {
        // Finalisation and its fallback both meet a held read transaction.
        beforeFinalize: async () => {
          release = await holdReadTransaction(reader);
        },
      },
    });
    await release?.();
    expect(r).toMatchObject({ status: "running", errorCode: "DB_BUSY" });

    expect(await quick(() => reader.conversation.count())).toBe(3);
    const batch = await quick(() => reader.importBatch.findFirstOrThrow({ select: { status: true } }));
    expect(batch.status).toBe("running"); // the next import marks it interrupted
    const again = await importText(FILE, { writer: t.writer });
    expect(again).toMatchObject({ status: "succeeded", complete: true, recoveredInterrupted: 1 });
    expect(await dumpConversations(t.db)).toBe(await referenceDump());
  }, 60_000);
});

describe("an unusable writer is never reused", () => {
  it("an import that finds the writer unusable stops without finalising through it and releases the lock", async () => {
    const r = await importText(FILE, {
      writer: t.writer,
      hooks: {
        inTransaction: (stage, index) => {
          if (stage === "afterRead" && index === 1) {
            markWriterUnusableForTest(t.db); // as if the rollback could not be shown
            throw new Error("injected");
          }
        },
      },
    });
    expect(r).toMatchObject({ status: "running", errorCode: "IMPORT_INTERNAL_ERROR" });
    expect(r.counts).toMatchObject({ added: 1 });
    const lock = await acquireWriteLock(t.file);
    expect(lock.ok).toBe(true);
    if (lock.ok) lock.lock.release();

    // Every later write through it is refused; nothing more is written.
    const reader = t.reader();
    const before = await dumpConversations(reader);
    expect(await importText(FILE, { writer: t.writer })).toMatchObject({ batchId: null, errorCode: "DB_WRITER_UNUSABLE" });
    expect(await deleteAllImportedData({ writer: t.writer })).toEqual({ status: "not_deleted", code: "DB_WRITER_UNUSABLE", writerSettingsRestored: true });
    expect(await finishStorageCleanup({ writer: t.writer })).toEqual({ status: "not_run", code: "DB_WRITER_UNUSABLE", writerSettingsRestored: true });
    expect(await dumpConversations(reader)).toBe(before);

    // A new connection (as after a restart) recovers the batch and completes.
    const fresh = { db: t.reader(), dbPath: t.file };
    const again = await importText(FILE, { writer: fresh });
    expect(again).toMatchObject({ status: "succeeded", complete: true, recoveredInterrupted: 1 });
    expect(await dumpConversations(fresh.db)).toBe(await referenceDump());
  }, 60_000);
});
