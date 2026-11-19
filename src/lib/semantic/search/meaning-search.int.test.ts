/**
 * Search by meaning end to end on temporary databases (M5.2): the real import, indexer,
 * reader, cache, keyword search and fusion, with the query embedded by the fake inference
 * child (same deterministic vectors as the fake indexer: a query equal to a chunk's text
 * gets that chunk's vector). Relevance with the real model is in the model test.
 * Synthetic data only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { importText } from "../../../../tests/helpers/import";
import { conversationId, conversationWithTexts, indexWith } from "../../../../tests/helpers/semantic-index";
import { BASE_TIME, exportText } from "../../../../tests/helpers/synthetic-export";
import { createTestDb, type TestDb } from "../../../../tests/helpers/test-db";
import { deleteAllImportedData } from "../../data/delete-all";
import { E5_SMALL_MANIFEST } from "../model-manifest";
import { searchByMeaning, MEANING_RESULTS } from "./meaning-search";
import { closeQueryHost, queryProcess } from "./query-host";
import { currentVectors, dropVectorCache, pack, topConversations } from "./vector-cache";

const ROOT = process.cwd();
const TARGET = "Lighthouse keepers record every storm in a logbook.";
let t: TestDb;
let modelDir: string;
let emptyDir: string;

const env = (over: Record<string, string> = {}) => ({
  THREADATLAS_TEST: "1",
  THREADATLAS_INFERENCE_ENTRY: "tests/helpers/fake-inference-child.mts",
  THREADATLAS_INFERENCE_TEST_OPTIONS: JSON.stringify({ pipeline: "index" }),
  THREADATLAS_MODEL_DIR: modelDir,
  ...over,
});
const search = (q: string, page = "1", over: Record<string, string> = {}, idleMs?: number) => searchByMeaning(t.db, q, page, { env: env(over), root: ROOT, idleMs });

beforeAll(() => {
  // Sparse files of the approved sizes: the size check passes; the fake child never reads them.
  modelDir = fs.mkdtempSync(path.join(os.tmpdir(), "threadatlas-meaning-model-"));
  for (const f of E5_SMALL_MANIFEST.files) {
    const file = path.join(modelDir, f.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.closeSync(fs.openSync(file, "w"));
    fs.truncateSync(file, f.size);
  }
  emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "threadatlas-meaning-empty-"));
});
afterAll(async () => {
  await closeQueryHost();
  fs.rmSync(modelDir, { recursive: true, force: true });
  fs.rmSync(emptyDir, { recursive: true, force: true });
});
beforeEach(() => {
  t = createTestDb();
  dropVectorCache(); // the cache is per server process; each test has its own database
});
afterEach(async () => {
  await t.cleanup();
});

async function importConvs(convs: unknown[]) {
  expect((await importText(exportText(convs), { writer: t.writer })).complete).toBe(true);
}
const corpus = (n: number) => [
  ...Array.from({ length: n }, (_, i) => conversationWithTexts(`c${i}`, [`Topic number ${i} is about subject ${i}.`, `A second message for ${i}.`])),
  conversationWithTexts("target", ["An opening remark.", TARGET]),
];
async function messageTexts(): Promise<Map<string, string[]>> {
  const rows = await t.db.message.findMany({ select: { conversationId: true, contentText: true } });
  const m = new Map<string, string[]>();
  for (const r of rows) m.set(r.conversationId, [...(m.get(r.conversationId) ?? []), r.contentText]);
  return m;
}

describe("search by meaning", { timeout: 60_000 }, () => {
  it("finds the matching conversation first; meaning-only results: 50 distinct in one response, close matches marked, real passages, links", async () => {
    await importConvs(corpus(60));
    expect((await indexWith(t)).status).toBe("finished");
    const target = await conversationId(t.db, "target");

    const hit = await search(TARGET);
    if (hit.status !== "ok") throw new Error(hit.status);
    expect(hit.results[0]).toMatchObject({ conversationId: target, matchedBy: "both", close: true });
    expect(hit.results[0]!.link.messageNumber).toBe(2);
    expect(hit.notice).toBeNull();

    const loose = await search("qzx nothing here matches every word", "3");
    if (loose.status !== "ok") throw new Error(loose.status);
    // Everything in one response (the page argument is ignored), so "Other results" needs no new search.
    expect(loose).toMatchObject({ total: MEANING_RESULTS, page: 1, totalPages: 1 });
    expect(loose.results).toHaveLength(MEANING_RESULTS);
    expect(new Set(loose.results.map((x) => x.conversationId)).size).toBe(MEANING_RESULTS);
    expect(loose.results[0]!.close).toBe(true); // the best is always a close match
    const closeFlags = loose.results.map((x) => x.close);
    expect(closeFlags.every((c) => typeof c === "boolean")).toBe(true);
    // Meaning only: close matches form an unbroken run at the top (the cutoff follows the ranking).
    expect(closeFlags.indexOf(false) === -1 || closeFlags.slice(closeFlags.indexOf(false)).every((c) => c === false)).toBe(true);
    const texts = await messageTexts();
    for (const x of loose.results) {
      expect(x.matchedBy).toBe("meaning");
      const passage = x.snippet!.map((s) => s.text).join("").replace(/^… /, "").replace(/ …$/, "");
      expect(texts.get(x.conversationId)!.some((m) => m.includes(passage))).toBe(true);
      expect([1, 2]).toContain(x.link.messageNumber);
    }
  });

  it("never shows a replaced or deleted conversation's passage", async () => {
    await importConvs(corpus(5));
    await indexWith(t);
    const target = await conversationId(t.db, "target");
    expect((await search(TARGET)).status === "ok").toBe(true);
    // A newer copy replaces the messages; it is not indexed yet.
    await importConvs([conversationWithTexts("target", ["Completely different words now."], BASE_TIME + 1_000)]);
    const after = await search(TARGET);
    if (after.status !== "ok") throw new Error(after.status);
    expect(after.results.map((r) => r.conversationId)).not.toContain(target);
    expect(JSON.stringify(after.results)).not.toContain("Lighthouse");
    expect(after.notice).toEqual({ kind: "partial", notIndexed: 1 });
    // Delete-all: nothing left to find.
    expect((await deleteAllImportedData({ writer: t.writer })).status).toBe("complete");
    const gone = await search(TARGET);
    expect(gone).toMatchObject({ status: "ok", total: 0 });
  });

  it("falls back to exact words, and says why", async () => {
    await importConvs(corpus(3));
    expect(await search("Topic number 1")).toMatchObject({ status: "ok", notice: { kind: "fallback", reason: "INDEX_EMPTY" }, total: 1 });
    await indexWith(t);
    expect(await search("Topic number 1", "1", { THREADATLAS_MODEL_DIR: emptyDir })).toMatchObject({ notice: { kind: "fallback", reason: "MODEL_MISSING" }, total: 1 });
    await t.db.$executeRawUnsafe(`UPDATE "EmbeddingIndex" SET "embeddingVersion" = 'another-model'`);
    expect(await search("Topic number 1")).toMatchObject({ notice: { kind: "fallback", reason: "INDEX_INCOMPATIBLE" }, total: 1 });
  });

  it("falls back when the query process can't start (UNAVAILABLE), and recovers", async () => {
    await importConvs(corpus(3));
    await indexWith(t);
    await closeQueryHost();
    expect(await search("Topic number 1", "1", { THREADATLAS_INFERENCE_ENTRY: "tests/helpers/not-the-fake.mts" })).toMatchObject({
      notice: { kind: "fallback", reason: "UNAVAILABLE" },
    });
    expect(await search("Topic number 1")).toMatchObject({ status: "ok", notice: null });
  });

  it("says how many conversations aren't indexed yet", async () => {
    await importConvs(corpus(3));
    await indexWith(t);
    await importConvs([conversationWithTexts("late-1", ["Late one."]), conversationWithTexts("late-2", ["Late two."])]);
    expect(await search("Topic number 1")).toMatchObject({ status: "ok", notice: { kind: "partial", notIndexed: 2 } });
  });

  it("refuses an empty or over-long query like keyword search", async () => {
    expect(await search("   ")).toEqual({ status: "invalid", rejection: { reason: "empty" } });
    expect(await search("x".repeat(300))).toMatchObject({ status: "invalid", rejection: { reason: "too_long" } });
  });
});

describe("the query process and the cache", { timeout: 60_000 }, () => {
  it("stays loaded between searches and exits after the idle time", async () => {
    await importConvs(corpus(3));
    await indexWith(t);
    await closeQueryHost();
    await search("Topic number 1", "1", {}, 600);
    const first = queryProcess();
    expect(first).not.toBeNull();
    await search("Topic number 2", "1", {}, 600);
    expect(queryProcess()?.pid).toBe(first!.pid);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(queryProcess()).toBeNull();
    expect(() => process.kill(first!.pid, 0)).toThrow();
  });

  it("reuses the cache until the index changes", async () => {
    await importConvs(corpus(3));
    await indexWith(t);
    const info = { embeddingVersion: (await t.db.$queryRawUnsafe<{ v: string }[]>(`SELECT "embeddingVersion" AS v FROM "EmbeddingIndex"`))[0]!.v, chunkerVersion: "sentence-pack-v1" };
    const a = await currentVectors(t.db, info);
    const b = await currentVectors(t.db, info);
    expect(a.ok && b.ok && a.cache === b.cache).toBe(true);
    await importConvs([conversationWithTexts("late", ["Late one."])]);
    await indexWith(t);
    const c = await currentVectors(t.db, info);
    expect(c.ok && a.ok && c.cache !== a.cache && c.cache.chunks === a.cache.chunks + 1).toBe(true);
  });

  it("scores 50,000 chunks well within the 300 ms budget (ADR 0002)", () => {
    const dims = 384;
    const n = 50_000;
    const rows = Array.from({ length: n }, (_, i) => {
      const v = new Uint8Array(4 + dims);
      new DataView(v.buffer).setFloat32(0, 0.01, true);
      for (let d = 0; d < dims; d++) v[4 + d] = (i * 31 + d * 7) % 255;
      return { conversationId: `c${i >> 4}`, sourceNodeId: `n${i}`, start: 0, end: 10, tokenCount: 20, vector: v };
    });
    const cache = pack("perf", dims, rows);
    const query = Float32Array.from({ length: dims }, (_, d) => Math.sin(d));
    const times: number[] = [];
    for (let r = 0; r < 15; r++) {
      const t0 = performance.now();
      expect(topConversations(cache, query, MEANING_RESULTS)).toHaveLength(MEANING_RESULTS);
      times.push(performance.now() - t0);
    }
    times.sort((x, y) => x - y);
    // Alone: p50 about 32 ms, p95 about 71 ms on the development Mac (Experiment 2: 37 / 79 ms).
    // While the whole suite runs in parallel, p95 reached 360 ms, so the 300 ms budget is
    // asserted in measurement mode (THREADATLAS_SEARCH_PERF=1, this test alone); every run
    // asserts the median within it.
    expect(times[Math.floor(times.length / 2)]!).toBeLessThan(300);
    if (process.env.THREADATLAS_SEARCH_PERF === "1") expect(times[Math.floor(times.length * 0.95)]!).toBeLessThan(300);
  });
});
