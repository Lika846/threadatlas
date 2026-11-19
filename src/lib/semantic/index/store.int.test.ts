/**
 * The index SQL (M5.1b-1) against migrated temporary databases, with the real import
 * transaction (I2 built in) and the real delete-all. Ported from the pre-implementation
 * prototype (docs/spikes/m5.1b/migration/prototype.int.test.ts.txt). Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syntheticConversation, type SyntheticOptions } from "../../../../tests/helpers/synthetic-export";
import { chunkCount, chunkDump, indexRow, statusOf } from "../../../../tests/helpers/semantic-index";
import { createTestDb, type TestDb } from "../../../../tests/helpers/test-db";
import type { DbClient } from "../../db/client";
import { runWriterTransaction } from "../../db/transaction-recovery";
import { deleteAllImportedData } from "../../data/delete-all";
import { parseChatGptExport } from "../../import/chatgpt/adapter";
import { normalizeConversation } from "../../import/chatgpt/normalize";
import { createBatch, zeroCounters } from "../../import/persist/batch";
import { persistConversation, type TxStage } from "../../import/persist/conversation";
import type { NormalizedConversation } from "../../import/types";
import { searchConversations } from "../../search/search";
import { quantizedByteLength } from "../quantize";
import { CODE_INDEX_CONFIG, INDEX_ROW_ID, INSERT_ROWS_PER_STATEMENT, MAX_ATTEMPTS, MAX_CHUNKS_PER_CONVERSATION, type IndexConfig } from "./config";
import { openVectorReader } from "./reader";
import {
  claimNext,
  commitClaim,
  dbTimestamp,
  invalidateConversation,
  readIndexRow,
  readPage,
  reconcile,
  releaseClaim,
  retryFailed,
  type ChunkRow,
  type Claim,
} from "./store";

const CONFIG = CODE_INDEX_CONFIG;
const VECTOR_BYTES = quantizedByteLength(CONFIG.dimensions);
const QUERY = { embeddingVersion: CONFIG.embeddingVersion, chunkerVersion: CONFIG.chunkerVersion };

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
const newBatch = () =>
  createBatch(t.db, {
    adapter: "chatgpt", adapterVersion: "0.3.0", sourceFilename: "s.json", sourceSha256: "0".repeat(64), sourceBytes: 1,
    conversationsSeen: 100, adapterCounters: zeroCounters(), warningsJson: "{}", startedAt: new Date(),
  });

/** The real import transaction (I2 is part of it), with an optional injected failure. */
async function importConv(conv: NormalizedConversation, failAt?: TxStage) {
  const b = await newBatch();
  return persistConversation(t.db, {
    batchId: b,
    conversation: conv,
    pending: zeroCounters(),
    hooks: failAt ? { inTransaction: (stage) => { if (stage === failAt) throw new Error("injected failure"); } } : undefined,
  });
}

const idOf = async (sourceId: string) => (await t.db.conversation.findUniqueOrThrow({ where: { source_sourceId: { source: "chatgpt", sourceId } } })).id;
const tx = <T,>(fn: (tx: DbClient) => Promise<T>) => runWriterTransaction(t.db, (x) => fn(x as unknown as DbClient));
const doReconcile = (cfg: IndexConfig = CONFIG) => tx((x) => reconcile(x, cfg));
const claim = () => tx((x) => claimNext(x));
const commit = (c: Claim, chunks: ChunkRow[], worker: IndexConfig = CONFIG) => tx((x) => commitClaim(x, c, chunks, worker));
const vec = (seed: number) => {
  const b = new Uint8Array(VECTOR_BYTES);
  new DataView(b.buffer).setFloat32(0, 0.01, true);
  for (let i = 4; i < VECTOR_BYTES; i++) b[i] = (seed * 31 + i) & 0x7f;
  return b;
};
const chunksFor = (n: number, seed = 1): ChunkRow[] =>
  Array.from({ length: n }, (_, k) => ({ sourceNodeId: `n${(k % 3) + 1}`, chunkIndex: Math.floor(k / 3), start: 0, end: 5, tokenCount: 3, chunkKey: "k".repeat(32), vector: vec(seed + k) }));
async function indexAll(n = 2) {
  await doReconcile();
  for (let c = await claim(); c; c = await claim()) expect(await commit(c, chunksFor(n))).toBe("committed");
}
const json = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? Number(v) : v));

describe("storage format", () => {
  it("stores DateTime exactly like the Prisma adapter, and the client reads it back as a Date", async () => {
    await importConv(normalized({ id: "c1" }));
    const [b] = await t.db.$queryRawUnsafe<{ v: string; k: string }[]>(`SELECT CAST("startedAt" AS TEXT) AS v, typeof("startedAt") AS k FROM "ImportBatch" LIMIT 1`);
    const [s] = await t.db.$queryRawUnsafe<{ v: string; k: string }[]>(`SELECT CAST("queuedAt" AS TEXT) AS v, typeof("queuedAt") AS k FROM "EmbeddingStatus" LIMIT 1`);
    expect(s!.k).toBe(b!.k);
    expect(s!.v.replace(/\d/g, "0")).toBe(b!.v.replace(/\d/g, "0"));
    expect(dbTimestamp(new Date(0))).toBe("1970-01-01T00:00:00.000+00:00");
    const row = await t.db.embeddingStatus.findFirstOrThrow();
    expect(row.queuedAt).toBeInstanceOf(Date);
    expect(Math.abs(row.queuedAt.getTime() - Date.now())).toBeLessThan(60_000);
  });

  it("a commit stores every chunk exactly: offsets, keys and vector bytes round-trip, whatever the node id", async () => {
    await importConv(normalized({ id: "c1" }));
    await doReconcile();
    const c = (await claim())!;
    const ids = ["n1", "123", "ünïcødé/ключ", `quote"and'back\\slash`, "x".repeat(512)];
    const chunks: ChunkRow[] = Array.from({ length: 2_345 }, (_, k) => ({
      sourceNodeId: ids[k % ids.length]!,
      chunkIndex: Math.floor(k / ids.length),
      start: k,
      end: k + 7,
      tokenCount: (k % 64) + 1,
      chunkKey: k.toString(16).padStart(32, "0"),
      vector: Uint8Array.from({ length: VECTOR_BYTES }, (_, i) => (k * 7 + i * 13) & 0xff),
    }));
    expect(await commit(c, chunks)).toBe("committed");
    const rows = await t.db.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT "sourceNodeId", "chunkIndex", "start", "end", "tokenCount", "chunkKey", "vector", "epoch", "contentHash" FROM "EmbeddingChunk"`,
    );
    const key = (r: { sourceNodeId?: unknown; chunkIndex?: unknown }) => `${String(r.sourceNodeId)}#${Number(r.chunkIndex)}`;
    const byKey = new Map(rows.map((r) => [key(r), r]));
    expect(byKey.size).toBe(chunks.length);
    for (const k of chunks) {
      const r = byKey.get(key(k))!;
      expect([Number(r.start), Number(r.end), Number(r.tokenCount), r.chunkKey, Number(r.epoch), r.contentHash]).toEqual([k.start, k.end, k.tokenCount, k.chunkKey, c.epoch, c.contentHash]);
      expect(Buffer.from(r.vector as Uint8Array).equals(Buffer.from(k.vector))).toBe(true);
    }
    expect(await statusOf(t.db, c.conversationId)).toMatchObject({ state: "indexed", chunkCount: chunks.length });
  });

  it("a commit with a vector of the wrong length is rolled back completely", async () => {
    await importConv(normalized({ id: "c1" }));
    await doReconcile();
    const c = (await claim())!;
    const bad = [...chunksFor(3), { ...chunksFor(1)[0]!, chunkIndex: 99, vector: new Uint8Array(10) }];
    await expect(commit(c, bad)).rejects.toThrow();
    expect(await chunkCount(t.db)).toBe(0);
    expect(await statusOf(t.db, c.conversationId)).toMatchObject({ state: "running", claimToken: c.token });
  });

  it("I2 writes nothing for a conversation that does not exist, and refuses inside the import", async () => {
    await expect(tx((x) => invalidateConversation(x, "no-such-conversation"))).rejects.toThrow();
    expect(await t.db.embeddingStatus.count()).toBe(0);
  });
});

describe("the EmbeddingIndex singleton (condition C)", () => {
  it("Reconcile creates exactly one row with id 'main', never a second one", async () => {
    await importConv(normalized({ id: "c1" }));
    for (let i = 0; i < 3; i++) await doReconcile();
    const rows = await t.db.embeddingIndex.findMany();
    expect(rows.map((r) => r.id)).toEqual([INDEX_ROW_ID]);
    expect(rows[0]).toMatchObject({ epoch: 1, ...CONFIG, changeCounter: 0, lastErrorCode: null });
  });

  it("a row with another id makes the index unreadable and is removed by the next Reconcile, which rebuilds", async () => {
    await importConv(normalized({ id: "c1" }));
    await indexAll(2);
    expect((await openVectorReader(t.db, QUERY)).ok).toBe(true);
    await t.db.$executeRawUnsafe(
      `INSERT INTO "EmbeddingIndex" VALUES ('other', 1, ?, ?, ?, ?, ?, 0, NULL, ?)`,
      CONFIG.embeddingVersion, CONFIG.chunkerVersion, CONFIG.chunkTokens, CONFIG.quantization, CONFIG.dimensions, dbTimestamp(),
    );
    expect((await readIndexRow(t.db)).foreignRows).toBe(1);
    expect(await openVectorReader(t.db, QUERY)).toEqual({ ok: false, code: "INDEX_INCOMPATIBLE" });
    const before = (await indexRow(t.db))!.epoch as number;
    const r = await doReconcile();
    expect(r.rebuilt).toBe("singleton-repaired");
    expect((await t.db.embeddingIndex.findMany()).map((x) => x.id)).toEqual([INDEX_ROW_ID]);
    expect((await indexRow(t.db))!.epoch).toBe(before + 1);
    expect(await chunkCount(t.db)).toBe(0);
    expect(await statusOf(t.db, await idOf("c1"))).toMatchObject({ state: "pending", chunkCount: null });
  });

  it("a missing row is recreated above every stored epoch, with all chunks dropped", async () => {
    await importConv(normalized({ id: "c1" }));
    await indexAll(2);
    await doReconcile({ ...CONFIG, chunkerVersion: "x" });
    await doReconcile();
    expect((await indexRow(t.db))!.epoch).toBe(3);
    await indexAll(2);
    await t.db.$executeRawUnsafe(`DELETE FROM "EmbeddingIndex"`);
    expect(await openVectorReader(t.db, QUERY)).toEqual({ ok: false, code: "INDEX_EMPTY" });
    const r = await doReconcile();
    expect(r.rebuilt).toBe("created");
    expect((await indexRow(t.db))!.epoch).toBe(4);
    expect(await chunkCount(t.db)).toBe(0);
  });

  it("every store write addresses only the 'main' row", async () => {
    await importConv(normalized({ id: "c1", updateTime: 100 }));
    await indexAll(2);
    // A foreign row inserted after Reconcile is never touched by I2 or delete-all.
    await t.db.$executeRawUnsafe(`INSERT INTO "EmbeddingIndex" VALUES ('other', 7, 'e', 'c', 1, 'q', 1, 5, NULL, ?)`, dbTimestamp());
    const other = () => t.db.embeddingIndex.findUniqueOrThrow({ where: { id: "other" } }).then((r) => [r.epoch, r.changeCounter]);
    const main = (await indexRow(t.db))!;
    await importConv(normalized({ id: "c1", updateTime: 200, tag: "v2" })); // I2 deletes chunks: counter + 1
    expect(await other()).toEqual([7, 5]);
    expect((await indexRow(t.db))!.changeCounter).toBe((main.changeCounter as number) + 1);
    expect((await deleteAllImportedData({ writer: t.writer })).status).toBe("complete");
    expect(await other()).toEqual([7, 5]);
    expect((await indexRow(t.db))!.epoch).toBe((main.epoch as number) + 1);
  });
});

describe("C: invalidation for every import decision (I2 in the real import)", () => {
  it("case 5 (add) queues a pending row with the conversation's version, epoch 0 before the first Start", async () => {
    const r = await importConv(normalized({ id: "c1" }));
    expect(r.decision).toEqual({ kind: "add", case: 5 });
    const id = await idOf("c1");
    const c = await t.db.conversation.findUniqueOrThrow({ where: { id } });
    expect(await statusOf(t.db, id)).toMatchObject({ state: "pending", contentHash: c.contentHash, parserVersion: c.parserVersion, attempts: 0, chunkCount: null, claimToken: null, epoch: 0 });
  });

  it("case 5 after the first Start uses the current epoch", async () => {
    await importConv(normalized({ id: "c1" }));
    await doReconcile();
    await importConv(normalized({ id: "c2" }));
    expect(await statusOf(t.db, await idOf("c2"))).toMatchObject({ state: "pending", epoch: 1 });
  });

  it("case 8 (newer copy) resets an indexed row and deletes its chunks in the import transaction", async () => {
    await importConv(normalized({ id: "c1", updateTime: 100 }));
    await indexAll(3);
    const id = await idOf("c1");
    expect(await statusOf(t.db, id)).toMatchObject({ state: "indexed", chunkCount: 3 });
    const counter = (await indexRow(t.db))!.changeCounter as number;
    const r = await importConv(normalized({ id: "c1", updateTime: 200, tag: "v2" }));
    expect(r.decision).toEqual({ kind: "replace", case: 8 });
    const c = await t.db.conversation.findUniqueOrThrow({ where: { id } });
    expect(c.id).toBe(id); // replaced in place: the FK cascade does not fire
    expect(await statusOf(t.db, id)).toMatchObject({ state: "pending", contentHash: c.contentHash, chunkCount: null, attempts: 0, claimToken: null });
    expect(await chunkCount(t.db, id)).toBe(0);
    expect((await indexRow(t.db))!.changeCounter).toBe(counter + 1);
  });

  it("case 7 (parser-only reprocessing) keeps contentHash but changes the pair: completed row and vectors are invalidated", async () => {
    await importConv(normalized({ id: "c1" }));
    const id = await idOf("c1");
    // Simulate a conversation stored by an older parser, indexed under that version.
    await t.db.conversation.updateMany({ data: { parserVersion: "0.2.0" } });
    await t.db.$executeRawUnsafe(`UPDATE "EmbeddingStatus" SET "parserVersion" = '0.2.0'`);
    await indexAll(3);
    expect(await statusOf(t.db, id)).toMatchObject({ state: "indexed", chunkCount: 3, parserVersion: "0.2.0" });
    const before = await t.db.conversation.findUniqueOrThrow({ where: { id } });
    const r = await importConv(normalized({ id: "c1" }));
    expect(r.decision).toEqual({ kind: "replace", case: 7, code: "CONVERSATION_REPROCESSED" });
    const after = await t.db.conversation.findUniqueOrThrow({ where: { id } });
    expect(after.contentHash).toBe(before.contentHash); // the hash alone would not see it
    expect(after.parserVersion).not.toBe(before.parserVersion);
    expect(await statusOf(t.db, id)).toMatchObject({ state: "pending", parserVersion: after.parserVersion, chunkCount: null, attempts: 0 });
    expect(await chunkCount(t.db, id)).toBe(0);
    const rv = await openVectorReader(t.db, QUERY);
    expect(rv.ok && rv.rows).toEqual([]);
  });

  it("cases 6, 9, 10, 11, 12 and 13 write nothing and leave an indexed row and its chunks valid", async () => {
    await importConv(normalized({ id: "c1", updateTime: 200 }));
    await indexAll(3);
    const id = await idOf("c1");
    const snapshot = async () => json([await statusOf(t.db, id), await chunkCount(t.db, id), await indexRow(t.db), await t.db.message.findMany({ orderBy: { id: "asc" } })]);
    const before = await snapshot();
    const decisions = [
      await importConv(normalized({ id: "c1", updateTime: 200 })), // 6 unchanged
      await importConv(normalized({ id: "c1", updateTime: 100, tag: "old" })), // 9 older
      await importConv(normalized({ id: "c1", updateTime: 200, tag: "same-time" })), // 10 ambiguous
      await importConv(normalized({ id: "c1", updateTime: null, tag: "no-time" })), // 11 ambiguous time
    ].map((r) => r.decision.case);
    // 12: stored by a newer parser; 13: unrecognised stored hash.
    await t.db.conversation.updateMany({ data: { parserVersion: "9.0.0" } });
    await t.db.$executeRawUnsafe(`UPDATE "EmbeddingStatus" SET "parserVersion" = '9.0.0'`);
    await t.db.$executeRawUnsafe(`UPDATE "EmbeddingChunk" SET "parserVersion" = '9.0.0'`);
    decisions.push((await importConv(normalized({ id: "c1", updateTime: 300, tag: "v3" }))).decision.case);
    await t.db.conversation.updateMany({ data: { parserVersion: "0.3.0" } });
    await t.db.$executeRawUnsafe(`UPDATE "EmbeddingStatus" SET "parserVersion" = '0.3.0'`);
    await t.db.$executeRawUnsafe(`UPDATE "EmbeddingChunk" SET "parserVersion" = '0.3.0'`);
    const realHash = (await t.db.conversation.findMany({ select: { contentHash: true } }))[0]!.contentHash;
    await t.db.conversation.updateMany({ data: { contentHash: "v9:unknown" } });
    decisions.push((await importConv(normalized({ id: "c1", updateTime: 300, tag: "v3" }))).decision.case);
    await t.db.conversation.updateMany({ data: { contentHash: realHash } });
    expect(decisions).toEqual([6, 9, 10, 11, 12, 13]);
    expect(await snapshot()).toBe(before);
    const rv = await openVectorReader(t.db, QUERY);
    expect(rv.ok && rv.rows.length).toBe(3);
  });

  it.each(["afterRead", "afterDelete", "afterChunk", "afterInsert", "beforeCommit"] as const)(
    "an import failing at %s leaves the status row, chunks and index row unchanged (atomic with the messages)",
    async (stage) => {
      await importConv(normalized({ id: "c1", updateTime: 100 }));
      await indexAll(3);
      const id = await idOf("c1");
      const before = json([await statusOf(t.db, id), await chunkCount(t.db, id), await indexRow(t.db)]);
      await expect(importConv(normalized({ id: "c1", updateTime: 200, tag: "v2" }), stage)).rejects.toThrow();
      expect(json([await statusOf(t.db, id), await chunkCount(t.db, id), await indexRow(t.db)])).toBe(before);
      // An add that fails leaves no status row either.
      await expect(importConv(normalized({ id: "new" }), stage === "afterDelete" ? "afterInsert" : stage)).rejects.toThrow();
      expect(await t.db.embeddingStatus.count()).toBe(1);
    },
  );

  it("stale chunk rows that escaped I2 are still never returned by the reader (I6)", async () => {
    await importConv(normalized({ id: "c1", updateTime: 100 }));
    await indexAll(3);
    const id = await idOf("c1");
    const stale = await t.db.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM "EmbeddingChunk"`);
    await importConv(normalized({ id: "c1", updateTime: 200, tag: "v2" }));
    // Put the old rows back by hand, as if I2 had not run.
    for (const r of stale) {
      await t.db.$executeRawUnsafe(
        `INSERT INTO "EmbeddingChunk" VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        r.conversationId, r.contentHash, r.parserVersion, r.epoch, r.sourceNodeId, r.chunkIndex, r.start, r.end, r.tokenCount, r.chunkKey, r.vector,
      );
    }
    expect(await chunkCount(t.db, id)).toBe(3);
    const rv = await openVectorReader(t.db, QUERY);
    expect(rv.ok && rv.rows.length).toBe(0);
  });

  it.each(["case8", "case7"] as const)("a replacement during inference makes the in-flight commit stale (%s)", async (variant) => {
    const sid = `c-${variant}`;
    await importConv(normalized({ id: sid, updateTime: 100 }));
    if (variant === "case7") {
      await t.db.conversation.updateMany({ where: { sourceId: sid }, data: { parserVersion: "0.2.0" } });
      await t.db.$executeRawUnsafe(`UPDATE "EmbeddingStatus" SET "parserVersion" = '0.2.0'`);
    }
    await doReconcile();
    const c = (await claim())!;
    await importConv(normalized({ id: sid, updateTime: variant === "case8" ? 200 : 100, tag: variant === "case8" ? "v2" : "v1" }));
    expect(await readPage(t.db, c, 0, 1_000)).toBeNull(); // the next page stops at once
    expect(await commit(c, chunksFor(2))).toBe("stale");
    expect(await chunkCount(t.db, c.conversationId)).toBe(0);
    expect(await statusOf(t.db, c.conversationId)).toMatchObject({ state: "pending", claimToken: null, attempts: 0 });
  });
});

describe("D: explicit lifecycle cases", () => {
  it("zero-chunk completion: indexed with chunkCount 0 and never queued again", async () => {
    await importConv(normalized({ id: "empty", messages: 0 }));
    await importConv(normalized({ id: "full" }));
    await indexAll(0);
    expect(await statusOf(t.db, await idOf("empty"))).toMatchObject({ state: "indexed", chunkCount: 0 });
    for (let i = 0; i < 3; i++) expect((await doReconcile()).queued).toBe(0);
    expect(await claim()).toBeNull();
  });

  it("backfill: conversations imported before the migration are queued once", async () => {
    await importConv(normalized({ id: "c1" }));
    await importConv(normalized({ id: "c2" }));
    await t.db.$executeRawUnsafe(`DELETE FROM "EmbeddingStatus"`); // as before M5.1b
    expect((await doReconcile()).queued).toBe(2);
    expect((await doReconcile()).queued).toBe(0);
  });

  it("oversized (permanent): failed after one attempt, others indexed, never requeued by Start, keyword search finds it", async () => {
    await importConv(normalized({ id: "huge", tag: "zebracanary" }));
    await importConv(normalized({ id: "small", tag: "otter" }));
    await doReconcile();
    const huge = await idOf("huge");
    let claims = 0;
    for (let c = await claim(); c; c = await claim()) {
      claims++;
      if (c.conversationId === huge) expect(await tx((x) => releaseClaim(x, c, "permanent", "CONVERSATION_TOO_LARGE"))).toBe(1);
      else expect(await commit(c, chunksFor(2))).toBe("committed");
    }
    expect(claims).toBe(2);
    expect(await statusOf(t.db, huge)).toMatchObject({ state: "failed", lastErrorCode: "CONVERSATION_TOO_LARGE", attempts: 1 });
    expect(await statusOf(t.db, await idOf("small"))).toMatchObject({ state: "indexed" });
    expect((await doReconcile()).queued).toBe(0);
    const s = await searchConversations(t.db, "zebracanary", undefined);
    expect(s.status === "ok" && s.results.map((r) => r.conversationId)).toEqual([huge]);
  });

  it("recoverable failures: failed after exactly 3 claims, the others continue; retry resets and keeps the code", async () => {
    await importConv(normalized({ id: "poison" }));
    await importConv(normalized({ id: "ok1" }));
    await importConv(normalized({ id: "ok2" }));
    await doReconcile();
    const poison = await idOf("poison");
    let claims = 0;
    for (let c = await claim(); c; c = await claim()) {
      claims++;
      if (c.conversationId === poison) await tx((x) => releaseClaim(x, c, "recoverable", "INFERENCE_FAILED"));
      else await commit(c, chunksFor(1));
    }
    expect(claims).toBe(2 + MAX_ATTEMPTS);
    expect(await statusOf(t.db, poison)).toMatchObject({ state: "failed", attempts: 3, lastErrorCode: "INFERENCE_FAILED" });
    expect(await tx((x) => retryFailed(x))).toBe(1);
    expect(await statusOf(t.db, poison)).toMatchObject({ state: "pending", attempts: 0, lastErrorCode: "INFERENCE_FAILED" });
  });

  it("attempt accounting: a refund gives the attempt back; a worker crash keeps it", async () => {
    await importConv(normalized({ id: "c1" }));
    await doReconcile();
    const id = await idOf("c1");
    for (let i = 0; i < 5; i++) {
      const c = (await claim())!;
      await tx((x) => releaseClaim(x, c, "refund", "MODEL_MISSING"));
    }
    expect(await statusOf(t.db, id)).toMatchObject({ state: "pending", attempts: 0, lastErrorCode: "MODEL_MISSING" });
    for (let i = 0; i < 3; i++) {
      const c = (await claim())!;
      await tx((x) => releaseClaim(x, c, "worker-crash", "WORKER_FAILED"));
    }
    expect(await statusOf(t.db, id)).toMatchObject({ state: "failed", attempts: 3 });
  });

  it("a release with a cleared token changes nothing", async () => {
    await importConv(normalized({ id: "c1", updateTime: 100 }));
    await doReconcile();
    const c = (await claim())!;
    await importConv(normalized({ id: "c1", updateTime: 200, tag: "v2" }));
    expect(await tx((x) => releaseClaim(x, c, "permanent", "CONVERSATION_TOO_LARGE"))).toBe(0);
    expect(await statusOf(t.db, c.conversationId)).toMatchObject({ state: "pending", attempts: 0, lastErrorCode: null });
  });

  it("a crash mid-inference leaves a running row; it counts as an attempt and is reset at the next Start (I5)", async () => {
    await importConv(normalized({ id: "c1" }));
    await doReconcile();
    await claim(); // the process dies here
    expect(await statusOf(t.db, await idOf("c1"))).toMatchObject({ state: "running", attempts: 1 });
    expect((await doReconcile()).reset).toBe(1);
    expect(await statusOf(t.db, await idOf("c1"))).toMatchObject({ state: "pending", attempts: 1, claimToken: null });
  });

  it("A→B→A during one inference: the commit is refused by the token although the versions match again", async () => {
    // Through the real import an exact return to an earlier version is impossible (the v1
    // hash covers update_time and older copies are refused), so I2 is driven directly.
    await importConv(normalized({ id: "c1" }));
    await doReconcile();
    const c = (await claim())!;
    const id = c.conversationId;
    await tx(async (x) => {
      await x.$executeRawUnsafe(`UPDATE "Conversation" SET "contentHash" = 'v1:' || hex(randomblob(32)) WHERE "id" = ?`, id); // B
      await invalidateConversation(x, id);
    });
    await tx(async (x) => {
      await x.$executeRawUnsafe(`UPDATE "Conversation" SET "contentHash" = ? WHERE "id" = ?`, c.contentHash, id); // back to A
      await invalidateConversation(x, id);
    });
    expect(await statusOf(t.db, id)).toMatchObject({ contentHash: c.contentHash, parserVersion: c.parserVersion, state: "pending" });
    expect(await commit(c, chunksFor(2))).toBe("stale");
    expect(await chunkCount(t.db, id)).toBe(0);
    const again = (await claim())!;
    expect(again.token).not.toBe(c.token);
    expect(await commit(again, chunksFor(2))).toBe("committed");
  });

  it("delete-all during inference: the commit is refused (conversation and status gone, epoch increased)", async () => {
    await importConv(normalized({ id: "c1" }));
    await doReconcile();
    const c = (await claim())!;
    const e0 = (await indexRow(t.db))!.epoch as number;
    expect((await deleteAllImportedData({ writer: t.writer })).status).toBe("complete");
    expect((await indexRow(t.db))!.epoch).toBe(e0 + 1);
    expect(await commit(c, chunksFor(2))).toBe("stale");
    expect(await chunkCount(t.db)).toBe(0);
    // Re-importing the same export during the old run never revives the old claim.
    await importConv(normalized({ id: "c1" }));
    expect(await commit(c, chunksFor(2))).toBe("stale");
    expect(await statusOf(t.db, await idOf("c1"))).toMatchObject({ state: "pending", epoch: e0 + 1 });
  });

  it("model-version incompatibility: the reader returns nothing before Reconcile, for each of the five fields", async () => {
    await importConv(normalized({ id: "c1" }));
    await indexAll(2);
    expect((await openVectorReader(t.db, QUERY)).ok).toBe(true);
    const variants: Partial<IndexConfig>[] = [
      { embeddingVersion: CONFIG.embeddingVersion.replace("761b726d", "aaaaaaaa") },
      { chunkerVersion: "sentence-pack-v2" },
      { chunkTokens: 128 },
      { quantization: "int8-absmax-v2" },
      { dimensions: 768 },
    ];
    for (const v of variants) {
      const code = { ...CONFIG, ...v };
      expect(await openVectorReader(t.db, code, code)).toEqual({ ok: false, code: "INDEX_INCOMPATIBLE" });
    }
    // The rows' epoch still matches: only the configuration check refuses them.
    expect((await indexRow(t.db))!.epoch).toBe(1);
    expect(await openVectorReader(t.db, { ...QUERY, embeddingVersion: "other" })).toEqual({ ok: false, code: "INDEX_INCOMPATIBLE" });
    expect(await openVectorReader(t.db, { ...QUERY, chunkerVersion: "other" })).toEqual({ ok: false, code: "INDEX_INCOMPATIBLE" });
  });

  it("model-version change: Reconcile drops all chunks, bumps the epoch, requeues indexed and failed rows; an old worker cannot commit", async () => {
    await importConv(normalized({ id: "c1" }));
    await importConv(normalized({ id: "c2" }));
    await indexAll(2);
    await t.db.$executeRawUnsafe(`UPDATE "EmbeddingStatus" SET "state" = 'failed', "attempts" = 3 WHERE "conversationId" = ?`, await idOf("c2"));
    const e0 = (await indexRow(t.db))!.epoch as number;
    const next = { ...CONFIG, embeddingVersion: CONFIG.embeddingVersion + "-next" };
    const r = await doReconcile(next);
    expect(r.rebuilt).toBe("config-changed");
    expect(await chunkCount(t.db)).toBe(0);
    expect((await indexRow(t.db))!.epoch).toBe(e0 + 1);
    expect((await t.db.embeddingStatus.findMany()).map((s) => [s.state, s.attempts])).toEqual([["pending", 0], ["pending", 0]]);
    const c = (await claim())!;
    expect(await commit(c, chunksFor(1), CONFIG)).toBe("stale");
    expect(await commit(c, chunksFor(1), next)).toBe("committed");
  });

  it("the reader skips and counts malformed vectors, and hides rows from an old epoch or version", async () => {
    await importConv(normalized({ id: "c1" }));
    await indexAll(2);
    const id = await idOf("c1");
    await t.db.$executeRawUnsafe(`UPDATE "EmbeddingChunk" SET "vector" = x'0102' WHERE "chunkIndex" = 0 AND "sourceNodeId" = 'n1'`);
    const r1 = await openVectorReader(t.db, QUERY);
    expect(r1.ok && [r1.rows.length, r1.skipped]).toEqual([1, 1]);
    await t.db.$executeRawUnsafe(`UPDATE "EmbeddingChunk" SET "epoch" = "epoch" - 1 WHERE "conversationId" = ? AND "sourceNodeId" = 'n2'`, id);
    const r2 = await openVectorReader(t.db, QUERY);
    expect(r2.ok && r2.rows.length).toBe(0);
  });

  it("the defensive resync requeues a row whose version differs from its conversation and drops its chunks", async () => {
    await importConv(normalized({ id: "c1" }));
    await indexAll(2);
    const id = await idOf("c1");
    await t.db.$executeRawUnsafe(`UPDATE "Conversation" SET "contentHash" = 'v1:other' WHERE "id" = ?`, id);
    const r = await doReconcile();
    expect(r.resynced).toBe(1);
    expect(await statusOf(t.db, id)).toMatchObject({ state: "pending", contentHash: "v1:other" });
    expect(await chunkCount(t.db, id)).toBe(0);
  });
});

describe("T2 compare-and-set: every guarded field on its own (final verification, item 1)", () => {
  type Mutation = { sql?: string; worker?: Partial<IndexConfig> };
  const cases: [string, Mutation][] = [
    ["claim token", { sql: `UPDATE "EmbeddingStatus" SET "claimToken" = 'another-token' WHERE "conversationId" = ?` }],
    ["status state", { sql: `UPDATE "EmbeddingStatus" SET "state" = 'pending' WHERE "conversationId" = ?` }],
    ["status contentHash", { sql: `UPDATE "EmbeddingStatus" SET "contentHash" = 'v1:other' WHERE "conversationId" = ?` }],
    ["status parserVersion", { sql: `UPDATE "EmbeddingStatus" SET "parserVersion" = '9.9.9' WHERE "conversationId" = ?` }],
    ["status epoch", { sql: `UPDATE "EmbeddingStatus" SET "epoch" = "epoch" + 1 WHERE "conversationId" = ?` }],
    ["conversation contentHash", { sql: `UPDATE "Conversation" SET "contentHash" = 'v1:other' WHERE "id" = ?` }],
    ["conversation parserVersion", { sql: `UPDATE "Conversation" SET "parserVersion" = '9.9.9' WHERE "id" = ?` }],
    ["conversation deleted", { sql: `DELETE FROM "Conversation" WHERE "id" = ?` }],
    ["index epoch", { sql: `UPDATE "EmbeddingIndex" SET "epoch" = "epoch" + 1 WHERE ? IS NOT NULL` }],
    ["index row missing", { sql: `DELETE FROM "EmbeddingIndex" WHERE ? IS NOT NULL` }],
    ["index row under another id", { sql: `UPDATE "EmbeddingIndex" SET "id" = 'other' WHERE ? IS NOT NULL` }],
    ["stored embeddingVersion", { sql: `UPDATE "EmbeddingIndex" SET "embeddingVersion" = 'other' WHERE ? IS NOT NULL` }],
    ["stored chunkerVersion", { sql: `UPDATE "EmbeddingIndex" SET "chunkerVersion" = 'other' WHERE ? IS NOT NULL` }],
    ["stored chunkTokens", { sql: `UPDATE "EmbeddingIndex" SET "chunkTokens" = "chunkTokens" + 1 WHERE ? IS NOT NULL` }],
    ["stored quantization", { sql: `UPDATE "EmbeddingIndex" SET "quantization" = 'other' WHERE ? IS NOT NULL` }],
    ["stored dimensions", { sql: `UPDATE "EmbeddingIndex" SET "dimensions" = "dimensions" + 1 WHERE ? IS NOT NULL` }],
    ["worker embeddingVersion", { worker: { embeddingVersion: "other" } }],
    ["worker chunkerVersion", { worker: { chunkerVersion: "other" } }],
    ["worker chunkTokens", { worker: { chunkTokens: CONFIG.chunkTokens + 1 } }],
    ["worker quantization", { worker: { quantization: "other" } }],
  ];

  async function setup() {
    await importConv(normalized({ id: "other" }));
    await indexAll(2); // another conversation's committed rows must never change
    await importConv(normalized({ id: "c1" }));
    const c = (await claim())!;
    expect(c.conversationId).toBe(await idOf("c1"));
    return c;
  }

  it("control: with nothing changed the same commit succeeds", async () => {
    const c = await setup();
    expect(await commit(c, chunksFor(2))).toBe("committed");
    expect(await chunkCount(t.db, c.conversationId)).toBe(2);
  });

  it.each(cases)("a different %s makes the commit stale and writes nothing", async (_name, m) => {
    const c = await setup();
    if (m.sql) await t.db.$executeRawUnsafe(m.sql, c.conversationId);
    const before = { chunks: await chunkDump(t.db), status: await statusOf(t.db, c.conversationId), index: await indexRow(t.db) };
    expect(await commit(c, chunksFor(2), { ...CONFIG, ...m.worker })).toBe("stale");
    expect(await chunkCount(t.db, c.conversationId)).toBe(0);
    expect({ chunks: await chunkDump(t.db), status: await statusOf(t.db, c.conversationId), index: await indexRow(t.db) }).toEqual(before);
  });
});

describe("bulk chunk insert (final verification, item 2)", () => {
  /** Row k: every field and every vector byte derived from k (the first four bytes are k). */
  const rowFor = (k: number): ChunkRow => {
    const vector = new Uint8Array(VECTOR_BYTES);
    new DataView(vector.buffer).setUint32(0, k, true);
    for (let i = 4; i < VECTOR_BYTES; i++) vector[i] = (k * 131 + i * 17 + (k >> 8)) & 0xff;
    return { sourceNodeId: `m${k % 7}`, chunkIndex: Math.floor(k / 7), start: k, end: k + 1 + (k % 5), tokenCount: 1 + (k % 64), chunkKey: k.toString(16).padStart(32, "0"), vector };
  };
  const inOrder = (n: number) => Array.from({ length: n }, (_, k) => rowFor(k));
  /** All of 0..n-1 in a scrambled order (7919 is prime and divides none of the sizes used). */
  const shuffled = (n: number) => Array.from({ length: n }, (_, i) => rowFor((i * 7919) % n));

  /** Number of stored rows of the conversation that differ in any way from rowFor(k), k read from the vector. */
  async function mismatches(conversationId: string, n: number, c: Claim): Promise<number> {
    const rows = await t.db.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT "sourceNodeId", "chunkIndex", "start", "end", "tokenCount", "chunkKey", "vector", "epoch", "contentHash", "parserVersion"
       FROM "EmbeddingChunk" WHERE "conversationId" = ?`,
      conversationId,
    );
    expect(rows.length).toBe(n);
    const [types] = await t.db.$queryRawUnsafe<{ bad: bigint }[]>(
      `SELECT COUNT(*) AS bad FROM "EmbeddingChunk" WHERE "conversationId" = ? AND NOT (typeof("sourceNodeId") = 'text' AND typeof("chunkIndex") = 'integer'
         AND typeof("start") = 'integer' AND typeof("end") = 'integer' AND typeof("tokenCount") = 'integer' AND typeof("chunkKey") = 'text'
         AND typeof("vector") = 'blob' AND length("vector") = ?)`,
      conversationId, VECTOR_BYTES,
    );
    expect(Number(types!.bad)).toBe(0);
    const seen = new Set<number>();
    let bad = 0;
    for (const r of rows) {
      const v = Buffer.from(r.vector as Uint8Array);
      const k = v.readUInt32LE(0);
      const e = rowFor(k);
      const same =
        k < n && !seen.has(k) && r.sourceNodeId === e.sourceNodeId && Number(r.chunkIndex) === e.chunkIndex && Number(r.start) === e.start &&
        Number(r.end) === e.end && Number(r.tokenCount) === e.tokenCount && r.chunkKey === e.chunkKey && v.equals(Buffer.from(e.vector)) &&
        Number(r.epoch) === c.epoch && r.contentHash === c.contentHash && r.parserVersion === c.parserVersion;
      seen.add(k);
      if (!same) bad++;
    }
    return bad;
  }

  /** c1 committed with three rows, then claimed again with those rows still stored (requeued by hand). */
  async function claimOverOldRows() {
    await importConv(normalized({ id: "c1" }));
    await indexAll(3);
    await t.db.$executeRawUnsafe(`UPDATE "EmbeddingStatus" SET "state" = 'pending', "claimToken" = NULL`);
    const c = (await claim())!;
    return { c, chunks: await chunkDump(t.db), status: await statusOf(t.db, c.conversationId), index: await indexRow(t.db) };
  }
  async function expectUnchanged(s: Awaited<ReturnType<typeof claimOverOldRows>>) {
    expect(await chunkDump(t.db)).toEqual(s.chunks);
    expect(await statusOf(t.db, s.c.conversationId)).toEqual(s.status);
    expect(await indexRow(t.db)).toEqual(s.index);
  }

  it("every row keeps its own metadata and vector across statement boundaries, in any input order", async () => {
    expect(INSERT_ROWS_PER_STATEMENT).toBe(1_000);
    await doReconcile();
    for (const n of [0, 1, 2, 999, 1_000, 1_001, 2_000, 2_001]) {
      for (const order of [inOrder, shuffled]) {
        await importConv(normalized({ id: `n${n}-${order.name}` }));
        const c = (await claim())!;
        expect(await commit(c, order(n))).toBe("committed");
        expect(await mismatches(c.conversationId, n, c), `${n} ${order.name}`).toBe(0);
        expect(await statusOf(t.db, c.conversationId)).toMatchObject({ state: "indexed", chunkCount: n });
      }
    }
    const rv = await openVectorReader(t.db, QUERY);
    expect(rv.ok && rv.skipped).toBe(0);
  }, 60_000);

  it(`exactly ${MAX_CHUNKS_PER_CONVERSATION} rows commit exactly; ${MAX_CHUNKS_PER_CONVERSATION + 1} are refused before any write`, async () => {
    await importConv(normalized({ id: "cap" }));
    await doReconcile();
    const c = (await claim())!;
    const before = await indexRow(t.db);
    await expect(commit(c, shuffled(MAX_CHUNKS_PER_CONVERSATION + 1))).rejects.toThrow("invalid chunk rows");
    expect(await chunkCount(t.db)).toBe(0);
    expect(await statusOf(t.db, c.conversationId)).toMatchObject({ state: "running", claimToken: c.token });
    expect(await indexRow(t.db)).toEqual(before);
    expect(await commit(c, shuffled(MAX_CHUNKS_PER_CONVERSATION))).toBe("committed");
    expect(await mismatches(c.conversationId, MAX_CHUNKS_PER_CONVERSATION, c)).toBe(0);
  }, 60_000);

  it("a failure in a later statement rolls the whole commit back: earlier statements, the delete of the old rows and the status change", async () => {
    const s = await claimOverOldRows();
    // Row 1,700 is in the second statement; the first (rows 0–999) has already run when it fails.
    await t.db.$executeRawUnsafe(`CREATE TRIGGER "test_fail_late" BEFORE INSERT ON "EmbeddingChunk" WHEN NEW."start" = 1700 BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    try {
      await expect(commit(s.c, inOrder(2_500))).rejects.toThrow();
    } finally {
      await t.db.$executeRawUnsafe(`DROP TRIGGER "test_fail_late"`);
    }
    await expectUnchanged(s);
    expect(await commit(s.c, inOrder(2_500))).toBe("committed"); // the claim is still valid
    expect(await mismatches(s.c.conversationId, 2_500, s.c)).toBe(0);
  });

  const malformed: [string, (rows: ChunkRow[]) => ChunkRow[]][] = [
    ["a vector one byte short in a later statement", (r) => r.map((x, i) => (i === 1_500 ? { ...x, vector: x.vector.subarray(1) } : x))],
    ["a vector one byte long", (r) => r.map((x, i) => (i === 1_500 ? { ...x, vector: new Uint8Array(VECTOR_BYTES + 1) } : x))],
    ["a vector that is not bytes", (r) => r.map((x, i) => (i === 1_500 ? { ...x, vector: Array.from(x.vector) as unknown as Uint8Array } : x))],
    ["a duplicate key", (r) => [...r, { ...r[10]!, vector: r[11]!.vector }]],
    ["a fractional offset", (r) => r.map((x, i) => (i === 1_500 ? { ...x, start: 1.5 } : x))],
    ["a NaN offset", (r) => r.map((x, i) => (i === 1_500 ? { ...x, end: Number.NaN } : x))],
    ["a numeric string offset", (r) => r.map((x, i) => (i === 1_500 ? { ...x, start: "5" as unknown as number } : x))],
    ["a negative chunk index", (r) => r.map((x, i) => (i === 1_500 ? { ...x, chunkIndex: -1 } : x))],
    ["an empty range", (r) => r.map((x, i) => (i === 1_500 ? { ...x, end: x.start } : x))],
    ["an empty node id", (r) => r.map((x, i) => (i === 1_500 ? { ...x, sourceNodeId: "" } : x))],
    ["an empty chunk key", (r) => r.map((x, i) => (i === 1_500 ? { ...x, chunkKey: "" } : x))],
  ];
  it.each(malformed)("refuses %s before any write", async (_name, mutate) => {
    const s = await claimOverOldRows();
    await expect(commit(s.c, mutate(inOrder(2_500)))).rejects.toThrow("invalid chunk rows");
    await expectUnchanged(s);
  });

  it("zero chunks: the conversation's earlier rows are removed and 0 is recorded, in the same transaction", async () => {
    const s = await claimOverOldRows();
    expect(await chunkCount(t.db, s.c.conversationId)).toBe(3);
    expect(await commit(s.c, [])).toBe("committed");
    expect(await chunkCount(t.db, s.c.conversationId)).toBe(0);
    expect(await statusOf(t.db, s.c.conversationId)).toMatchObject({ state: "indexed", chunkCount: 0, claimToken: null });
    expect((await indexRow(t.db))!.changeCounter).toBe((s.index!.changeCounter as number) + 1);
  });
});
