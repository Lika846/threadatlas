import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../../../../tests/helpers/test-db";
import {
  accountingSummary,
  batchAccounting,
  checkpointBatch,
  createBatch,
  finalizeBatch,
  markBatchFailed,
  recoverInterruptedBatches,
  zeroCounters,
  type NewBatch,
} from "./batch";

let t: TestDb;
beforeEach(() => {
  t = createTestDb();
});
afterEach(async () => {
  await t.cleanup();
});

const NOW = new Date("2026-11-05T10:00:00.000Z");
const newBatch = (over: Partial<NewBatch> = {}): NewBatch => ({
  adapter: "chatgpt",
  adapterVersion: "0.3.0",
  sourceFilename: "synthetic.json",
  sourceSha256: "a".repeat(64),
  sourceBytes: 123,
  conversationsSeen: 10,
  adapterCounters: { ...zeroCounters(), flagged: 1, skipped: 2 },
  warningsJson: '{"v":1}',
  startedAt: NOW,
  ...over,
});
const row = (id: string) => t.db.importBatch.findUniqueOrThrow({ where: { id } });

describe("batch lifecycle", () => {
  it("creates a running batch with the adapter's outcomes already counted", async () => {
    const id = await createBatch(t.db, newBatch());
    const b = await row(id);
    expect(b).toMatchObject({
      status: "running", conversationsSeen: 10, conversationsFlagged: 1, conversationsSkipped: 2,
      conversationsAdded: 0, finishedAt: null, errorCode: null, startedAt: NOW, sourceBytes: 123,
    });
    expect(batchAccounting(b)).toEqual({ seen: 10, accounted: 3, notAccounted: 7, complete: false });
    expect(accountingSummary(batchAccounting(b))).toBe("Accounted for 3 of 10; 7 not accounted for.");
  });

  it("checkpoints add pending tallies and replace the partial report", async () => {
    const id = await createBatch(t.db, newBatch());
    await checkpointBatch(t.db, id, { ...zeroCounters(), unchanged: 3, older: 1 }, '{"v":1,"complete":false}');
    await checkpointBatch(t.db, id, { ...zeroCounters(), unchanged: 1 }, '{"v":1,"complete":false,"n":2}');
    const b = await row(id);
    expect(b).toMatchObject({ status: "running", conversationsUnchanged: 4, conversationsOlder: 1, warningsJson: '{"v":1,"complete":false,"n":2}' });
    expect(batchAccounting(b).accounted).toBe(8);
  });

  it("finalises once: status, error code, finish time, last tallies", async () => {
    const id = await createBatch(t.db, newBatch({ conversationsSeen: 4 }));
    await finalizeBatch(t.db, id, { pending: { ...zeroCounters(), added: 1 }, status: "succeeded_with_warnings", errorCode: null, warningsJson: "{}", finishedAt: NOW });
    const b = await row(id);
    expect(b).toMatchObject({ status: "succeeded_with_warnings", finishedAt: NOW, conversationsAdded: 1 });
    expect(batchAccounting(b)).toEqual({ seen: 4, accounted: 4, notAccounted: 0, complete: true });
    expect(accountingSummary(batchAccounting(b))).toBeNull();
    // A finished batch can no longer be changed by a stray checkpoint or second finalisation.
    await expect(checkpointBatch(t.db, id, { ...zeroCounters(), added: 1 }, "{}")).rejects.toBeDefined();
    await expect(finalizeBatch(t.db, id, { pending: zeroCounters(), status: "failed", errorCode: "DB_UNKNOWN", warningsJson: "{}", finishedAt: NOW })).rejects.toBeDefined();
    expect((await row(id)).status).toBe("succeeded_with_warnings");
  });

  it("a failed batch reports what was accounted for", async () => {
    const id = await createBatch(t.db, newBatch());
    await finalizeBatch(t.db, id, { pending: { ...zeroCounters(), added: 2 }, status: "failed", errorCode: "DB_DISK_FULL", warningsJson: "{}", finishedAt: NOW });
    const a = batchAccounting(await row(id));
    expect(a).toEqual({ seen: 10, accounted: 5, notAccounted: 5, complete: false });
    expect(accountingSummary(a)).toBe("Accounted for 5 of 10; 5 not accounted for.");
  });

  it("a completed status with a counter gap is never presented as complete", () => {
    const a = batchAccounting({ status: "succeeded", conversationsSeen: 3, conversationsAdded: 2, conversationsUpdated: 0, conversationsUnchanged: 0, conversationsOlder: 0, conversationsFlagged: 0, conversationsSkipped: 0 });
    expect(a.complete).toBe(false);
  });

  it("markBatchFailed records a failure without touching a finished batch", async () => {
    const running = await createBatch(t.db, newBatch());
    const done = await createBatch(t.db, newBatch());
    await finalizeBatch(t.db, done, { pending: zeroCounters(), status: "succeeded", errorCode: null, warningsJson: "{}", finishedAt: NOW });
    await markBatchFailed(t.db, running, "DB_READ_ONLY", NOW);
    await markBatchFailed(t.db, done, "DB_READ_ONLY", NOW);
    expect(await row(running)).toMatchObject({ status: "failed", errorCode: "DB_READ_ONLY", finishedAt: NOW });
    expect(await row(done)).toMatchObject({ status: "succeeded", errorCode: null });
  });
});

describe("recovery of interrupted batches", () => {
  it("marks only running batches interrupted, keeping their counters and partial report", async () => {
    const stale = await createBatch(t.db, newBatch({ warningsJson: '{"v":1,"complete":false}' }));
    await checkpointBatch(t.db, stale, { ...zeroCounters(), added: 2 }, '{"v":1,"complete":false,"accountedConversations":5}');
    const done = await createBatch(t.db, newBatch());
    await finalizeBatch(t.db, done, { pending: zeroCounters(), status: "succeeded", errorCode: null, warningsJson: "{}", finishedAt: NOW });
    const later = new Date(NOW.getTime() + 60_000);

    expect(await recoverInterruptedBatches(t.db, later)).toBe(1);
    const s = await row(stale);
    expect(s).toMatchObject({ status: "interrupted", errorCode: "IMPORT_INTERRUPTED", finishedAt: later, conversationsAdded: 2, warningsJson: '{"v":1,"complete":false,"accountedConversations":5}' });
    expect(accountingSummary(batchAccounting(s))).toBe("Accounted for 5 of 10; 5 not accounted for.");
    expect(await row(done)).toMatchObject({ status: "succeeded", finishedAt: NOW });
    // Idempotent.
    expect(await recoverInterruptedBatches(t.db, later)).toBe(0);
  });
});
