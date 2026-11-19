/**
 * Search by meaning with the REAL model, end to end (M5.2; opt-in, `npm run test:model`,
 * needs the installed model). The synthetic research sets (docs/spikes/m5.0/eval) are
 * imported into temporary databases, indexed through the indexer with the production
 * inference child, and every research query goes through `searchByMeaning` (the query
 * process, the cache, the exact-word search and the gated fusion), as the Search page does.
 *
 * - Relevance: nDCG@10 of the result order, v0 queries on the v0 corpus and long queries
 *   on the combined corpus (as in M5.0 and M5.1a), at least 0.8 on both (Experiment 2,
 *   gated fusion: 0.83 and 0.83). Semantic-only is measured alongside for the report.
 * - Latency: warm searches, p95 under 300 ms (ADR 0002's revisit threshold).
 * - Natural-language searches in a chatter-heavy archive (quality regression, 2026-11-13):
 *   the reported misses ("some recipe", "when i was debugging some code") and close
 *   variants find their conversation first, with a real passage, not an acknowledgement.
 * Set THREADATLAS_SEARCH_REPORT=<file> to write the numbers as JSON.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHAT_CORPUS, CHAT_FILLER } from "../../../../tests/helpers/chat-corpus";
import { importText } from "../../../../tests/helpers/import";
import { migrateTestDatabase } from "../../../../tests/helpers/migrate";
import { conversationWithTexts } from "../../../../tests/helpers/semantic-index";
import { exportText } from "../../../../tests/helpers/synthetic-export";
import { testEnv } from "../../../../tests/helpers/test-db";
import { createPrismaClient, type DbClient } from "../../db/client";
import { runIndexer } from "../index/indexer";
import { InferenceProcess, productionChildEntry } from "../inference-process";
import { resolveModelDir } from "../model-files";
import { searchByMeaning } from "./meaning-search";
import { closeQueryHost, embedQueryText } from "./query-host";
import { currentVectors, dropVectorCache, topConversations } from "./vector-cache";

type Conversation = { id: string; messages: string[] };
type Query = { id: string; text: string; relevant: Record<string, number> };
type EvalSet = { conversations: Conversation[]; queries: Query[] };

const ROOT = process.cwd();
const readJson = <T,>(p: string): T => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8")) as T;
const v0 = readJson<EvalSet>("docs/spikes/m5.0/eval/dataset.json");
const long = readJson<EvalSet>("docs/spikes/m5.0/eval/long.json");
const report: Record<string, unknown> = {};
const dirs: string[] = [];
const clients: DbClient[] = [];

async function indexedDb(convs: Conversation[]): Promise<{ db: DbClient; sourceOf: Map<string, string> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "threadatlas-meaning-model-"));
  dirs.push(dir);
  const file = path.join(dir, "search.db");
  migrateTestDatabase(file);
  const env = testEnv(file);
  const db = createPrismaClient({ env, root: ROOT });
  const reader = createPrismaClient({ env, root: ROOT });
  clients.push(db, reader);
  expect((await importText(exportText(convs.map((c) => conversationWithTexts(c.id, c.messages))), { writer: { db, dbPath: file } })).complete).toBe(true);
  const modelDir = resolveModelDir({ env: process.env, root: ROOT });
  const r = await runIndexer({ writer: { db, dbPath: file }, reader, openEmbedder: () => InferenceProcess.start({ entry: productionChildEntry(ROOT), modelDir }) });
  expect(r.status).toBe("finished");
  const sourceOf = new Map((await db.conversation.findMany({ select: { id: true, sourceId: true } })).map((c) => [c.id, c.sourceId]));
  return { db, sourceOf };
}

function ndcgAt10(ranking: string[], relevant: Record<string, number>): number {
  const dcg = ranking.slice(0, 10).reduce((s, id, i) => s + (2 ** (relevant[id] ?? 0) - 1) / Math.log2(i + 2), 0);
  const ideal = Object.values(relevant).sort((a, b) => b - a).slice(0, 10).reduce((s, g, i) => s + (2 ** g - 1) / Math.log2(i + 2), 0);
  return ideal ? dcg / ideal : 0;
}

async function evaluate(set: EvalSet, db: DbClient, sourceOf: Map<string, string>) {
  dropVectorCache(); // one cache per server process; these are two databases
  let fused = 0;
  let semantic = 0;
  let relevant = 0;
  let relevantClose = 0;
  let closeShown = 0;
  const times: number[] = [];
  for (const q of set.queries) {
    const t0 = performance.now();
    const r = await searchByMeaning(db, q.text, "1");
    times.push(performance.now() - t0);
    if (r.status !== "ok") throw new Error(`search ${r.status}`);
    expect(r.notice).toBeNull();
    fused += ndcgAt10(r.results.map((x) => sourceOf.get(x.conversationId)!), q.relevant);
    const close = new Set(r.results.filter((x) => x.close).map((x) => sourceOf.get(x.conversationId)!));
    closeShown += close.size;
    for (const id of Object.keys(q.relevant)) {
      relevant++;
      if (close.has(id)) relevantClose++;
    }
    const e = await embedQueryText(q.text);
    const v = await currentVectors(db, e.info);
    if (!v.ok) throw new Error(v.code);
    semantic += ndcgAt10(topConversations(v.cache, e.vector, 50, { correctGeneric: true }).map((h) => sourceOf.get(h.conversationId)!), q.relevant);
  }
  const warm = times.slice(1).sort((a, b) => a - b);
  const pct = (p: number) => Math.round(warm[Math.min(warm.length - 1, Math.floor(warm.length * p))]!);
  return {
    queries: set.queries.length,
    fusedNdcg10: +(fused / set.queries.length).toFixed(3),
    semanticOnlyNdcg10: +(semantic / set.queries.length).toFixed(3),
    relevantAmongCloseMatches: +(relevantClose / relevant).toFixed(3),
    avgCloseMatches: +(closeShown / set.queries.length).toFixed(1),
    firstSearchMs: Math.round(times[0]!),
    warmP50Ms: pct(0.5),
    warmP95Ms: pct(0.95),
  };
}

let v0Db: Awaited<ReturnType<typeof indexedDb>>;
let allDb: Awaited<ReturnType<typeof indexedDb>>;

beforeAll(async () => {
  await closeQueryHost();
  v0Db = await indexedDb(v0.conversations);
  allDb = await indexedDb([...v0.conversations, ...long.conversations]);
}, 240_000);

afterAll(async () => {
  await closeQueryHost();
  for (const c of clients) await c.$disconnect();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  const out = process.env.THREADATLAS_SEARCH_REPORT;
  if (out) fs.writeFileSync(out, JSON.stringify(report, null, 1));
});

describe("search by meaning with the real model", () => {
  it("meets the relevance bar on the v0 research set (v0 corpus)", async () => {
    const r = await evaluate(v0, v0Db.db, v0Db.sourceOf);
    report.v0 = r;
    expect(r.fusedNdcg10).toBeGreaterThanOrEqual(0.8);
    // Relevance cutoff: most relevant conversations are close matches, among a handful shown.
    expect(r.relevantAmongCloseMatches).toBeGreaterThanOrEqual(0.75);
    expect(r.avgCloseMatches).toBeLessThanOrEqual(8);
    expect(r.warmP95Ms).toBeLessThan(300);
  }, 240_000);

  it("meets the relevance bar on the long research set (combined corpus)", async () => {
    const r = await evaluate(long, allDb.db, allDb.sourceOf);
    report.long = r;
    expect(r.fusedNdcg10).toBeGreaterThanOrEqual(0.8);
    // Relevance cutoff: most relevant conversations are close matches, among a handful shown.
    expect(r.relevantAmongCloseMatches).toBeGreaterThanOrEqual(0.75);
    expect(r.avgCloseMatches).toBeLessThanOrEqual(8);
    expect(r.warmP95Ms).toBeLessThan(300);
  }, 240_000);
});

describe("natural-language searches in a chatter-heavy archive (quality regression)", () => {
  const QUERIES: [string, string][] = [
    ["some recipe", "dinner-idea"],
    ["recipe", "dinner-idea"],
    ["something to cook tonight", "dinner-idea"],
    ["when i was debugging some code", "python-keyerror"],
    ["fixing an error in my script", "python-keyerror"],
    ["debugging", "python-keyerror"],
    ["python", "python-keyerror"],
  ];

  it("finds the conversation first, showing a real passage", async () => {
    const chat = await indexedDb([...CHAT_CORPUS, ...CHAT_FILLER]);
    dropVectorCache();
    const ranks: Record<string, number> = {};
    const firstPassages: Record<string, number> = {};
    const closeCounts: Record<string, number> = {};
    for (const [q, target] of QUERIES) {
      const r = await searchByMeaning(chat.db, q, "1");
      if (r.status !== "ok") throw new Error(`search ${r.status}`);
      ranks[q] = r.results.findIndex((x) => chat.sourceOf.get(x.conversationId) === target) + 1; // 0: not in the 50
      firstPassages[q] = (r.results[0]?.snippet ?? []).map((x) => x.text).join("").length;
      closeCounts[q] = r.results.filter((x) => x.close).length;
    }
    report.naturalLanguage = { conversations: CHAT_CORPUS.length + CHAT_FILLER.length, ranks, firstPassageLength: firstPassages, closeMatches: closeCounts };
    for (const [q] of QUERIES) {
      expect(ranks[q], q).toBe(1);
      expect(firstPassages[q], q).toBeGreaterThan(40); // an answer, not "thanks!"
    }
  }, 300_000);
});

describe("natural-language queries over the mind-map v2 set (generic-passage correction, 2026-11-19)", () => {
  // The 453 hand-written synthetic conversations (English, Norwegian, Russian), rebuilt into a
  // temporary directory, and the frozen topic-judged queries of the search spike
  // (docs/spikes/search-v3). Before the correction: meaning-only nDCG@10 0.556; after: 0.596 in
  // the spike. "work-evening" is the query from the UI review.
  it("ranks by meaning better than before, with a fully relevant first result for the reported query", async () => {
    const { spawnSync } = await import("node:child_process");
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "threadatlas-v2-build-"));
    dirs.push(out);
    const built = spawnSync(process.execPath, [path.join(ROOT, "docs/spikes/mindmap/v2/build.mjs"), "--out", out], { encoding: "utf8" });
    expect(built.status).toBe(0);
    type V2 = { id: string; messages: { text: string }[] };
    const convs = (JSON.parse(fs.readFileSync(path.join(out, "conversations.json"), "utf8")) as V2[]).map((c) => ({ id: c.id, messages: c.messages.map((m) => m.text) }));
    const labels = JSON.parse(fs.readFileSync(path.join(out, "labels.json"), "utf8")) as Record<string, { topic: string; topic2: string | null; oneoff: boolean }>;
    const { QUERIES: V2_QUERIES } = (await import(path.join(ROOT, "docs/spikes/search-v3/queries-v2.mjs"))) as { QUERIES: { id: string; text: string; grades: Record<string, number> }[] };
    const set = await indexedDb(convs);
    dropVectorCache();
    const grade = (q: { grades: Record<string, number> }, id: string) => {
      const l = labels[id]!;
      return l.oneoff ? 0 : Math.max(0, ...[l.topic, l.topic2].filter((t): t is string => t !== null).map((t) => q.grades[t] ?? 0));
    };
    let semantic = 0;
    const perQuery: Record<string, number> = {};
    for (const q of V2_QUERIES) {
      const relevant = Object.fromEntries(convs.map((c) => [c.id, grade(q, c.id)]).filter(([, g]) => (g as number) > 0));
      const e = await embedQueryText(q.text);
      const v = await currentVectors(set.db, e.info);
      if (!v.ok) throw new Error(v.code);
      const x = ndcgAt10(topConversations(v.cache, e.vector, 50, { correctGeneric: true }).map((h) => set.sourceOf.get(h.conversationId)!), relevant);
      perQuery[q.id] = +x.toFixed(3);
      semantic += x;
    }
    const mean = semantic / V2_QUERIES.length;
    const r = await searchByMeaning(set.db, "I can't stop thinking about work in the evening", "1");
    if (r.status !== "ok") throw new Error(`search ${r.status}`);
    const titles = r.results.slice(0, 10).map((x) => set.sourceOf.get(x.conversationId)!);
    report.v2 = { conversations: convs.length, queries: V2_QUERIES.length, semanticOnlyNdcg10: +mean.toFixed(3), perQuery, workEveningTop10: titles };
    expect(mean).toBeGreaterThanOrEqual(0.58); // 0.556 before the correction
    // The reported query: a fully relevant conversation first.
    expect(grade(V2_QUERIES.find((q) => q.id === "work-evening")!, titles[0]!)).toBe(2);
  }, 600_000);
});
