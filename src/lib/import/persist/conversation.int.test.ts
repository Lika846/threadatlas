import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dumpExact, partialConversations } from "../../../../tests/helpers/import";
import { syntheticConversation, type SyntheticOptions } from "../../../../tests/helpers/synthetic-export";
import { createTestDb, type TestDb } from "../../../../tests/helpers/test-db";
import { sanitizeDbError } from "../../db/errors";
import { parseChatGptExport } from "../chatgpt/adapter";
import { normalizeConversation } from "../chatgpt/normalize";
import type { NormalizedConversation } from "../types";
import { createBatch, zeroCounters } from "./batch";
import { MESSAGE_CHUNK_SIZE, persistConversation, type TxStage } from "./conversation";

let t: TestDb;
beforeEach(() => {
  t = createTestDb();
});
afterEach(async () => {
  await t.cleanup();
});

function normalized(o: SyntheticOptions): NormalizedConversation {
  const res = parseChatGptExport([syntheticConversation(o)]);
  if (!res.ok || res.accepted.length !== 1) throw new Error("synthetic conversation must be accepted");
  return normalizeConversation(res.accepted[0]!).conversation;
}

const batch = () =>
  createBatch(t.db, {
    adapter: "chatgpt", adapterVersion: "0.3.0", sourceFilename: "s.json", sourceSha256: "0".repeat(64), sourceBytes: 1,
    conversationsSeen: 100, adapterCounters: zeroCounters(), warningsJson: "{}", startedAt: new Date(),
  });

const persist = (batchId: string, conversation: NormalizedConversation, hooks?: Parameters<typeof persistConversation>[1]["hooks"]) =>
  persistConversation(t.db, { batchId, conversation, pending: zeroCounters(), hooks });

const stored = (sourceId: string) =>
  t.db.conversation.findUniqueOrThrow({
    where: { source_sourceId: { source: "chatgpt", sourceId } },
    include: { messages: { orderBy: { sourceNodeId: "asc" }, omit: { rawContentJson: false } } },
  });

describe("per-conversation transaction", () => {
  it("adds a conversation with every node and counts it in the same transaction", async () => {
    const b = await batch();
    const r = await persistConversation(t.db, { batchId: b, conversation: normalized({ id: "c1", messages: 4 }), pending: { ...zeroCounters(), unchanged: 2, flagged: 1 } });
    expect(r).toMatchObject({ wrote: true, decision: { kind: "add", case: 5 } });
    const c = await stored("c1");
    expect(c).toMatchObject({ nodeCount: 5, firstImportBatchId: b, lastImportBatchId: b, parserVersion: "0.3.0" });
    expect(c.messages.map((m) => m.sourceNodeId)).toEqual(["n1", "n2", "n3", "n4", "root"]);
    // The pending tallies were committed with the write.
    expect(await t.db.importBatch.findUniqueOrThrow({ where: { id: b } })).toMatchObject({ conversationsAdded: 1, conversationsUnchanged: 2, conversationsFlagged: 1 });
  });

  it("writes nothing for an unchanged, older or ambiguous copy", async () => {
    const b = await batch();
    await persist(b, normalized({ id: "c1", updateTime: 200 }));
    const before = await dumpExact(t.db);
    expect((await persist(b, normalized({ id: "c1", updateTime: 200 }))).decision.kind).toBe("unchanged");
    expect((await persist(b, normalized({ id: "c1", updateTime: 100, tag: "old" }))).decision.kind).toBe("older");
    expect((await persist(b, normalized({ id: "c1", updateTime: 200, tag: "same-time" }))).decision).toMatchObject({ kind: "flagged", case: 10 });
    expect((await persist(b, normalized({ id: "c1", updateTime: null, tag: "no-time" }))).decision).toMatchObject({ kind: "flagged", case: 11 });
    expect(await dumpExact(t.db)).toBe(before);
  });

  it("replaces all messages of a newer copy, keeping id and firstImportBatchId", async () => {
    const b1 = await batch();
    await persist(b1, normalized({ id: "c1", messages: 5, updateTime: 100 }));
    const before = await stored("c1");
    const b2 = await batch();
    const r = await persist(b2, normalized({ id: "c1", messages: 2, updateTime: 200, tag: "v2" }));
    expect(r.decision).toEqual({ kind: "replace", case: 8 });
    const after = await stored("c1");
    expect(after.id).toBe(before.id);
    expect(after).toMatchObject({ firstImportBatchId: b1, lastImportBatchId: b2, nodeCount: 3, updatedAtSec: 200 });
    expect(after.messages.map((m) => m.sourceNodeId)).toEqual(["n1", "n2", "root"]);
    expect(after.messages.every((m) => m.contentText === "" || m.contentText.startsWith("v2"))).toBe(true);
    // Message IDs change on replacement; nodes are identified by (conversationId, sourceNodeId).
    expect(after.messages.find((m) => m.sourceNodeId === "n1")!.id).not.toBe(before.messages.find((m) => m.sourceNodeId === "n1")!.id);
    expect(await t.db.message.count()).toBe(3); // nothing orphaned
    expect(await partialConversations(t.db)).toBe(0);
  });

  it("refreshes an identical source stored by an older parser (parser upgrade)", async () => {
    const b1 = await batch();
    await persist(b1, normalized({ id: "c1" }));
    await t.db.conversation.updateMany({ data: { parserVersion: "0.2.0", visibleMessageCount: 99 } });
    const b2 = await batch();
    const r = await persist(b2, normalized({ id: "c1" }));
    expect(r.decision).toEqual({ kind: "replace", case: 7, code: "CONVERSATION_REPROCESSED" });
    expect(await stored("c1")).toMatchObject({ parserVersion: "0.3.0", visibleMessageCount: 3, firstImportBatchId: b1, lastImportBatchId: b2 });
    expect(await t.db.importBatch.findUniqueOrThrow({ where: { id: b2 } })).toMatchObject({ conversationsUpdated: 1 });
  });

  it("inserts large trees in chunks of 500 rows", async () => {
    const b = await batch();
    let chunks = 0;
    await persist(b, normalized({ id: "big", messages: 1_200 }), { inTransaction: (s) => void (s === "afterChunk" && chunks++) });
    expect(chunks).toBe(Math.ceil(1_201 / MESSAGE_CHUNK_SIZE));
    expect(await t.db.message.count()).toBe(1_201);
  });
});

describe("rollback leaves the previous state byte for byte", () => {
  it.each<TxStage>(["afterRead", "afterDelete", "afterChunk", "afterInsert", "beforeCommit"])("failure at %s during an update", async (stage) => {
    const b1 = await batch();
    await persist(b1, normalized({ id: "c1", messages: 3, updateTime: 100 }));
    const b2 = await batch();
    const before = await dumpExact(t.db);
    await expect(
      persist(b2, normalized({ id: "c1", messages: 6, updateTime: 200, tag: "v2" }), {
        inTransaction: (s) => {
          if (s === stage) throw new Error("injected");
        },
      }),
    ).rejects.toThrow("injected");
    expect(await dumpExact(t.db)).toBe(before);
  });

  it.each<TxStage>(["afterChunk", "afterInsert", "beforeCommit"])("failure at %s during an add leaves nothing", async (stage) => {
    const b = await batch();
    await expect(persist(b, normalized({ id: "c1" }), { inTransaction: (s) => { if (s === stage) throw new Error("injected"); } })).rejects.toThrow();
    expect(await t.db.conversation.count()).toBe(0);
    expect(await t.db.message.count()).toBe(0);
    expect(await t.db.importBatch.findUniqueOrThrow({ where: { id: b } })).toMatchObject({ conversationsAdded: 0 });
  });

  it("re-checks the stored hash: a concurrent change cancels the write (DB_CONFLICT)", async () => {
    const b1 = await batch();
    await persist(b1, normalized({ id: "c1", updateTime: 100 }));
    const before = await dumpExact(t.db);
    let error: unknown;
    try {
      await persist(b1, normalized({ id: "c1", updateTime: 200, tag: "v2" }), {
        inTransaction: async (s, _i, tx) => {
          // Simulates another writer changing the row after it was read.
          if (s === "afterRead") await tx.conversation.updateMany({ data: { contentHash: `v1:${"f".repeat(64)}` } });
        },
      });
    } catch (e) {
      error = e;
    }
    expect(sanitizeDbError(error)).toBe("DB_CONFLICT");
    expect(await dumpExact(t.db)).toBe(before);
  });
});

describe("readers on the other connection see only committed data (F4)", () => {
  it("while an update is paused between delete and insert", async () => {
    const b1 = await batch();
    await persist(b1, normalized({ id: "c1", messages: 4, updateTime: 100, tag: "old" }));
    const reader = t.reader();
    let resume!: () => void;
    const paused = new Promise<void>((r) => (resume = r));
    let reached!: () => void;
    const atPause = new Promise<void>((r) => (reached = r));
    const write = persist(b1, normalized({ id: "c1", messages: 2, updateTime: 200, tag: "new" }), {
      inTransaction: async (s) => {
        if (s === "afterDelete") {
          reached();
          await paused;
        }
      },
    });
    await atPause;
    const during = await reader.message.findMany({ select: { contentText: true }, orderBy: { sourceNodeId: "asc" } });
    expect(during).toHaveLength(5);
    expect(during.filter((m) => m.contentText.startsWith("old"))).toHaveLength(4);
    resume();
    await write;
    const after = await reader.message.findMany({ select: { contentText: true } });
    expect(after).toHaveLength(3);
    expect(after.some((m) => m.contentText.startsWith("old"))).toBe(false);
  });
});
