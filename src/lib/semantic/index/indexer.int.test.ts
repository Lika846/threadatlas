/**
 * The indexer (M5.1b-1) end to end on migrated temporary databases: the real import,
 * delete-all and keyword search, and a deterministic fake embedder running the real
 * worker message loop in a real worker thread (tests/helpers/fake-index-worker.mts).
 * Synthetic data only.
 *
 * Set THREADATLAS_INDEX_REPORT=<file> to write the measured numbers (commit duration
 * and memory at the chunk cap, event-loop gaps) as JSON; this also asserts the 500 ms
 * commit target, so run the cap test alone (`-t "exactly 20000"`) in that mode.
 */
import fs from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { importText } from "../../../../tests/helpers/import";
import {
  chunkCount,
  chunkDump,
  chunkDumpBySource,
  conversationId,
  conversationWithTexts,
  fakeIndexEmbedder,
  indexRow,
  indexWith,
  newLog,
  statusOf,
  statusRows,
} from "../../../../tests/helpers/semantic-index";
import { exportText, syntheticConversation, syntheticExport } from "../../../../tests/helpers/synthetic-export";
import { createTestDb, type TestDb } from "../../../../tests/helpers/test-db";
import { deleteAllImportedData } from "../../data/delete-all";
import { runWriterTransaction } from "../../db/transaction-recovery";
import { acquireWriteLock, IMPORT_LOCK_WAIT_MS } from "../../db/write-lock";
import { searchConversations } from "../../search/search";
import type { Chunk } from "../chunker";
import { EmbeddingError } from "../errors";
import { LIMITS } from "../protocol";
import { CODE_INDEX_CONFIG, MAX_CHUNKS_PER_CONVERSATION, PAGE_MAX_MESSAGES, WINDOW_CHUNKS } from "./config";
import { planPages, type IndexEmbedder, type IndexerResult } from "./indexer";
import { openVectorReader } from "./reader";
import { invalidateConversation, type Sql } from "./store";

const QUERY = { embeddingVersion: CODE_INDEX_CONFIG.embeddingVersion, chunkerVersion: CODE_INDEX_CONFIG.chunkerVersion };
const report: Record<string, unknown> = {};

let t: TestDb;
beforeEach(() => {
  t = createTestDb();
});
afterEach(async () => {
  await t.cleanup();
});
afterAll(() => {
  const out = process.env.THREADATLAS_INDEX_REPORT;
  if (out) fs.writeFileSync(out, JSON.stringify(report, null, 1));
});

const importConvs = async (convs: unknown[]) => {
  const r = await importText(exportText(convs), { writer: t.writer });
  expect(r.complete).toBe(true);
  return r;
};

/** A sentence of exactly `n` words: with the fake tokenizer (words) and the 64-token budget, one 40-word sentence = one chunk. */
const sentence = (k: number, n = 40) => `${Array.from({ length: n - 1 }, (_, i) => `w${(k + i) % 97}`).join(" ")} end${k}.`;
const sentences = (count: number, from = 0) => Array.from({ length: count }, (_, i) => sentence(from + i)).join(" ");

function expectStatus(r: IndexerResult, status: IndexerResult["status"]) {
  expect(r.status, JSON.stringify(r)).toBe(status);
}

/** Every committed chunk's offsets fit its message's current text. */
async function offsetsFit(): Promise<boolean> {
  const rows = await t.db.$queryRawUnsafe<{ ok: bigint }[]>(
    `SELECT COUNT(*) AS ok FROM "EmbeddingChunk" ch JOIN "Message" m ON m."conversationId" = ch."conversationId" AND m."sourceNodeId" = ch."sourceNodeId"
     WHERE ch."start" >= 0 AND ch."end" <= length(m."contentText") AND ch."start" < ch."end" AND trim(substr(m."contentText", ch."start" + 1, ch."end" - ch."start")) <> ''`,
  );
  return Number(rows[0]!.ok) === (await chunkCount(t.db));
}

describe("pages", () => {
  it("are cut at message boundaries by message count and characters, in path order", () => {
    const m = (i: number, chars: number) => ({ sourceNodeId: `n${i}`, pathIndex: i, chars });
    const many = Array.from({ length: 450 }, (_, i) => m(i, 10));
    expect(planPages(many).map((p) => p.messages.length)).toEqual([PAGE_MAX_MESSAGES, PAGE_MAX_MESSAGES, 50]);
    expect(planPages([m(0, 600_000), m(1, 600_000), m(2, 1)]).map((p) => [p.from, p.to])).toEqual([[0, 0], [1, 2]]);
    expect(planPages([])).toEqual([]);
  });
});

describe("indexing lifecycle (fake embedder in a real worker)", () => {
  it("indexes every conversation, commits the full chunk set and makes it readable", async () => {
    await importConvs(syntheticExport(5, { messages: 6, textLength: 300 }));
    const r = await indexWith(t);
    expectStatus(r, "finished");
    expect(r.status === "finished" && r.stats).toMatchObject({ claimed: 5, indexed: 5, failed: 0, staleDiscards: 0 });
    expect((await statusRows(t.db)).map((s) => s.state)).toEqual(Array(5).fill("indexed"));
    const total = await chunkCount(t.db);
    expect(total).toBeGreaterThan(0);
    expect(r.status === "finished" && r.stats.chunks).toBe(total);
    expect((await statusRows(t.db)).reduce((n, s) => n + (s.chunkCount as number), 0)).toBe(total);
    const rv = await openVectorReader(t.db, QUERY);
    expect(rv.ok && [rv.rows.length, rv.skipped]).toEqual([total, 0]);
    expect(await offsetsFit()).toBe(true);
    expect(await indexRow(t.db)).toMatchObject({ epoch: 1, changeCounter: 5, lastErrorCode: null });
    // A second run has nothing to do.
    const again = await indexWith(t);
    expect(again.status === "finished" && again.stats.claimed).toBe(0);
  });

  it("backfills conversations imported before the migration, once", async () => {
    await importConvs(syntheticExport(3));
    await t.db.$executeRawUnsafe(`DELETE FROM "EmbeddingStatus"`); // as before M5.1b
    const r = await indexWith(t);
    expect(r.status === "finished" && [r.stats.reconcile?.queued, r.stats.indexed]).toEqual([3, 3]);
    const again = await indexWith(t);
    expect(again.status === "finished" && [again.stats.reconcile?.queued, again.stats.claimed]).toEqual([0, 0]);
  });

  it("zero eligible messages (structural only, hidden only, whitespace only): indexed with 0 chunks, never queued again", async () => {
    await importConvs([
      syntheticConversation({ id: "structural", messages: 0 }),
      syntheticConversation({ id: "hidden", messages: 3, messageExtra: { metadata: { is_visually_hidden_from_conversation: true } } }),
      syntheticConversation({ id: "blank", messages: 2, messageExtra: { content: { content_type: "text", parts: ["  \n\t  "] } } }),
      syntheticConversation({ id: "normal", messages: 2 }),
    ]);
    expectStatus(await indexWith(t), "finished");
    for (const sid of ["structural", "hidden", "blank"]) {
      expect(await statusOf(t.db, await conversationId(t.db, sid))).toMatchObject({ state: "indexed", chunkCount: 0, attempts: 1 });
    }
    expect(await chunkCount(t.db, await conversationId(t.db, "normal"))).toBeGreaterThan(0);
    for (let i = 0; i < 3; i++) {
      const r = await indexWith(t);
      expect(r.status === "finished" && [r.stats.reconcile?.queued, r.stats.claimed]).toEqual([0, 0]);
    }
  });

  it("pages and windows: a conversation over several pages and windows gives bit-identical vectors on reindex", async () => {
    // 450 messages × 2 chunks: pages of 200/200/50 messages, windows of 256/144 chunks per full page.
    await importConvs([conversationWithTexts("long", Array.from({ length: 450 }, (_, i) => sentences(2, i * 2)))]);
    const pages: number[] = [];
    const windows: number[] = [];
    const r = await indexWith(t, { hooks: { beforePage: (_c, p) => void pages.push(p), afterWindow: (_c, w) => void windows.push(w) } });
    expectStatus(r, "finished");
    expect(pages).toEqual([0, 1, 2]);
    expect(windows).toHaveLength(5); // 400 → 256 + 144, twice, then 100
    expect(await chunkCount(t.db)).toBe(900);
    const first = await chunkDump(t.db);
    // Force a full reindex: a configuration change, then back.
    await t.db.$executeRawUnsafe(`UPDATE "EmbeddingIndex" SET "chunkerVersion" = 'old'`);
    expectStatus(await indexWith(t), "finished");
    expect(await chunkDump(t.db)).toEqual(first);
    expect(WINDOW_CHUNKS).toBe(256);
  });

  it("cancel and resume end with exactly the chunk set of a full rebuild", async () => {
    const convs = syntheticExport(6, { messages: 8, textLength: 500 });
    await importConvs(convs);
    const ac = new AbortController();
    let commits = 0;
    const paused = await indexWith(t, { signal: ac.signal, hooks: { afterCommit: () => void (++commits === 2 && ac.abort()) } });
    expectStatus(paused, "paused");
    expect((await statusRows(t.db)).filter((s) => s.state === "indexed")).toHaveLength(2);
    expect((await statusRows(t.db)).filter((s) => s.state === "running")).toHaveLength(0);
    expectStatus(await indexWith(t), "finished");
    const resumed = await chunkDumpBySource(t.db);
    // A full rebuild of the same export in another database.
    const other = createTestDb();
    try {
      expect((await importText(exportText(convs), { writer: other.writer })).complete).toBe(true);
      const r = await runIndexerOn(other);
      expectStatus(r, "finished");
      expect(await chunkDumpBySource(other.db)).toEqual(resumed);
    } finally {
      await other.cleanup();
    }
  });

  it("pause during a batch: the batch finishes, the row goes back to pending with no attempt, nothing partial is written", async () => {
    await importConvs([conversationWithTexts("slow", Array.from({ length: 20 }, (_, i) => sentences(4, i * 4)))]); // 80 chunks, 5 batches
    const log = newLog();
    const ac = new AbortController();
    const r = await indexWith(t, {
      signal: ac.signal,
      worker: { batchDelayMs: 60, log },
      hooks: { afterClaim: () => void setTimeout(() => ac.abort(), 90) },
    });
    expectStatus(r, "paused");
    expect(log[0]).toBeGreaterThan(0);
    expect(log[0]).toBeLessThan(5);
    expect(log[0]).toBe(log[1]); // every started batch finished
    expect(log[3]).toBe(1); // the worker released its session (drained, not terminated)
    const id = await conversationId(t.db, "slow");
    expect(await statusOf(t.db, id)).toMatchObject({ state: "pending", attempts: 0, claimToken: null });
    expect(await chunkCount(t.db)).toBe(0);
  });

  it("an already-aborted signal pauses before claiming anything", async () => {
    await importConvs(syntheticExport(2));
    const ac = new AbortController();
    ac.abort();
    expectStatus(await indexWith(t, { signal: ac.signal }), "paused");
    expect((await statusRows(t.db)).map((s) => [s.state, s.attempts])).toEqual([["pending", 0], ["pending", 0]]);
  });
});

describe("stale vectors cannot reappear", () => {
  it("replacement during inference: the commit is discarded and only the new version is indexed", async () => {
    await importConvs([syntheticConversation({ id: "c1", messages: 4, updateTime: 100, tag: "old" })]);
    let replaced = false;
    const r = await indexWith(t, {
      hooks: {
        beforeCommit: async () => {
          if (replaced) return;
          replaced = true;
          await importConvs([syntheticConversation({ id: "c1", messages: 6, updateTime: 200, tag: "new" })]);
        },
      },
    });
    expect(r.status === "finished" && [r.stats.staleDiscards, r.stats.indexed]).toEqual([1, 1]);
    const id = await conversationId(t.db, "c1");
    const c = await t.db.conversation.findUniqueOrThrow({ where: { id } });
    expect(await statusOf(t.db, id)).toMatchObject({ state: "indexed", contentHash: c.contentHash, attempts: 1 });
    const kept = await t.db.$queryRawUnsafe<{ h: string }[]>(`SELECT DISTINCT "contentHash" AS h FROM "EmbeddingChunk"`);
    expect(kept.map((x) => x.h)).toEqual([c.contentHash]);
    expect(await chunkCount(t.db)).toBe(6);
    expect(await offsetsFit()).toBe(true);
  });

  it("reprocessed during inference (same contentHash, newer parser): the commit is discarded", async () => {
    const conv = syntheticConversation({ id: "c1", messages: 3 });
    await importConvs([conv]);
    const id = await conversationId(t.db, "c1");
    await t.db.conversation.update({ where: { id }, data: { parserVersion: "0.2.0" } }); // stored by an older parser
    await t.db.$executeRawUnsafe(`UPDATE "EmbeddingStatus" SET "parserVersion" = '0.2.0'`);
    const hash = (await t.db.conversation.findUniqueOrThrow({ where: { id } })).contentHash;
    let reprocessed = false;
    const r = await indexWith(t, {
      hooks: {
        beforeCommit: async () => {
          if (reprocessed) return;
          reprocessed = true;
          const out = await importConvs([conv]);
          expect(out.counts.updated).toBe(1);
        },
      },
    });
    expect(r.status === "finished" && [r.stats.staleDiscards, r.stats.indexed]).toEqual([1, 1]);
    const c = await t.db.conversation.findUniqueOrThrow({ where: { id } });
    expect(c.contentHash).toBe(hash);
    expect(c.parserVersion).not.toBe("0.2.0");
    const rows = await t.db.$queryRawUnsafe<{ p: string }[]>(`SELECT DISTINCT "parserVersion" AS p FROM "EmbeddingChunk"`);
    expect(rows.map((x) => x.p)).toEqual([c.parserVersion]);
  });

  it("replacement between two pages: stopped at the next page, nothing written, no attempt counted", async () => {
    await importConvs([conversationWithTexts("paged", Array.from({ length: 250 }, (_, i) => sentence(i)), 100)]);
    const id = await conversationId(t.db, "paged");
    let pagesRead = 0;
    let replaced = false;
    let afterReplace: Record<string, unknown> | null = null;
    const r = await indexWith(t, {
      hooks: {
        beforePage: async (_c, p) => {
          pagesRead++;
          if (p === 1 && !replaced) {
            replaced = true;
            await importConvs([conversationWithTexts("paged", Array.from({ length: 251 }, (_, i) => sentence(i + 1)), 200)]);
            afterReplace = await statusOf(t.db, id);
          }
        },
      },
    });
    expect(afterReplace).toMatchObject({ state: "pending", attempts: 0 });
    expect(r.status === "finished" && [r.stats.staleDiscards, r.stats.indexed, r.stats.claimed]).toEqual([1, 1, 2]);
    expect(pagesRead).toBe(4); // two of the first claim (the second stops), two of the second
    expect(await statusOf(t.db, id)).toMatchObject({ state: "indexed", attempts: 1, chunkCount: 251 });
    expect(await offsetsFit()).toBe(true);
  });

  it("delete-all during inference: no chunks or status rows; a re-import during the old run never shows the old vectors", async () => {
    const convs = [syntheticConversation({ id: "c1", messages: 3, tag: "gone" })];
    await importConvs(convs);
    const oldId = await conversationId(t.db, "c1");
    let deleted = false;
    const r = await indexWith(t, {
      hooks: {
        beforeCommit: async () => {
          if (deleted) return;
          deleted = true;
          expect((await deleteAllImportedData({ writer: t.writer })).status).toBe("complete");
          expect([await chunkCount(t.db), await t.db.embeddingStatus.count()]).toEqual([0, 0]);
          await importConvs(convs);
        },
      },
    });
    expect(r.status === "finished" && [r.stats.staleDiscards, r.stats.indexed]).toEqual([1, 1]);
    const newId = await conversationId(t.db, "c1");
    expect(newId).not.toBe(oldId);
    const ids = await t.db.$queryRawUnsafe<{ id: string; e: bigint }[]>(`SELECT DISTINCT "conversationId" AS id, "epoch" AS e FROM "EmbeddingChunk"`);
    expect(ids.map((x) => [x.id, Number(x.e)])).toEqual([[newId, (await indexRow(t.db))!.epoch]]);
  });
});

describe("paged reads never mix versions (final verification, item 1)", () => {
  const paged = (from = 0) => Array.from({ length: 250 }, (_, i) => sentence(i + from)); // two pages (200 + 50)

  it("A→B→A between two pages, with page 2's text changed: the claim stops at the next page; the commit equals a fresh rebuild", async () => {
    await importConvs([conversationWithTexts("paged", paged(), 100)]);
    const id = await conversationId(t.db, "paged");
    const a = await t.db.conversation.findUniqueOrThrow({ where: { id } });
    let done = false;
    const windows = new Map<string, number>();
    const r = await indexWith(t, {
      hooks: {
        afterWindow: (c) => void windows.set(c.token, (windows.get(c.token) ?? 0) + 1),
        beforePage: async (_c, p) => {
          if (p !== 1 || done) return;
          done = true;
          // B: the text of a page-2 message changes, as a replacement would. Then the
          // version pair returns to exactly the claim's (A). Driven directly, as in the
          // store test: through the real import an exact return to A is impossible.
          await runWriterTransaction(t.db, async (x) => {
            await x.$executeRawUnsafe(
              `UPDATE "Message" SET "contentText" = ? WHERE "conversationId" = ? AND "pathIndex" = (SELECT MAX("pathIndex") FROM "Message" WHERE "conversationId" = ?)`,
              sentence(5_000), id, id,
            );
            await x.$executeRawUnsafe(`UPDATE "Conversation" SET "contentHash" = 'v1:' || hex(randomblob(32)) WHERE "id" = ?`, id);
            await invalidateConversation(x as unknown as Sql, id);
          });
          await runWriterTransaction(t.db, async (x) => {
            await x.$executeRawUnsafe(`UPDATE "Conversation" SET "contentHash" = ? WHERE "id" = ?`, a.contentHash, id);
            await invalidateConversation(x as unknown as Sql, id);
          });
        },
      },
    });
    expect(r.status === "finished" && [r.stats.staleDiscards, r.stats.indexed, r.stats.claimed]).toEqual([1, 1, 2]);
    // Two independent layers: page 2 of the first claim is refused by the page read's
    // token check (no inference on it: one window, page 1's), and T2's compare-and-set
    // would refuse the commit anyway (the token was cleared; see the store tests).
    expect([...windows.values()]).toEqual([1, 2]);
    expect(await statusOf(t.db, id)).toMatchObject({ state: "indexed", contentHash: a.contentHash, attempts: 1 });
    expect(await offsetsFit()).toBe(true);
    const committed = await chunkDump(t.db);
    // A rebuild from the current text gives exactly the same rows (chunk keys cover the text).
    await t.db.$executeRawUnsafe(`DELETE FROM "EmbeddingChunk"`);
    await t.db.$executeRawUnsafe(`UPDATE "EmbeddingStatus" SET "state" = 'pending', "attempts" = 0`);
    expectStatus(await indexWith(t), "finished");
    expect(await chunkDump(t.db)).toEqual(committed);
  });

  it("delete-all between two pages, then the same export re-imported: stopped at the next page; only the new conversation is indexed", async () => {
    const conv = conversationWithTexts("paged", paged(), 100);
    await importConvs([conv]);
    const oldId = await conversationId(t.db, "paged");
    let done = false;
    const r = await indexWith(t, {
      hooks: {
        beforePage: async (_c, p) => {
          if (p !== 1 || done) return;
          done = true;
          expect((await deleteAllImportedData({ writer: t.writer })).status).toBe("complete");
          await importConvs([conv]);
        },
      },
    });
    expect(r.status === "finished" && [r.stats.staleDiscards, r.stats.indexed]).toEqual([1, 1]);
    const newId = await conversationId(t.db, "paged");
    expect(newId).not.toBe(oldId);
    const rows = await t.db.$queryRawUnsafe<{ id: string; e: bigint; n: bigint }[]>(
      `SELECT "conversationId" AS id, "epoch" AS e, COUNT(*) AS n FROM "EmbeddingChunk" GROUP BY 1, 2`,
    );
    expect(rows.map((x) => [x.id, Number(x.e), Number(x.n)])).toEqual([[newId, (await indexRow(t.db))!.epoch, 250]]);
    expect(await offsetsFit()).toBe(true);
  });
});

describe("worker replies are checked before T2 (final verification, item 2)", () => {
  const corrupting = (mutate: (chunks: Chunk[]) => Chunk[]) => async (): Promise<IndexEmbedder> => {
    const e = await fakeIndexEmbedder()();
    return { info: e.info, chunk: async (m) => mutate(await e.chunk(m)), embedPassages: (x, o) => e.embedPassages(x, o), close: () => e.close() };
  };
  const cases: [string, (chunks: Chunk[]) => Chunk[]][] = [
    ["offsets shifted by one", (cs) => cs.map((c, i) => (i === 1 ? { ...c, start: c.start + 1, end: c.end + 1 } : c))],
    ["an end past the message", (cs) => cs.map((c, i) => (i === 1 ? { ...c, end: c.end + 100_000 } : c))],
    ["text that is not the substring", (cs) => cs.map((c, i) => (i === 1 ? { ...c, text: `${c.text} injected` } : c))],
    ["a node id that is not on the page", (cs) => cs.map((c, i) => (i === 1 ? { ...c, sourceNodeId: "elsewhere" } : c))],
    ["a duplicate chunk", (cs) => [...cs, cs[0]!]],
    ["a fractional chunk index", (cs) => cs.map((c, i) => (i === 1 ? { ...c, chunkIndex: 0.5 } : c))],
  ];
  it.each(cases)("%s: a recoverable inference failure (failed after 3 attempts), nothing written", async (_name, mutate) => {
    await importConvs([syntheticConversation({ id: "c1", messages: 4 })]);
    const id = await conversationId(t.db, "c1");
    const r = await indexWith(t, { openEmbedder: corrupting(mutate) });
    expect(r.status === "finished" && [r.stats.failed, r.stats.retried, r.stats.indexed]).toEqual([1, 2, 0]);
    expect(await statusOf(t.db, id)).toMatchObject({ state: "failed", attempts: 3, lastErrorCode: "INFERENCE_FAILED" });
    expect(await chunkCount(t.db)).toBe(0);
  });
});

describe("failures and attempts (§5.6)", () => {
  it("a poison conversation (recoverable) fails after 3 attempts; the others are indexed", async () => {
    await importConvs([
      syntheticConversation({ id: "a" }),
      syntheticConversation({ id: "poison", tag: "POISONPILL" }),
      syntheticConversation({ id: "b" }),
    ]);
    const r = await indexWith(t, { worker: { poisonMarker: "POISONPILL" } });
    expectStatus(r, "finished");
    expect(r.status === "finished" && r.stats).toMatchObject({ indexed: 2, failed: 1, retried: 2 });
    expect(await statusOf(t.db, await conversationId(t.db, "poison"))).toMatchObject({ state: "failed", attempts: 3, lastErrorCode: "INFERENCE_FAILED" });
    expect(await chunkCount(t.db, await conversationId(t.db, "poison"))).toBe(0);
  });

  it("a non-finite vector is a recoverable inference failure", async () => {
    await importConvs([syntheticConversation({ id: "nan", tag: "NANMARK" })]);
    const r = await indexWith(t, { worker: { nanMarker: "NANMARK" } });
    expect(r.status === "finished" && r.stats.failed).toBe(1);
    expect(await statusOf(t.db, await conversationId(t.db, "nan"))).toMatchObject({ state: "failed", attempts: 3, lastErrorCode: "INFERENCE_FAILED" });
  });

  it("INVALID_INPUT is permanent: failed after one attempt", async () => {
    await importConvs([syntheticConversation({ id: "bad", tag: "BADINPUT" }), syntheticConversation({ id: "ok" })]);
    const r = await indexWith(t, { worker: { invalidMarker: "BADINPUT" } });
    expect(r.status === "finished" && r.stats).toMatchObject({ indexed: 1, failed: 1 });
    expect(await statusOf(t.db, await conversationId(t.db, "bad"))).toMatchObject({ state: "failed", attempts: 1, lastErrorCode: "INVALID_INPUT" });
  });

  it("a model or runtime failure stops the run with the attempt refunded; the next run clears the error", async () => {
    await importConvs(syntheticExport(2));
    const broken = async (): Promise<IndexEmbedder> => {
      const e = await fakeIndexEmbedder()();
      return { info: e.info, chunk: (m) => e.chunk(m), close: () => e.close(), embedPassages: async () => { throw new EmbeddingError("RUNTIME_UNAVAILABLE"); } };
    };
    const r = await indexWith(t, { openEmbedder: broken });
    expect(r).toMatchObject({ status: "stopped", code: "RUNTIME_UNAVAILABLE" });
    expect((await statusRows(t.db)).map((s) => [s.state, s.attempts])).toEqual([["pending", 0], ["pending", 0]]);
    expect(await indexRow(t.db)).toMatchObject({ lastErrorCode: "RUNTIME_UNAVAILABLE" });
    expectStatus(await indexWith(t), "finished");
    expect(await indexRow(t.db)).toMatchObject({ lastErrorCode: null });
  });

  it("a worker crash stops the run and keeps the attempt: three crashes make the conversation failed", async () => {
    await importConvs([syntheticConversation({ id: "crash", tag: "CRASHME" }), syntheticConversation({ id: "ok" })]);
    const id = await conversationId(t.db, "crash");
    for (let i = 1; i <= 3; i++) {
      const r = await indexWith(t, { worker: { crashMarker: "CRASHME" } });
      expect(r).toMatchObject({ status: "stopped", code: "WORKER_FAILED" });
      expect(await statusOf(t.db, id)).toMatchObject({ attempts: i, state: i < 3 ? "pending" : "failed", lastErrorCode: "WORKER_FAILED" });
    }
    expectStatus(await indexWith(t, { worker: { crashMarker: "CRASHME" } }), "finished");
    expect(await statusOf(t.db, await conversationId(t.db, "ok"))).toMatchObject({ state: "indexed" });
    expect(await statusOf(t.db, id)).toMatchObject({ state: "failed", attempts: 3 });
  });

  it("a model that cannot start writes nothing (not started)", async () => {
    await importConvs(syntheticExport(1));
    const before = JSON.stringify(await statusRows(t.db));
    const r = await indexWith(t, { openEmbedder: async () => { throw new EmbeddingError("MODEL_MISSING"); } });
    expect(r).toEqual({ status: "not-started", code: "MODEL_MISSING" });
    expect(await indexRow(t.db)).toBeNull();
    expect(JSON.stringify(await statusRows(t.db))).toBe(before);
  });

  it.each([
    ["embedding version", { embeddingVersion: "other" }],
    ["chunker version", { chunkerVersion: "other" }],
    ["dimensions", { dimensions: 3 }],
  ])("a worker reporting another %s is refused before anything is written (INDEX_CONFIG_MISMATCH)", async (_label, over) => {
    await importConvs(syntheticExport(1));
    let closed = false;
    const r = await indexWith(t, {
      openEmbedder: async () => {
        const e = await fakeIndexEmbedder()();
        return { info: { ...e.info, ...over }, chunk: (m) => e.chunk(m), embedPassages: (x, o) => e.embedPassages(x, o), close: () => { closed = true; return e.close(); } };
      },
    });
    expect(r).toEqual({ status: "not-started", code: "INDEX_CONFIG_MISMATCH" });
    expect(closed).toBe(true);
    expect(await indexRow(t.db)).toBeNull();
  });
});

describe("the chunk cap and oversized conversations (condition E)", () => {
  it(`a conversation at exactly ${MAX_CHUNKS_PER_CONVERSATION} chunks commits in one T2; memory and commit time are measured`, async () => {
    // 250 messages × 80 forty-word sentences = 20,000 chunks.
    await importConvs([conversationWithTexts("at-cap", Array.from({ length: 250 }, (_, i) => sentences(80, i * 80)))]);
    const id = await conversationId(t.db, "at-cap");
    (globalThis as { gc?: () => void }).gc?.();
    const base = process.memoryUsage();
    let peakHeap = base.heapUsed;
    let peakRss = base.rss;
    const sampler = setInterval(() => {
      const m = process.memoryUsage();
      peakHeap = Math.max(peakHeap, m.heapUsed);
      peakRss = Math.max(peakRss, m.rss);
    }, 10);
    let inCommitAt = 0;
    const t0 = performance.now();
    const r = await indexWith(t, { hooks: { beforeCommit: () => void (inCommitAt = performance.now()) } });
    const totalMs = performance.now() - t0;
    clearInterval(sampler);
    expectStatus(r, "finished");
    expect(await statusOf(t.db, id)).toMatchObject({ state: "indexed", chunkCount: MAX_CHUNKS_PER_CONVERSATION, attempts: 1 });
    expect(await chunkCount(t.db, id)).toBe(MAX_CHUNKS_PER_CONVERSATION);
    const maxCommitMs = r.status === "finished" ? r.stats.maxCommitMs : -1;
    const mib = (n: number) => Math.round((n / 2 ** 20) * 10) / 10;
    report.atCap = {
      chunks: MAX_CHUNKS_PER_CONVERSATION,
      t2WriteLockHoldMs: maxCommitMs,
      inferenceMs: Math.round(inCommitAt - t0),
      totalMs: Math.round(totalMs),
      mainHeapBaseMiB: mib(base.heapUsed),
      mainHeapPeakGrowthMiB: mib(peakHeap - base.heapUsed),
      rssBaseMiB: mib(base.rss),
      rssPeakGrowthMiB: mib(peakRss - base.rss),
    };
    // Targets (design §5.4): T2 < 500 ms; int8 results about 9 MB held until T2. T2 takes
    // about 175 ms alone but up to about 600 ms while the whole suite runs in parallel, so
    // the 500 ms target is asserted in measurement mode (THREADATLAS_INDEX_REPORT, run this
    // test alone); every run asserts the bound that matters: an import or delete-all that
    // starts during T2 waits for it (IMPORT_LOCK_WAIT_MS) instead of reporting busy.
    expect(maxCommitMs).toBeLessThan(process.env.THREADATLAS_INDEX_REPORT ? 500 : IMPORT_LOCK_WAIT_MS);
    expect(peakHeap - base.heapUsed).toBeLessThan(256 * 2 ** 20);
    const rv = await openVectorReader(t.db, QUERY);
    expect(rv.ok && rv.rows.length).toBe(MAX_CHUNKS_PER_CONVERSATION);
  }, 180_000);

  it("cap + 1 fails permanently with one attempt, writes nothing, the others are indexed, keyword search still finds it", async () => {
    const texts = Array.from({ length: 250 }, (_, i) => sentences(80, i * 80));
    texts.push(`${sentence(99_999)} ZEBRACAPCANARY`); // one more chunk
    await importConvs([conversationWithTexts("over-cap", texts), syntheticConversation({ id: "small" })]);
    const id = await conversationId(t.db, "over-cap");
    const r = await indexWith(t);
    expect(r.status === "finished" && r.stats).toMatchObject({ indexed: 1, failed: 1, tooLarge: 1 });
    expect(await statusOf(t.db, id)).toMatchObject({ state: "failed", attempts: 1, lastErrorCode: "CONVERSATION_TOO_LARGE", chunkCount: null });
    expect(await chunkCount(t.db, id)).toBe(0);
    const again = await indexWith(t);
    expect(again.status === "finished" && again.stats.claimed).toBe(0); // never requeued by Start
    const s = await searchConversations(t.db, "zebracapcanary", undefined);
    expect(s.status === "ok" && s.results.map((x) => x.conversationId)).toEqual([id]);
  }, 180_000);

  it("a single message over the worker's input limit fails permanently before any inference", async () => {
    const big = `${"a".repeat(LIMITS.maxTextLength)} BIGMESSAGECANARY`;
    await importConvs([conversationWithTexts("big-message", ["short first message.", big]), syntheticConversation({ id: "small" })]);
    const r = await indexWith(t);
    expect(r.status === "finished" && r.stats).toMatchObject({ indexed: 1, tooLarge: 1 });
    expect(await statusOf(t.db, await conversationId(t.db, "big-message"))).toMatchObject({ state: "failed", attempts: 1, lastErrorCode: "CONVERSATION_TOO_LARGE" });
    const s = await searchConversations(t.db, "bigmessagecanary", undefined);
    expect(s.status === "ok" && s.results).toHaveLength(1);
  }, 120_000);
});

describe("locks and concurrency", () => {
  it("waits while the write lock is busy (not an attempt), then finishes", async () => {
    await importConvs(syntheticExport(2));
    const held = await acquireWriteLock(t.file);
    if (!held.ok) throw new Error("lock");
    const states: string[] = [];
    let busy = 0;
    const run = indexWith(t, { onState: (s) => states.push(s), hooks: { onWriteLockBusy: () => void busy++ } });
    // Wait for the condition, not a fixed time: under a loaded full run the worker start
    // plus one round of lock retries took longer than 300 ms once.
    for (const t0 = Date.now(); busy === 0 && Date.now() - t0 < 10_000; ) await new Promise((r) => setTimeout(r, 20));
    expect(busy).toBeGreaterThan(0);
    held.lock.release();
    expectStatus(await run, "finished");
    expect(states).toContain("waiting-for-import");
    expect(states[states.length - 1]).toBe("running");
    expect((await statusRows(t.db)).map((s) => s.attempts)).toEqual([1, 1]);
  });

  it("an import during an indexing run is never blocked, and its conversations are indexed in the same run", async () => {
    await importConvs(syntheticExport(4, { messages: 6, textLength: 400 }));
    let imported = false;
    const r = await indexWith(t, {
      worker: { batchDelayMs: 20 },
      hooks: {
        afterClaim: async () => {
          if (imported) return;
          imported = true;
          const out = await importText(exportText(syntheticExport(3, { idPrefix: "late" })), { writer: t.writer });
          expect(out.status).toBe("succeeded");
        },
      },
    });
    expect(r.status === "finished" && r.stats.indexed).toBe(7);
  });

  it("a second indexer is refused (INDEXER_BUSY) while one runs, and writes nothing", async () => {
    await importConvs(syntheticExport(3, { messages: 6, textLength: 400 }));
    let second: IndexerResult | null = null;
    const first = await indexWith(t, {
      worker: { batchDelayMs: 10 },
      hooks: {
        afterClaim: async () => {
          second ??= await indexWith(t);
        },
      },
    });
    expect(second).toEqual({ status: "not-started", code: "INDEXER_BUSY" });
    expectStatus(first, "finished");
  });

  it("keeps the event loop responsive during a run", async () => {
    await importConvs(syntheticExport(20, { messages: 10, textLength: 800 }));
    let last = performance.now();
    let maxGap = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 5);
    const r = await indexWith(t);
    clearInterval(timer);
    expectStatus(r, "finished");
    report.eventLoop = { conversations: 20, maxGapMs: Math.round(maxGap) };
    expect(maxGap).toBeLessThan(250);
  });
});

/** The indexer on another test database (fake embedder). */
function runIndexerOn(other: TestDb): Promise<IndexerResult> {
  return indexWith(other);
}
