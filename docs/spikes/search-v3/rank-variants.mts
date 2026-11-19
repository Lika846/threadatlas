// Search quality spike (2026-11-19), step 2: conversation scoring variants on three query sets
// with graded judgements, meaning-only (the part that changes; exact-word fusion is unchanged):
//   v0     the M5.0 research queries on their corpus (docs/spikes/m5.0/eval/dataset.json)
//   long   the M5.0 long-conversation queries on the combined corpus (long.json + dataset.json)
//   v2     natural-language queries over the mind-map v2 set, judged by topic labels (queries-v2.mjs)
// Production chunks and int8 vectors (embed scripts); queries embedded by the production model.
// Synthetic data only; no database.
//   chat   the chatter-heavy archive of the model test (34 conversations + 300 template fillers)
//          with its seven regression queries (embed-chat.mts), added after a first fix failed there
// Usage: fnm exec --using=24 -- node docs/spikes/search-v3/rank-variants.mts <v1.json> <v2.json> <chat.json> <out.md>
import fs from "node:fs";
import path from "node:path";
import { InferenceProcess, productionChildEntry } from "../../../src/lib/semantic/inference-process.ts";
import { resolveModelDir } from "../../../src/lib/semantic/model-files.ts";
import { MIN_SEARCH_TOKENS } from "../../../src/lib/semantic/search/vector-cache.ts";
import { dequantizeInt8, quantizeInt8 } from "../../../src/lib/semantic/quantize.ts";
import { conceptVectors } from "../../../src/lib/semantic/topics/concept-names.ts";
import { load, type Item } from "../mindmap/v3/shared-v3.mts";
import { QUERIES } from "./queries-v2.mjs";

const ROOT = process.cwd();
const [v1File, v2File, chatFile, outFile] = process.argv.slice(2);
if (!v1File || !v2File || !chatFile || !outFile) throw new Error("usage: rank-variants.mts <v1.json> <v2.json> <chat.json> <out.md>");
const int8 = (v: number[]) => Float64Array.from(dequantizeInt8(quantizeInt8(Float32Array.from(v)), v.length));
const chatItems: Item[] = (JSON.parse(fs.readFileSync(chatFile, "utf8")) as { id: string; chunks: { msg: number; tokenCount: number; text: string; v: number[] }[] }[]).map((c) => ({
  id: c.id, set: "test", lang: "en", title: null, messages: [], messageLangs: null, titleV: null, topics: [], themes: [], oneoff: false,
  chunks: c.chunks.map((k) => ({ msg: k.msg, role: "", tokenCount: k.tokenCount, text: k.text, v: int8(k.v) })),
}));
const CHAT_QUERIES: [string, string][] = [
  ["some recipe", "dinner-idea"], ["recipe", "dinner-idea"], ["something to cook tonight", "dinner-idea"],
  ["when i was debugging some code", "python-keyerror"], ["fixing an error in my script", "python-keyerror"], ["debugging", "python-keyerror"], ["python", "python-keyerror"],
];
type Q = { id: string; text: string; relevant: Record<string, number> };
const evalSet = (f: string) => JSON.parse(fs.readFileSync(path.join(ROOT, "docs/spikes/m5.0/eval", f), "utf8")) as { conversations: { id: string }[]; queries: Q[] };
const v0 = evalSet("dataset.json");
const long = evalSet("long.json");
const dev = load("dev", v1File, ROOT);
const v2 = load("test", v2File, ROOT);
const byDevId = new Map(dev.map((c) => [c.id.replace(/^dev:/, ""), c]));
const corpus = (ids: string[]) => ids.map((id) => byDevId.get(id)!).filter(Boolean);

const sets: { name: string; items: Item[]; queries: { id: string; text: string; grade: (c: Item) => number }[] }[] = [
  { name: "v0 (research)", items: corpus(v0.conversations.map((c) => c.id)), queries: v0.queries.map((q) => ({ id: q.id, text: q.text, grade: (c: Item) => q.relevant[c.id.replace(/^dev:/, "")] ?? 0 })) },
  {
    name: "long (research)",
    items: corpus([...long.conversations, ...v0.conversations].map((c) => c.id)),
    queries: long.queries.map((q) => ({ id: q.id, text: q.text, grade: (c: Item) => q.relevant[c.id.replace(/^dev:/, "")] ?? 0 })),
  },
  {
    name: "v2 (topic-judged)",
    items: v2,
    queries: QUERIES.map((q) => ({ id: q.id, text: q.text, grade: (c: Item) => (c.oneoff ? 0 : Math.max(0, ...c.topics.map((t) => (q.grades as unknown as Record<string, number>)[t] ?? 0))) })),
  },
  { name: "chat (regression)", items: chatItems, queries: CHAT_QUERIES.map(([text, target]) => ({ id: text, text, grade: (c: Item) => (c.id === target ? 2 : 0) })) },
];
/** Per set: the mean of its distinct chunk vectors (the corpus's common direction), normalised. */
const corpusMean = new Map<Item[], Float64Array>();
for (const set of sets) {
  const dims = set.items[0]!.chunks[0]!.v.length;
  const m = new Float64Array(dims);
  const seen = new Set<string>();
  for (const c of set.items) for (const k of c.chunks) {
    const key = k.text ?? "";
    if (key && seen.has(key)) continue;
    seen.add(key);
    for (let d = 0; d < dims; d++) m[d]! += k.v[d]!;
  }
  const n = Math.hypot(...m) || 1;
  corpusMean.set(set.items, m.map((x) => x / n));
}
let currentMean: Float64Array = new Float64Array(0);

const p = await InferenceProcess.start({ entry: productionChildEntry(ROOT), modelDir: resolveModelDir({ env: process.env, root: ROOT }) });
const qv = new Map<string, Float32Array>();
for (const s of sets) for (const q of s.queries) if (!qv.has(q.text)) qv.set(q.text, await p.embedQuery(q.text));
await p.close();

const background = conceptVectors()!.map((c) => c.vector); // general queries, for "hub" chunks
const dotQ = (q: Float32Array | Float64Array, v: Float64Array) => {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += q[i]! * v[i]!;
  return s;
};
/** Per chunk: mean similarity to every background query. */
const hubAllCache = new Map<Float64Array, number>();
const hubAll = (v: Float64Array) => {
  let h = hubAllCache.get(v);
  if (h === undefined) {
    h = background.reduce((a, b) => a + dotQ(b, v), 0) / background.length;
    hubAllCache.set(v, h);
  }
  return h;
};
/** Per chunk: mean of its 10 highest similarities to the background queries (how "generic" it is). */
const hubCache = new Map<Float64Array, number>();
const hub = (v: Float64Array) => {
  let h = hubCache.get(v);
  if (h === undefined) {
    const s = background.map((b) => dotQ(b, v)).sort((a, b) => b - a);
    h = s.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
    hubCache.set(v, h);
  }
  return h;
};

type Variant = { name: string; score: (q: Float32Array, c: Item) => number };
const pool = (c: Item) => {
  const longChunks = c.chunks.filter((k) => k.tokenCount >= MIN_SEARCH_TOKENS);
  return longChunks.length > 0 ? longChunks : c.chunks;
};
const topMean = (xs: number[], k: number) => {
  const s = [...xs].sort((a, b) => b - a).slice(0, k);
  return s.reduce((a, b) => a + b, 0) / s.length;
};
const variants: Variant[] = [
  { name: "max chunk (production)", score: (q, c) => Math.max(...pool(c).map((k) => dotQ(q, k.v))) },
  { name: "½ max + ½ mean of best 3", score: (q, c) => { const s = pool(c).map((k) => dotQ(q, k.v)); return 0.5 * Math.max(...s) + 0.5 * topMean(s, 3); } },
  { name: "½ max + ½ mean of best 2", score: (q, c) => { const s = pool(c).map((k) => dotQ(q, k.v)); return 0.5 * Math.max(...s) + 0.5 * topMean(s, 2); } },
  ...[0.25, 0.5, 0.75, 1].map((b) => ({ name: `max of (chunk − ${b}·hub)`, score: (q: Float32Array, c: Item) => Math.max(...pool(c).map((k) => dotQ(q, k.v) - b * hub(k.v))) })),
  ...[0.5, 1, 2].map((b) => ({ name: `max of (chunk − ${b}·mean similarity to all subjects)`, score: (q: Float32Array, c: Item) => Math.max(...pool(c).map((k) => dotQ(q, k.v) - b * hubAll(k.v))) })),
  ...[0.25, 0.5, 1].map((b) => ({ name: `max of (chunk − ${b}·similarity to the corpus mean)`, score: (q: Float32Array, c: Item) => Math.max(...pool(c).map((k) => dotQ(q, k.v) - b * dotQ(currentMean, k.v))) })),
  {
    name: "max of centred cosine q·(chunk − mean)/‖chunk − mean‖",
    score: (q: Float32Array, c: Item) =>
      Math.max(
        ...pool(c).map((k) => {
          const mu = currentMean;
          const proj = dotQ(mu, k.v);
          const r = k.v.map((x, i) => x - proj * mu[i]!);
          return dotQ(q, r) / (Math.hypot(...r) || 1);
        }),
      ),
  },
  ...[0.5, 1].map((b) => ({
    name: `½ max + ½ best-3 mean, of (chunk − ${b}·hub)`,
    score: (q: Float32Array, c: Item) => { const s = pool(c).map((k) => dotQ(q, k.v) - b * hub(k.v)); return 0.5 * Math.max(...s) + 0.5 * topMean(s, 3); },
  })),
];

const ndcg = (grades: number[], ideal: number[], k = 10) => {
  const dcg = (g: number[]) => g.slice(0, k).reduce((s, x, i) => s + (2 ** x - 1) / Math.log2(i + 2), 0);
  const i = dcg([...ideal].sort((a, b) => b - a));
  return i > 0 ? dcg(grades) / i : 0;
};
const lines = ["# Search spike: conversation scoring variants (meaning only)", "", "Generated by `rank-variants.mts`. nDCG@10 (graded); MRR of the first fully relevant result; recall@10 of anything relevant; and worst query (lowest nDCG@10).", ""];
const perQuery: string[] = [];
for (const set of sets) {
  currentMean = corpusMean.get(set.items)!;
  lines.push(`## ${set.name}: ${set.items.length} conversations, ${set.queries.length} queries`, "", "| Variant | nDCG@10 | MRR | Recall@10 | Worst query |", "| --- | --- | --- | --- | --- |");
  for (const v of variants) {
    let n = 0, mrr = 0, rec = 0, worst = { id: "", x: Infinity };
    for (const q of set.queries) {
      const vec = qv.get(q.text)!;
      const ranked = set.items.map((c) => ({ c, s: v.score(vec, c) })).sort((a, b) => b.s - a.s || (a.c.id < b.c.id ? -1 : 1));
      const grades = ranked.map((r) => q.grade(r.c));
      const top = Math.max(...set.items.map(q.grade));
      const x = ndcg(grades, set.items.map(q.grade));
      n += x;
      const first = grades.findIndex((g) => g === top);
      mrr += first >= 0 ? 1 / (first + 1) : 0;
      const relevant = grades.filter((g) => g > 0).length;
      rec += relevant > 0 ? grades.slice(0, 10).filter((g) => g > 0).length / Math.min(10, relevant) : 0;
      if (x < worst.x) worst = { id: q.id, x };
      if (set.name.startsWith("v2") && (v === variants[0] || v.name === "max of (chunk − 0.5·hub)")) perQuery.push(`| ${v === variants[0] ? "production" : "candidate"} | ${q.id} | ${x.toFixed(2)} | ${first + 1} |`);
    }
    const k = set.queries.length;
    lines.push(`| ${v.name} | **${(n / k).toFixed(3)}** | ${(mrr / k).toFixed(3)} | ${(rec / k).toFixed(3)} | ${worst.id} (${worst.x.toFixed(2)}) |`);
  }
  lines.push("");
}
// Close-match tier: conversations within a margin of the best score (as CLOSE_MATCH_MARGIN does).
lines.push("## Close-match tier (score within the margin of the best)", "", "Mean tier size, and the share of each query's relevant conversations (any grade) that are in it, per set.", "", "| Variant | Margin | v0 size / recall | long size / recall | v2 size / recall | chat size / recall |", "| --- | --- | --- | --- | --- | --- |");
for (const v of variants) {
  for (const m of [0.03]) {
    const cells = sets.map((set) => {
      currentMean = corpusMean.get(set.items)!;
      let size = 0, rec = 0;
      for (const q of set.queries) {
        const vec = qv.get(q.text)!;
        const sc = set.items.map((c) => ({ c, s: v.score(vec, c) }));
        const best = Math.max(...sc.map((x) => x.s));
        const tier = sc.filter((x) => x.s >= best - m);
        size += tier.length;
        const relevant = set.items.filter((c) => q.grade(c) > 0).length;
        rec += relevant > 0 ? tier.filter((x) => q.grade(x.c) > 0).length / relevant : 0;
      }
      return `${(size / set.queries.length).toFixed(1)} / ${Math.round((rec / set.queries.length) * 100)}%`;
    });
    lines.push(`| ${v.name} | ${m} | ${cells.join(" | ")} |`);
  }
}
lines.push("");
lines.push("## v2 per query (production vs max of (chunk − 0.5·hub))", "", "| Variant | Query | nDCG@10 | Rank of first fully relevant |", "| --- | --- | --- | --- |", ...perQuery, "");
fs.writeFileSync(outFile, lines.join("\n"));
console.log(lines.join("\n"));
