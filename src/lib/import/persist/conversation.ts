import type { DbClient } from "../../db/client";
import { ConcurrentChangeError } from "../../db/errors";
import { runWriterTransaction } from "../../db/transaction-recovery";
import { invalidateConversation } from "../../semantic/index/store";
import type { NormalizedConversation, NormalizedNode } from "../types";
import { addCounters, incrementData, zeroCounters, type OutcomeCounters } from "./batch";
import { decide, type Decision } from "./decide";
import { conversationColumns, messageRow } from "./rows";

/**
 * One conversation, one transaction (Q1, R53), on the writer connection.
 *
 * Inside the transaction: read the stored summary (never its messages or
 * raw payloads) → decide → add or replace → increment the batch counters
 * (this outcome plus any pending tallies). Any exception rolls everything
 * back, so a conversation is never stored without all its messages, and
 * never with a mix of old and new messages.
 *
 * Replace (updates and parser refreshes) keeps `Conversation.id` and
 * `firstImportBatchId`, guards the update with the stored hash and parser
 * version (must affect exactly one row), then deletes all message rows and
 * inserts the full new tree. Message IDs therefore change; later features
 * refer to messages by (conversationId, sourceNodeId) (refinement E). Data
 * derived from a conversation's messages (e.g. the M2 search index) must be
 * rebuilt here, in this same transaction. The semantic index (M5.1b) is
 * invalidated here too (I2): add and replace only; the other decisions write
 * nothing.
 */

/** Rows per `createMany`, with a yield to the event loop between chunks (step 0: ≤ 160 ms blocking at 20,000 × 1 KB). */
export const MESSAGE_CHUNK_SIZE = 500;

/**
 * Prisma interactive-transaction limits. Backstops only: better-sqlite3 runs
 * each statement synchronously, so the timer cannot fire during a long
 * statement; work is bounded by chunking and the upload size limit instead.
 */
export const TX_TIMEOUT_MS = 300_000;
export const TX_MAX_WAIT_MS = 10_000;

export type TxStage = "afterRead" | "afterDelete" | "afterChunk" | "afterInsert" | "beforeCommit";

type Tx = Parameters<Parameters<DbClient["$transaction"]>[0]>[0];

/** Test-only fault-injection seam. Production code never passes hooks. */
export type ConversationHooks = {
  inTransaction?: (stage: TxStage, index: number, tx: Tx) => void | Promise<void>;
};

export type PersistResult =
  | { wrote: true; decision: Extract<Decision, { kind: "add" | "replace" }>; outcome: OutcomeCounters }
  | { wrote: false; decision: Extract<Decision, { kind: "unchanged" | "older" | "flagged" }> };

export const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

async function insertMessages(tx: Tx, conversationId: string, nodes: readonly NormalizedNode[], index: number, hooks?: ConversationHooks) {
  for (let start = 0; start < nodes.length; start += MESSAGE_CHUNK_SIZE) {
    if (start > 0) await yieldToEventLoop();
    const chunk = nodes.slice(start, start + MESSAGE_CHUNK_SIZE).map((n) => messageRow(conversationId, n));
    await tx.message.createMany({ data: chunk });
    await hooks?.inTransaction?.("afterChunk", index, tx);
  }
}

export function outcomeOf(decision: Decision): OutcomeCounters {
  const c = zeroCounters();
  switch (decision.kind) {
    case "add":
      c.added = 1;
      break;
    case "replace":
      c.updated = 1;
      break;
    case "unchanged":
      c.unchanged = 1;
      break;
    case "older":
      c.older = 1;
      break;
    case "flagged":
      c.flagged = 1;
      break;
  }
  return c;
}

export async function persistConversation(
  db: DbClient,
  args: {
    batchId: string;
    conversation: NormalizedConversation;
    /** Pending tallies, committed with this write if one happens. */
    pending: OutcomeCounters;
    hooks?: ConversationHooks;
  },
): Promise<PersistResult> {
  const { batchId, conversation: c, pending, hooks } = args;
  // On failure no transaction may stay open on the writer (a busy COMMIT
  // leaves it open): see `transaction-recovery.ts`.
  return runWriterTransaction(
    db,
    async (tx): Promise<PersistResult> => {
      const stored = await tx.conversation.findUnique({
        where: { source_sourceId: { source: c.source, sourceId: c.sourceId } },
        select: { id: true, contentHash: true, updatedAtSec: true, parserVersion: true },
      });
      const decision = decide(stored, { contentHash: c.contentHash, updatedAt: c.updatedAt, parserVersion: c.parserVersion });
      await hooks?.inTransaction?.("afterRead", c.index, tx);

      let conversationId: string;
      if (decision.kind === "add") {
        const created = await tx.conversation.create({
          data: { source: c.source, sourceId: c.sourceId, ...conversationColumns(c), firstImportBatchId: batchId, lastImportBatchId: batchId },
          select: { id: true },
        });
        conversationId = created.id;
        await insertMessages(tx, created.id, c.nodes, c.index, hooks);
      } else if (decision.kind === "replace") {
        const s = stored!;
        const guarded = await tx.conversation.updateMany({
          where: { id: s.id, contentHash: s.contentHash, parserVersion: s.parserVersion },
          data: { ...conversationColumns(c), lastImportBatchId: batchId },
        });
        if (guarded.count !== 1) throw new ConcurrentChangeError();
        await tx.message.deleteMany({ where: { conversationId: s.id } });
        await hooks?.inTransaction?.("afterDelete", c.index, tx);
        conversationId = s.id;
        await insertMessages(tx, s.id, c.nodes, c.index, hooks);
      } else {
        return { wrote: false, decision };
      }

      // I2 (M5.1b): the semantic index of this conversation is invalidated in the same
      // transaction: its chunks are deleted and its status row is requeued with the new
      // version (contentHash, parserVersion), so stale vectors can never survive a write.
      await invalidateConversation(tx, conversationId);
      await hooks?.inTransaction?.("afterInsert", c.index, tx);
      const outcome = outcomeOf(decision);
      await tx.importBatch.update({
        where: { id: batchId, status: "running" },
        data: incrementData(addCounters(pending, outcome)),
        select: { id: true },
      });
      await hooks?.inTransaction?.("beforeCommit", c.index, tx);
      return { wrote: true, decision, outcome };
    },
    { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS },
  );
}
