import type { DbClient } from "../../db/client";

/**
 * ImportBatch lifecycle (M1.4): create → checkpoints → finalise, plus
 * recovery of batches left `running` by a crash.
 *
 * Accounting model (refinements A and F). `conversationsSeen` is every
 * conversation discovered in the file. The six outcome counters are
 * durable: each one is committed in the same transaction as the write it
 * describes, or at a checkpoint. Outcomes that write nothing (unchanged,
 * older, flagged, failed) are tallied in memory and committed with the next
 * write transaction, at a checkpoint, or at finalisation. The committed
 * counters therefore always describe an unbroken prefix of the file:
 *
 *   accounted    = added + updated + unchanged + older + flagged + skipped
 *   notAccounted = seen − accounted
 *
 * For a completed batch, notAccounted is 0. For an interrupted or failed
 * batch it is the number of conversations with no durably recorded outcome.
 * Those may or may not have been examined before the stop, but none of them
 * changed stored data: the one in progress was rolled back, and every
 * committed write is inside the accounted prefix.
 */

export const IMPORT_STATUSES = [
  "running",
  "succeeded",
  "succeeded_with_warnings",
  "completed_with_errors",
  "failed",
  "interrupted",
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

/** Statuses for which every discovered conversation has an outcome. */
export const COMPLETED_STATUSES: readonly ImportStatus[] = ["succeeded", "succeeded_with_warnings", "completed_with_errors"];

export type OutcomeCounters = {
  added: number;
  updated: number;
  unchanged: number;
  older: number;
  flagged: number;
  skipped: number;
};

export const zeroCounters = (): OutcomeCounters => ({ added: 0, updated: 0, unchanged: 0, older: 0, flagged: 0, skipped: 0 });

export function addCounters(a: OutcomeCounters, b: OutcomeCounters): OutcomeCounters {
  return {
    added: a.added + b.added,
    updated: a.updated + b.updated,
    unchanged: a.unchanged + b.unchanged,
    older: a.older + b.older,
    flagged: a.flagged + b.flagged,
    skipped: a.skipped + b.skipped,
  };
}

export const sumCounters = (c: OutcomeCounters) => c.added + c.updated + c.unchanged + c.older + c.flagged + c.skipped;

/** Prisma `increment` data for the non-zero counters. */
export function incrementData(delta: OutcomeCounters) {
  const data: Record<string, { increment: number }> = {};
  const add = (column: string, n: number) => {
    if (n !== 0) data[column] = { increment: n };
  };
  add("conversationsAdded", delta.added);
  add("conversationsUpdated", delta.updated);
  add("conversationsUnchanged", delta.unchanged);
  add("conversationsOlder", delta.older);
  add("conversationsFlagged", delta.flagged);
  add("conversationsSkipped", delta.skipped);
  return data;
}

export type BatchAccounting = { seen: number; accounted: number; notAccounted: number; complete: boolean };

/** Accounting of a stored batch row. */
export function batchAccounting(row: {
  status: string;
  conversationsSeen: number;
  conversationsAdded: number;
  conversationsUpdated: number;
  conversationsUnchanged: number;
  conversationsOlder: number;
  conversationsFlagged: number;
  conversationsSkipped: number;
}): BatchAccounting {
  const accounted =
    row.conversationsAdded +
    row.conversationsUpdated +
    row.conversationsUnchanged +
    row.conversationsOlder +
    row.conversationsFlagged +
    row.conversationsSkipped;
  const notAccounted = row.conversationsSeen - accounted;
  return {
    seen: row.conversationsSeen,
    accounted,
    notAccounted,
    complete: (COMPLETED_STATUSES as readonly string[]).includes(row.status) && notAccounted === 0,
  };
}

/**
 * The wording for a batch that did not complete (safeguard B). It never
 * claims that unaccounted conversations were unexamined, only that no
 * outcome was recorded for them. Null for completed batches.
 */
export function accountingSummary(a: BatchAccounting): string | null {
  if (a.complete) return null;
  return `Accounted for ${a.accounted} of ${a.seen}; ${a.notAccounted} not accounted for.`;
}

export type NewBatch = {
  adapter: string;
  adapterVersion: string;
  sourceFilename: string;
  sourceSha256: string;
  sourceBytes: number;
  conversationsSeen: number;
  /** Outcomes already decided by the adapter (file pass): flagged and skipped entries. */
  adapterCounters: OutcomeCounters;
  warningsJson: string;
  startedAt: Date;
};

export async function createBatch(db: DbClient, b: NewBatch): Promise<string> {
  const row = await db.importBatch.create({
    data: {
      status: "running",
      startedAt: b.startedAt,
      adapter: b.adapter,
      adapterVersion: b.adapterVersion,
      sourceFilename: b.sourceFilename,
      sourceSha256: b.sourceSha256,
      sourceBytes: b.sourceBytes,
      conversationsSeen: b.conversationsSeen,
      conversationsAdded: b.adapterCounters.added,
      conversationsUpdated: b.adapterCounters.updated,
      conversationsUnchanged: b.adapterCounters.unchanged,
      conversationsOlder: b.adapterCounters.older,
      conversationsFlagged: b.adapterCounters.flagged,
      conversationsSkipped: b.adapterCounters.skipped,
      warningsJson: b.warningsJson,
    },
    select: { id: true },
  });
  return row.id;
}

/** Commits pending tallies and the partial report (`complete: false`). */
export async function checkpointBatch(db: DbClient, batchId: string, pending: OutcomeCounters, warningsJson: string): Promise<void> {
  await db.importBatch.update({
    where: { id: batchId, status: "running" },
    data: { ...incrementData(pending), warningsJson },
    select: { id: true },
  });
}

export async function finalizeBatch(
  db: DbClient,
  batchId: string,
  f: { pending: OutcomeCounters; status: Exclude<ImportStatus, "running" | "interrupted">; errorCode: string | null; warningsJson: string; finishedAt: Date },
): Promise<void> {
  await db.importBatch.update({
    where: { id: batchId, status: "running" },
    data: { ...incrementData(f.pending), status: f.status, errorCode: f.errorCode, warningsJson: f.warningsJson, finishedAt: f.finishedAt },
    select: { id: true },
  });
}

/**
 * Fallback when finalisation itself fails: records the failure without the
 * report. If this fails too, the batch stays `running` and the next import
 * marks it `interrupted`.
 */
export async function markBatchFailed(db: DbClient, batchId: string, errorCode: string, finishedAt: Date): Promise<void> {
  await db.importBatch.updateMany({
    where: { id: batchId, status: "running" },
    data: { status: "failed", errorCode, finishedAt },
  });
}

/**
 * Marks every `running` batch as `interrupted`. Call only while holding the
 * write lock: then no other import can be live, in this process or another,
 * so every `running` batch is provably stale. Its counters and its last
 * checkpointed report (`complete: false`) are kept as they are.
 */
export async function recoverInterruptedBatches(db: DbClient, now: Date): Promise<number> {
  const r = await db.importBatch.updateMany({
    where: { status: "running" },
    data: { status: "interrupted", errorCode: "IMPORT_INTERRUPTED", finishedAt: now },
  });
  return r.count;
}
