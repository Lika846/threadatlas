/**
 * Real-model tests (M5.1a). Run with `npm run test:model` after `npm run model:fetch`;
 * they fail clearly if the model is not installed. Not part of `npm test`.
 *
 * 1. Equivalence with the reference pipeline (Transformers.js 3.8.1, M5.0 Experiment 1):
 *    tests/fixtures/semantic/e5-reference.json.
 * 2. Reproducibility of chunk ids and vectors across calls and worker restarts.
 * 3. Retrieval regression on the approved synthetic research sets
 *    (docs/spikes/m5.0/eval/dataset.json and long.json), float32 and int8.
 * 4. Server responsiveness while the worker is embedding.
 *
 * Set THREADATLAS_MODEL_REPORT=<file> to write the measured numbers as JSON.
 */
import fs from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Embedder } from "./embedder";
import { resolveModelDir } from "./model-files";
import { dotInt8, quantizeInt8 } from "./quantize";

type Conversation = { id: string; lang: string; title: string; messages: string[] };
type Query = { id: string; category: string; lang: string; text: string; relevant: Record<string, number> };
type EvalSet = { conversations: Conversation[]; queries: Query[] };
type Fixture = {
  dims: number;
  single: { kind: "query" | "passage"; text: string; ids: number[]; vector: string }[];
  batch: { texts: string[]; vectors: string };
  long: { text: string; fullIds: number[] };
};

const root = process.cwd();
const readJson = <T,>(p: string): T => JSON.parse(fs.readFileSync(path.join(root, p), "utf8")) as T;
const fixture = readJson<Fixture>("tests/fixtures/semantic/e5-reference.json");
const v0 = readJson<EvalSet>("docs/spikes/m5.0/eval/dataset.json");
const long = readJson<EvalSet>("docs/spikes/m5.0/eval/long.json");
const decode = (b64: string) => {
  const b = Buffer.from(b64, "base64");
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
};
const maxAbsDiff = (a: Float32Array, b: Float32Array) => a.reduce((m, x, i) => Math.max(m, Math.abs(x - b[i]!)), 0);
const bytes = (vs: Float32Array[]) => Buffer.concat(vs.map((v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength)));

const report: Record<string, unknown> = {};
let e: Embedder;

beforeAll(async () => {
  const t = performance.now();
  e = await Embedder.start({ modelDir: resolveModelDir({ env: process.env, root }) });
  report.startMs = Math.round(performance.now() - t);
  report.info = e.info;
});

afterAll(async () => {
  await e?.close();
  const out = process.env.THREADATLAS_MODEL_REPORT;
  if (out) fs.writeFileSync(out, JSON.stringify(report, null, 1));
});

describe("equivalence with the reference pipeline", () => {
  it("produces identical token ids", async () => {
    for (const s of fixture.single) expect(await e.encode(s.kind, s.text)).toEqual(s.ids);
  });

  it("produces the reference vectors one text at a time", async () => {
    let worst = 0;
    for (const s of fixture.single) {
      const v = s.kind === "query" ? await e.embedQuery(s.text) : (await e.embedPassages([s.text]))[0]!;
      worst = Math.max(worst, maxAbsDiff(v, decode(s.vector)));
    }
    report.singleMaxAbsDiff = worst;
    expect(worst).toBeLessThan(1e-5);
  });

  it("produces the reference vectors for a padded batch", async () => {
    const ref = decode(fixture.batch.vectors);
    const got = await e.embedPassages(fixture.batch.texts);
    const worst = Math.max(...got.map((v, i) => maxAbsDiff(v, ref.subarray(i * fixture.dims, (i + 1) * fixture.dims))));
    report.batchMaxAbsDiff = worst;
    expect(worst).toBeLessThan(1e-5);
  });

  it("truncates over-long input to 512 ids ending with </s>", async () => {
    expect(fixture.long.fullIds.length).toBeGreaterThan(512);
    const ids = await e.encode("passage", fixture.long.text);
    expect(ids).toEqual([...fixture.long.fullIds.slice(0, 511), 2]);
    const [v] = await e.embedPassages([fixture.long.text]);
    expect(Math.hypot(...v!)).toBeCloseTo(1, 5);
  });
});

describe("reproducibility", () => {
  const conv = long.conversations[0]!;
  const messages = conv.messages.map((text, k) => ({ sourceNodeId: `m${k + 1}`, text }));

  it("gives identical chunks and bit-identical vectors across calls and worker restarts", async () => {
    const c1 = await e.chunk(messages);
    const v1 = bytes(await e.embedPassages(c1.map((c) => c.text)));
    const v2 = bytes(await e.embedPassages(c1.map((c) => c.text)));
    expect(v2.equals(v1)).toBe(true);

    const other = await Embedder.start({ modelDir: resolveModelDir({ env: process.env, root }), verifyHashes: false });
    try {
      const c2 = await other.chunk(messages);
      expect(c2).toEqual(c1);
      expect(bytes(await other.embedPassages(c2.map((c) => c.text))).equals(v1)).toBe(true);
    } finally {
      await other.close();
    }
  });

  it("keeps every chunk within 64 tokens and as an exact substring", async () => {
    const all = await e.chunk(long.conversations.flatMap((c) => c.messages.map((text, k) => ({ sourceNodeId: `${c.id}-${k}`, text }))));
    for (const c of all) expect(c.tokenCount).toBeLessThanOrEqual(64);
    const byId = new Map<string, string>(long.conversations.flatMap((c) => c.messages.map((text, k) => [`${c.id}-${k}`, text] as const)));
    for (const c of all) expect(byId.get(c.sourceNodeId)!.slice(c.start, c.end)).toBe(c.text);
  });
});

describe("retrieval regression on the research sets", () => {
  type Indexed = { cid: string; vectors: Float32Array[]; q8: Uint8Array[] };

  async function index(convs: Conversation[], track?: { chunks: number }) {
    const out: Indexed[] = [];
    for (const c of convs) {
      const chunks = await e.chunk(c.messages.map((text, k) => ({ sourceNodeId: `m${k + 1}`, text })));
      const vectors = await e.embedPassages(chunks.map((x) => x.text)); // one conversation per call
      if (track) track.chunks += chunks.length;
      out.push({ cid: c.id, vectors, q8: vectors.map(quantizeInt8) });
    }
    return out;
  }

  function rank(idx: Indexed[], q: Float32Array, int8: boolean): string[] {
    const best = idx.map((c) => ({
      cid: c.cid,
      s: Math.max(...(int8 ? c.q8.map((b) => dotInt8(q, b)) : c.vectors.map((v) => v.reduce((s, x, i) => s + x * q[i]!, 0)))),
    }));
    return best.sort((a, b) => b.s - a.s).map((b) => b.cid);
  }

  function metrics(queries: Query[], ranked: Map<string, string[]>) {
    const K = 10;
    const rows = queries.map((q) => {
      const top = ranked.get(q.id)!.slice(0, K);
      const rel = q.relevant;
      const found = top.filter((id) => id in rel).length;
      const first = top.findIndex((id) => id in rel);
      const dcg = top.reduce((s, id, i) => s + (2 ** (rel[id] ?? 0) - 1) / Math.log2(i + 2), 0);
      const ideal = Object.values(rel)
        .sort((a, b) => b - a)
        .slice(0, K)
        .reduce((s, g, i) => s + (2 ** g - 1) / Math.log2(i + 2), 0);
      return { ndcg: ideal ? dcg / ideal : 0, recall: found / Math.min(Object.keys(rel).length, K), mrr: first === -1 ? 0 : 1 / (first + 1) };
    });
    const avg = (k: "ndcg" | "recall" | "mrr") => +(rows.reduce((s, r) => s + r[k], 0) / rows.length).toFixed(3);
    const perQuery = Object.fromEntries(queries.map((q, i) => [q.id, +rows[i]!.ndcg.toFixed(3)]));
    return { n: rows.length, ndcg10: avg("ndcg"), recall10: avg("recall"), mrr10: avg("mrr"), perQuery };
  }

  it("meets the Experiment 2 quality on the fixed v0 set and the long set, float32 and int8", async () => {
    const track = { chunks: 0 };
    const h = monitorEventLoopDelay({ resolution: 10 });
    h.enable();
    const t = performance.now();
    const v0Index = await index(v0.conversations, track);
    const longIndex = await index(long.conversations, track);
    const indexMs = performance.now() - t;
    h.disable();
    const union = [...v0Index, ...longIndex]; // long queries run on the combined corpus, as in Experiment 2

    const results: Record<string, unknown> = {};
    for (const [name, set, idx] of [
      ["v0", v0, v0Index],
      ["long", long, union],
    ] as const) {
      for (const int8 of [false, true]) {
        const ranked = new Map<string, string[]>();
        for (const q of set.queries) ranked.set(q.id, rank(idx, await e.embedQuery(q.text), int8));
        results[`${name}-${int8 ? "int8" : "float32"}`] = metrics(set.queries, ranked);
      }
    }
    report.retrieval = results;
    report.indexing = {
      conversations: v0.conversations.length + long.conversations.length,
      chunks: track.chunks,
      seconds: +(indexMs / 1000).toFixed(1),
      chunksPerSecond: +(track.chunks / (indexMs / 1000)).toFixed(1),
    };
    report.eventLoopDelayMs = { p50: +(h.percentile(50) / 1e6).toFixed(1), p99: +(h.percentile(99) / 1e6).toFixed(1), max: +(h.max / 1e6).toFixed(1) };

    // Experiment 2 (64-token sentence chunks): 0.83 on both sets. The production chunker
    // and per-conversation batching differ slightly, so allow 0.03.
    const ndcg = (k: string) => (results[k] as { ndcg10: number }).ndcg10;
    expect(ndcg("v0-float32")).toBeGreaterThanOrEqual(0.8);
    expect(ndcg("long-float32")).toBeGreaterThanOrEqual(0.8);
    expect(Math.abs(ndcg("v0-int8") - ndcg("v0-float32"))).toBeLessThanOrEqual(0.02);
    expect(Math.abs(ndcg("long-int8") - ndcg("long-float32"))).toBeLessThanOrEqual(0.02);
    // The worker keeps the event loop responsive (Experiment 2: p99 19 ms).
    expect(h.percentile(99) / 1e6).toBeLessThan(100);
  });
});
