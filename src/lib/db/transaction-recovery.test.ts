import { describe, expect, it } from "vitest";
import type { DbClient } from "./client";
import { ensureNoOpenTransaction, isWriterUnusable, runWriterTransaction } from "./transaction-recovery";

/** A stand-in client that records statements and fails those at the given positions (0-based). */
function stub(opts: { failAt?: number[]; failTx?: unknown } = {}) {
  const sent: string[] = [];
  const failAt = new Set(opts.failAt ?? []);
  const db = {
    async $executeRawUnsafe(sql: string) {
      const i = sent.push(sql) - 1;
      if (failAt.has(i)) throw new Error("synthetic failure");
      return 0;
    },
    async $transaction(fn: (tx: unknown) => Promise<unknown>) {
      if (opts.failTx !== undefined) throw opts.failTx;
      return fn({});
    },
  };
  return { db: db as unknown as DbClient, sent };
}

describe("ensureNoOpenTransaction", () => {
  it("rolls back, then proves no transaction is open with a deferred BEGIN", async () => {
    const { db, sent } = stub();
    expect(await ensureNoOpenTransaction(db)).toBe("clean");
    expect(sent).toEqual(["ROLLBACK", "BEGIN DEFERRED", "ROLLBACK"]);
  });

  it("is clean when the first ROLLBACK fails because nothing was open", async () => {
    const { db } = stub({ failAt: [0] });
    expect(await ensureNoOpenTransaction(db)).toBe("clean");
  });

  it("reports stuck when a transaction is still open (BEGIN refused)", async () => {
    const { db, sent } = stub({ failAt: [0, 1] });
    expect(await ensureNoOpenTransaction(db)).toBe("stuck");
    expect(sent).toEqual(["ROLLBACK", "BEGIN DEFERRED"]);
  });

  it("reports stuck when the probe's own ROLLBACK fails", async () => {
    const { db } = stub({ failAt: [2] });
    expect(await ensureNoOpenTransaction(db)).toBe("stuck");
  });
});

describe("runWriterTransaction", () => {
  it("adds no statements when the transaction succeeds", async () => {
    const { db, sent } = stub();
    expect(await runWriterTransaction(db, async () => 42)).toBe(42);
    expect(sent).toEqual([]);
  });

  it("rethrows the original error unchanged after recovering", async () => {
    const original = new Error("original");
    const { db, sent } = stub({ failTx: original });
    await expect(runWriterTransaction(db, async () => 1)).rejects.toBe(original);
    expect(sent).toEqual(["ROLLBACK", "BEGIN DEFERRED", "ROLLBACK"]);
    expect(isWriterUnusable(db)).toBe(false);
  });

  it("marks the writer unusable when no clean state can be shown, still rethrowing the original error", async () => {
    const original = new Error("original");
    const { db } = stub({ failTx: original, failAt: [0, 1] });
    await expect(runWriterTransaction(db, async () => 1)).rejects.toBe(original);
    expect(isWriterUnusable(db)).toBe(true);
  });
});
