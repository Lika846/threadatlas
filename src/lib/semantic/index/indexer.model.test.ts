/**
 * Real-model test of the indexer (M5.1b-1; opt-in, `npm run test:model`, needs the
 * model files: `THREADATLAS_MODEL_DIR` or `npm run model:fetch`). Not part of `npm test`.
 *
 * The approved synthetic research sets (docs/spikes/m5.0/eval/dataset.json and
 * long.json) are imported into a migrated temporary database and indexed through the
 * indexer with the real model. Then:
 * - every stored vector is bit-identical to the pipeline's own output under the window
 *   rule (one page per research conversation, windows of 256 chunks), and the chunk
 *   count equals the pipeline's;
 * - retrieval through the vector reader (int8) meets the M5.1a quality bar (nDCG@10 ≥ 0.8
 *   on both sets).
 * A synthetic multilingual conversation that spans two pages and several windows is
 * also indexed into two separate databases: rows, order, UTF-16 offsets and vectors must
 * match the pipeline under the per-page window rule, and both databases must be identical.
 * Set THREADATLAS_MODEL_REPORT=<file> to write the numbers as JSON.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importText } from "../../../../tests/helpers/import";
import { migrateTestDatabase } from "../../../../tests/helpers/migrate";
import { chunkDumpBySource, conversationWithTexts, indexRow } from "../../../../tests/helpers/semantic-index";
import { exportText } from "../../../../tests/helpers/synthetic-export";
import { testEnv } from "../../../../tests/helpers/test-db";
import { createPrismaClient, type DbClient } from "../../db/client";
import type { Chunk } from "../chunker";
import { Embedder } from "../embedder";
import { resolveModelDir } from "../model-files";
import { E5_SMALL_SPEC } from "../model-manifest";
import { dotInt8, quantizedByteLength, quantizeInt8 } from "../quantize";
import { CODE_INDEX_CONFIG, PAGE_MAX_MESSAGES, WINDOW_CHUNKS } from "./config";
import { runIndexer } from "./indexer";
import { openVectorReader } from "./reader";

type Conversation = { id: string; messages: string[] };
type Query = { id: string; text: string; relevant: Record<string, number> };
type EvalSet = { conversations: Conversation[]; queries: Query[] };

const root = process.cwd();
const readJson = <T,>(p: string): T => JSON.parse(fs.readFileSync(path.join(root, p), "utf8")) as T;
const v0 = readJson<EvalSet>("docs/spikes/m5.0/eval/dataset.json");
const long = readJson<EvalSet>("docs/spikes/m5.0/eval/long.json");
const modelDir = () => resolveModelDir({ env: process.env, root });
const report: Record<string, unknown> = {};

let dir: string;
let db: DbClient;
let e: Embedder;
const sourceIdOf = new Map<string, string>(); // conversation id → research id

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "threadatlas-index-model-"));
  const file = path.join(dir, "index.db");
  migrateTestDatabase(file);
  const env = testEnv(file);
  db = createPrismaClient({ env, root });
  e = await Embedder.start({ modelDir: modelDir() });
  const out = await importText(exportText([...v0.conversations, ...long.conversations].map((c) => conversationWithTexts(c.id, c.messages))), {
    writer: { db, dbPath: file },
  });
  expect(out.complete).toBe(true);
  for (const c of await db.conversation.findMany({ select: { id: true, sourceId: true } })) sourceIdOf.set(c.id, c.sourceId);
  const reader = createPrismaClient({ env, root });
  const t0 = performance.now();
  const r = await runIndexer({ writer: { db, dbPath: file }, reader, openEmbedder: () => Embedder.start({ modelDir: modelDir() }) });
  report.indexing = { result: r, seconds: +((performance.now() - t0) / 1000).toFixed(1) };
  await reader.$disconnect();
  expect(r.status).toBe("finished");
});

afterAll(async () => {
  await e?.close();
  await db?.$disconnect();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  const out = process.env.THREADATLAS_MODEL_REPORT;
  if (out) fs.writeFileSync(out, JSON.stringify(report, null, 1));
});

describe("the indexer with the real model", () => {
  it("stores exactly the pipeline's chunks and int8 vectors under the window rule", async () => {
    const rv = await openVectorReader(db, e.info);
    if (!rv.ok) throw new Error(rv.code);
    expect(rv.skipped).toBe(0);
    const stored = new Map(rv.rows.map((r) => [`${sourceIdOf.get(r.conversationId)}|${r.sourceNodeId}|${r.chunkIndex}`, r]));
    let expected = 0;
    for (const c of [...v0.conversations, ...long.conversations]) {
      const chunks = await e.chunk(c.messages.map((text, k) => ({ sourceNodeId: `n${k + 1}`, text })));
      expected += chunks.length;
      for (let w = 0; w < chunks.length; w += WINDOW_CHUNKS) {
        const win = chunks.slice(w, w + WINDOW_CHUNKS);
        const vectors = await e.embedPassages(win.map((x) => x.text));
        win.forEach((ch, i) => {
          const r = stored.get(`${c.id}|${ch.sourceNodeId}|${ch.chunkIndex}`);
          expect(r, `${c.id} ${ch.sourceNodeId} ${ch.chunkIndex}`).toBeDefined();
          expect([r!.start, r!.end]).toEqual([ch.start, ch.end]);
          expect(Buffer.from(r!.vector).equals(Buffer.from(quantizeInt8(vectors[i]!)))).toBe(true);
        });
      }
    }
    expect(rv.rows.length).toBe(expected);
    report.chunks = expected;
  });

  it("meets the M5.1a retrieval quality through the vector reader (int8)", async () => {
    const rv = await openVectorReader(db, { embeddingVersion: CODE_INDEX_CONFIG.embeddingVersion, chunkerVersion: CODE_INDEX_CONFIG.chunkerVersion });
    if (!rv.ok) throw new Error(rv.code);
    const byConversation = new Map<string, Uint8Array[]>();
    for (const r of rv.rows) {
      const sid = sourceIdOf.get(r.conversationId)!;
      byConversation.set(sid, [...(byConversation.get(sid) ?? []), r.vector]);
    }
    const v0Ids = new Set(v0.conversations.map((c) => c.id));
    const rank = (q: Float32Array, onlyV0: boolean) =>
      [...byConversation]
        .filter(([sid]) => !onlyV0 || v0Ids.has(sid))
        .map(([sid, vs]) => ({ sid, s: Math.max(...vs.map((v) => dotInt8(q, v))) }))
        .sort((a, b) => b.s - a.s)
        .map((x) => x.sid);
    const ndcg = async (set: EvalSet, onlyV0: boolean) => {
      const K = 10;
      let sum = 0;
      for (const q of set.queries) {
        const top = rank(await e.embedQuery(q.text), onlyV0).slice(0, K);
        const dcg = top.reduce((s, id, i) => s + (2 ** (q.relevant[id] ?? 0) - 1) / Math.log2(i + 2), 0);
        const ideal = Object.values(q.relevant).sort((a, b) => b - a).slice(0, K).reduce((s, g, i) => s + (2 ** g - 1) / Math.log2(i + 2), 0);
        sum += ideal ? dcg / ideal : 0;
      }
      return +(sum / set.queries.length).toFixed(3);
    };
    // As in M5.1a: v0 queries on the v0 corpus, long queries on the combined corpus.
    const results = { v0Int8: await ndcg(v0, true), longInt8: await ndcg(long, false) };
    report.retrieval = results;
    expect(results.v0Int8).toBeGreaterThanOrEqual(0.8);
    expect(results.longInt8).toBeGreaterThanOrEqual(0.8);
  });
});

// The research conversations fit in one page and one window each. This synthetic
// multilingual conversation (230 messages) spans two pages (PAGE_MAX_MESSAGES) and its
// first page more than one window, with emoji (surrogate pairs), combining marks and CJK
// text, so UTF-16 offsets, the per-page window rule and ordering are checked with the real
// tokenizer and model. It is indexed into two separate databases by separate workers.
describe("a multi-page, multi-window conversation with the real model (M5.1b-1 real-model verification)", () => {
  const SENTENCES = [
    "The lighthouse keeper logged the storm at midnight.",
    "Der Bäcker öffnet um sechs Uhr und verkauft frisches Brot.",
    "Кошка спит на подоконнике, пока идёт дождь.",
    "東京の朝は静かで、電車だけが走っている。",
    "Rocket 🚀 launches are delayed when winds exceed 40 knots 🌬️.",
    "Café crème and a naïve façade keep their combining marks.",
    "In 3.5 seconds the server at example.com answered.",
    "¿Dónde está la biblioteca? Está cerca del río.",
  ];
  const MESSAGES = 230;
  const texts = Array.from({ length: MESSAGES }, (_, k) =>
    Array.from({ length: k % 3 === 0 ? 14 : 2 }, (_, j) => SENTENCES[(k + j) % SENTENCES.length]).join(k % 5 === 0 ? "\n" : " ") + ` (#${k})`,
  );
  const inputs = texts.map((text, k) => ({ sourceNodeId: `n${k + 1}`, text }));
  const dbs: { db: DbClient; file: string }[] = [];
  let pageDir: string;

  beforeAll(async () => {
    pageDir = fs.mkdtempSync(path.join(os.tmpdir(), "threadatlas-index-model-pages-"));
    for (const name of ["a.db", "b.db"]) {
      const file = path.join(pageDir, name);
      migrateTestDatabase(file);
      const env = testEnv(file);
      const pdb = createPrismaClient({ env, root });
      const out = await importText(exportText([conversationWithTexts("pages", texts)]), { writer: { db: pdb, dbPath: file } });
      expect(out.complete).toBe(true);
      const reader = createPrismaClient({ env, root });
      const r = await runIndexer({ writer: { db: pdb, dbPath: file }, reader, openEmbedder: () => Embedder.start({ modelDir: modelDir() }) });
      await reader.$disconnect();
      if (r.status !== "finished") throw new Error(`indexer ${r.status}`);
      expect(r.stats.indexed).toBe(1);
      dbs.push({ db: pdb, file });
    }
  });

  afterAll(async () => {
    for (const { db: pdb } of dbs) await pdb.$disconnect();
    if (pageDir) fs.rmSync(pageDir, { recursive: true, force: true });
  });

  it("stores the pipeline's chunks, in order, with compatible int8 vectors", async () => {
    // Expected rows: chunk each page, embed each page in windows of WINDOW_CHUNKS.
    const expected: { chunk: Chunk; vector: Float32Array }[] = [];
    const pageSizes: number[] = [];
    for (let p = 0; p < MESSAGES; p += PAGE_MAX_MESSAGES) {
      const chunks = await e.chunk(inputs.slice(p, p + PAGE_MAX_MESSAGES));
      pageSizes.push(chunks.length);
      for (let w = 0; w < chunks.length; w += WINDOW_CHUNKS) {
        const win = chunks.slice(w, w + WINDOW_CHUNKS);
        const vectors = await e.embedPassages(win.map((x) => x.text));
        win.forEach((chunk, i) => expected.push({ chunk, vector: vectors[i]! }));
      }
    }
    // The case really covers two pages and several windows in the first page.
    expect(pageSizes.length).toBe(2);
    expect(pageSizes[0]).toBeGreaterThan(WINDOW_CHUNKS);

    const { db: pdb } = dbs[0]!;
    const rv = await openVectorReader(pdb, e.info);
    if (!rv.ok) throw new Error(rv.code);
    expect(rv.skipped).toBe(0);
    expect(rv.dimensions).toBe(E5_SMALL_SPEC.dimensions);
    expect(rv.rows.length).toBe(expected.length);
    const meta = await pdb.$queryRawUnsafe<{ sourceNodeId: string; chunkIndex: unknown; tokenCount: unknown; chunkKey: string }[]>(
      `SELECT "sourceNodeId", "chunkIndex", "tokenCount", "chunkKey" FROM "EmbeddingChunk"`,
    );
    const metaOf = new Map(meta.map((m) => [`${m.sourceNodeId}|${Number(m.chunkIndex)}`, m]));
    const stored = new Map(rv.rows.map((r) => [`${r.sourceNodeId}|${r.chunkIndex}`, r]));
    const textOf = new Map(inputs.map((m) => [m.sourceNodeId, m.text]));
    const bytes = quantizedByteLength(E5_SMALL_SPEC.dimensions);
    for (const { chunk, vector } of expected) {
      const key = `${chunk.sourceNodeId}|${chunk.chunkIndex}`;
      const r = stored.get(key);
      expect(r, key).toBeDefined();
      expect([r!.start, r!.end]).toEqual([chunk.start, chunk.end]);
      expect(textOf.get(chunk.sourceNodeId)!.slice(r!.start, r!.end)).toBe(chunk.text);
      expect([Number(metaOf.get(key)!.tokenCount), metaOf.get(key)!.chunkKey]).toEqual([chunk.tokenCount, chunk.id]);
      expect(r!.vector.byteLength).toBe(bytes);
      expect(Buffer.from(r!.vector).equals(Buffer.from(quantizeInt8(vector)))).toBe(true);
      // Query-side compatibility: the int8 dot product matches the float one.
      expect(Math.abs(dotInt8(vector, r!.vector) - 1)).toBeLessThan(0.01);
    }
    // Ordering: per message, chunk indexes run 0..n-1 and offsets move forward.
    const byNode = new Map<string, { chunkIndex: number; start: number; end: number }[]>();
    for (const r of rv.rows) byNode.set(r.sourceNodeId, [...(byNode.get(r.sourceNodeId) ?? []), r]);
    expect(byNode.size).toBe(MESSAGES);
    for (const rows of byNode.values()) {
      rows.sort((a, b) => a.chunkIndex - b.chunkIndex);
      rows.forEach((r, i) => {
        expect(r.chunkIndex).toBe(i);
        if (i > 0) expect(r.start).toBeGreaterThan(rows[i - 1]!.start);
        if (i > 0) expect(r.end).toBeGreaterThan(rows[i - 1]!.end);
      });
    }
    report.pages = { pageChunks: pageSizes, rows: expected.length };
  });

  it("is deterministic: an independent rebuild stores byte-identical rows", async () => {
    const [a, b] = [await chunkDumpBySource(dbs[0]!.db), await chunkDumpBySource(dbs[1]!.db)];
    expect(a.length).toBeGreaterThan(WINDOW_CHUNKS);
    expect(b).toEqual(a);
    for (const { db: pdb } of dbs) {
      const row = await indexRow(pdb);
      expect({
        embeddingVersion: row?.embeddingVersion,
        chunkerVersion: row?.chunkerVersion,
        chunkTokens: Number(row?.chunkTokens),
        quantization: row?.quantization,
        dimensions: Number(row?.dimensions),
      }).toEqual(CODE_INDEX_CONFIG);
    }
  });
});
