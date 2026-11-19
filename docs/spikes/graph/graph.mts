// Graph spike: which conversation similarity and which edge rule give a readable graph of
// meaningful links? Synthetic data only (mind-map v2 set and its generic-boilerplate variant).
// Usage: fnm exec --using=24 -- node docs/spikes/graph/graph.mts <conversations.json> <vectors.json> <name> [generic.json]
import fs from "node:fs";
import { dequantizeInt8, quantizeInt8 } from "../../../src/lib/semantic/quantize.ts";
import { MIN_SEARCH_TOKENS } from "../../../src/lib/semantic/search/vector-cache.ts";
import { detectLanguage, resolveLanguages, type Lang } from "../../../src/lib/semantic/topics/lang.ts";

const [convFile, vecFile, name, genericFile] = process.argv.slice(2);
if (!convFile || !vecFile || !name) throw new Error("usage: graph.mts <conversations.json> <vectors.json> <name> [generic.json]");
const OUT = "docs/spikes/graph/results";
type Label = { theme: string; topic: string; topic2: string | null; theme2: string | null; oneoff: boolean; lang: string };
const labels = JSON.parse(fs.readFileSync("docs/spikes/mindmap/v2/labels.json", "utf8")) as Record<string, Label>;
const convText = new Map((JSON.parse(fs.readFileSync(convFile, "utf8")) as { id: string; messages: { text: string }[] }[]).map((c) => [c.id, c.messages.map((m) => m.text)]));
const genericMsg: Record<string, number> = genericFile ? JSON.parse(fs.readFileSync(genericFile, "utf8")) : {};
type RawChunk = { msg: number; tokenCount: number; text: string; v: number[] };
const raw = (JSON.parse(fs.readFileSync(vecFile, "utf8")) as { id: string; title: string | null; chunks: RawChunk[] }[]).sort((a, b) => (a.id < b.id ? -1 : 1));

const DIMS = 384;
const int8 = (v: number[]) => Float64Array.from(dequantizeInt8(quantizeInt8(Float32Array.from(v)), v.length));
const normalise = (v: Float64Array) => {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i]! /= n;
  return v;
};
const dot = (a: Float64Array, b: Float64Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};

type Chunk = { conv: number; msg: number; text: string; short: boolean; generic: boolean; lang: Lang; v: Float64Array };
type Item = { id: string; title: string; lang: string; topics: string[]; themes: string[]; topic: string; theme: string; oneoff: boolean; chunks: Chunk[] };
const items: Item[] = raw.map((c, conv) => {
  const l = labels[c.id]!;
  const msgs = [...new Set(c.chunks.map((k) => k.msg))].sort((a, b) => a - b);
  const text = convText.get(c.id)!;
  const langs = resolveLanguages(msgs.map((m) => detectLanguage(text[m]!)));
  const langOf = new Map(msgs.map((m, i) => [m, langs[i]!]));
  return {
    id: c.id,
    title: c.title ?? "(untitled)",
    lang: l.lang,
    topic: l.topic,
    theme: l.theme,
    topics: l.oneoff ? [l.topic] : [l.topic, ...(l.topic2 ? [l.topic2] : [])],
    themes: l.oneoff ? [l.topic] : [...new Set([l.theme, ...(l.theme2 ? [l.theme2] : [])])],
    oneoff: l.oneoff,
    chunks: c.chunks.map((k) => ({ conv, msg: k.msg, text: k.text, short: k.tokenCount < MIN_SEARCH_TOKENS, generic: genericMsg[c.id] === k.msg, lang: langOf.get(k.msg)!, v: int8(k.v) })),
  };
});
const n = items.length;
const lines: string[] = [];
const log = (s = "") => {
  lines.push(s);
  console.log(s);
};
const f2 = (x: number) => x.toFixed(2);
const pct = (x: number) => `${Math.round(x * 100)}%`;

// ---------------------------------------------------------------- representations
/** Long chunks of a conversation, or all when it has none (as production). */
const used = (it: Item) => {
  const long = it.chunks.filter((k) => !k.short);
  return long.length > 0 ? long : it.chunks;
};
/** Chunks with their language's mean removed (tree-map rule: own mean for a language in ≥ 2 conversations, else the global mean). */
function correctedChunks(): Chunk[][] {
  const all = new Float64Array(DIMS);
  let count = 0;
  const by = new Map<Lang, { s: Float64Array; c: number; convs: Set<number> }>();
  for (const it of items)
    for (const k of it.chunks) {
      let a = by.get(k.lang);
      if (!a) by.set(k.lang, (a = { s: new Float64Array(DIMS), c: 0, convs: new Set() }));
      for (let d = 0; d < DIMS; d++) {
        a.s[d]! += k.v[d]!;
        all[d]! += k.v[d]!;
      }
      a.c++;
      count++;
      a.convs.add(k.conv);
    }
  const g = all.map((x) => x / count);
  const mean = new Map([...by].map(([l, a]) => [l, l !== "other" && a.convs.size >= 2 ? a.s.map((x) => x / a.c) : g]));
  return items.map((it) => it.chunks.map((k) => ({ ...k, v: normalise(Float64Array.from(k.v, (x, d) => x - mean.get(k.lang)![d]!)) })));
}
const centre = (vs: Float64Array[]) => {
  const m = new Float64Array(DIMS);
  for (const v of vs) for (let d = 0; d < DIMS; d++) m[d]! += v[d]! / vs.length;
  return vs.map((v) => normalise(Float64Array.from(v, (x, d) => x - m[d]!)));
};
const meanVec = (cs: Chunk[]) => {
  const out = new Float64Array(DIMS);
  for (const k of cs) for (let d = 0; d < DIMS; d++) out[d]! += k.v[d]!;
  return normalise(out);
};
function fromVectors(vs: Float64Array[]): Float32Array {
  const S = new Float32Array(n * n);
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const s = dot(vs[i]!, vs[j]!);
      S[i * n + j] = s;
      S[j * n + i] = s;
    }
  return S;
}
/** Max and symmetric Chamfer (mean best match) over chunk pairs; also the best pair per conversation pair. */
function fromChunks(chunks: Chunk[][]): { max: Float32Array; chamfer: Float32Array; best: Int32Array; flat: Chunk[] } {
  const flat = items.flatMap((it, i) => {
    const u = new Set(used(it));
    return chunks[i]!.filter((_, ki) => u.has(it.chunks[ki]!));
  });
  const m = flat.length;
  const max = new Float32Array(n * n).fill(-Infinity);
  const best = new Int32Array(n * n * 2).fill(-1);
  const acc = new Float64Array(n * n);
  const count = new Int32Array(n);
  for (const k of flat) count[k.conv]!++;
  const perConv = new Float64Array(n);
  const perConvArg = new Int32Array(n);
  for (let a = 0; a < m; a++) {
    perConv.fill(-Infinity);
    const ka = flat[a]!;
    for (let b = 0; b < m; b++) {
      const kb = flat[b]!;
      if (kb.conv === ka.conv) continue;
      const s = dot(ka.v, kb.v);
      if (s > perConv[kb.conv]!) {
        perConv[kb.conv] = s;
        perConvArg[kb.conv] = b;
      }
    }
    for (let c = 0; c < n; c++) {
      if (c === ka.conv) continue;
      const o = ka.conv * n + c;
      acc[o]! += perConv[c]!;
      if (perConv[c]! > max[o]!) {
        max[o] = perConv[c]!;
        best[o * 2] = a;
        best[o * 2 + 1] = perConvArg[c]!;
      }
    }
  }
  const chamfer = new Float32Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) chamfer[i * n + j] = (acc[i * n + j]! / count[i]! + acc[j * n + i]! / count[j]!) / 2;
  return { max, chamfer, best, flat };
}

const t0 = performance.now();
const corrected = correctedChunks();
const reps = new Map<string, Float32Array>();
const timing = new Map<string, number>();
let t = performance.now();
reps.set("mean", fromVectors(centre(items.map((it) => meanVec(used(it))))));
timing.set("mean", performance.now() - t);
t = performance.now();
reps.set("mean [det]", fromVectors(centre(items.map((it, i) => meanVec(corrected[i]!.filter((k) => used(it).some((u) => u.msg === k.msg && u.text === k.text)))))));
timing.set("mean [det]", performance.now() - t);
t = performance.now();
const rawPairs = fromChunks(items.map((it) => it.chunks));
timing.set("max / chamfer", performance.now() - t);
reps.set("max", rawPairs.max);
t = performance.now();
const detPairs = fromChunks(corrected);
timing.set("max / chamfer [det]", performance.now() - t);
reps.set("max [det]", detPairs.max);
reps.set("chamfer [det]", detPairs.chamfer);
const prepMs = performance.now() - t0;

// ---------------------------------------------------------------- gold relations
type Rel = "topic" | "theme" | "none";
const rel = (i: number, j: number): Rel => {
  const a = items[i]!, b = items[j]!;
  if (a.topics.some((x) => b.topics.includes(x))) return "topic";
  if (a.themes.some((x) => b.themes.includes(x))) return "theme";
  return "none";
};
/** A link across topics that the labels support: a shared topic or theme, but different primary topics (via a second topic) or different primary themes. */
const crossTopic = (i: number, j: number) => rel(i, j) === "topic" && items[i]!.topic !== items[j]!.topic;
const crossTheme = (i: number, j: number) => rel(i, j) !== "none" && items[i]!.theme !== items[j]!.theme;
let goldTopic = 0, goldCross = 0;
for (let i = 0; i < n; i++)
  for (let j = i + 1; j < n; j++) {
    if (rel(i, j) === "topic") goldTopic++;
    if (crossTopic(i, j)) goldCross++;
  }

// ---------------------------------------------------------------- edge rules
type Edge = [number, number];
const neighbours = (S: Float32Array, i: number) =>
  Array.from({ length: n }, (_, j) => j)
    .filter((j) => j !== i)
    .sort((a, b) => S[i * n + b]! - S[i * n + a]! || a - b);
function csls(S: Float32Array, k = 10): Float32Array {
  const r = Float64Array.from({ length: n }, (_, i) => neighbours(S, i).slice(0, k).reduce((s, j) => s + S[i * n + j]!, 0) / k);
  const out = new Float32Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) out[i * n + j] = 2 * S[i * n + j]! - r[i]! - r[j]!;
  return out;
}
function knn(S: Float32Array, k: number, mutual: boolean): Edge[] {
  const top = Array.from({ length: n }, (_, i) => new Set(neighbours(S, i).slice(0, k)));
  const edges: Edge[] = [];
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const a = top[i]!.has(j), b = top[j]!.has(i);
      if (mutual ? a && b : a || b) edges.push([i, j]);
    }
  return edges;
}
function topPairs(S: Float32Array, meanDegree: number): Edge[] {
  const all: [number, number, number][] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) all.push([i, j, S[i * n + j]!]);
  all.sort((a, b) => b[2] - a[2]);
  return all.slice(0, Math.round((meanDegree * n) / 2)).map(([i, j]) => [i, j]);
}

function graphStats(edges: Edge[]) {
  const deg = new Int32Array(n);
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));
  for (const [i, j] of edges) {
    deg[i]!++;
    deg[j]!++;
    parent[find(i)] = find(j);
  }
  const comp = new Map<number, number>();
  for (let i = 0; i < n; i++) if (deg[i]! > 0) comp.set(find(i), (comp.get(find(i)) ?? 0) + 1);
  let topic = 0, theme = 0, none = 0, cross = 0, crossTh = 0, crossLang = 0;
  for (const [i, j] of edges) {
    const r = rel(i, j);
    if (r === "topic") topic++;
    else if (r === "theme") theme++;
    else none++;
    if (crossTopic(i, j)) cross++;
    if (crossTheme(i, j)) crossTh++;
    if (r !== "none" && items[i]!.lang !== items[j]!.lang) crossLang++;
  }
  const oneoffs = items.map((it, i) => (it.oneoff ? i : -1)).filter((i) => i >= 0);
  return {
    edges: edges.length,
    meanDeg: (2 * edges.length) / n,
    maxDeg: Math.max(...deg),
    isolated: deg.filter((d) => d === 0).length / n,
    isolatedRelated: items.filter((it, i) => !it.oneoff && deg[i] === 0).length / items.filter((it) => !it.oneoff).length,
    lcc: Math.max(0, ...comp.values()) / n,
    pTopic: edges.length ? topic / edges.length : 0,
    pRelated: edges.length ? (topic + theme) / edges.length : 0,
    falseRate: edges.length ? none / edges.length : 0,
    cross,
    crossRecall: cross / goldCross,
    crossTh,
    crossLang: topic + theme ? crossLang / (topic + theme) : 0,
    oneoffLinked: oneoffs.filter((i) => deg[i]! > 0).length / oneoffs.length,
  };
}

/** Precision@k of the nearest neighbours (topic shared), non-one-offs; and how often a second topic is found in the top 5. */
function rankQuality(S: Float32Array) {
  let p1 = 0, p3 = 0, cnt = 0, sec = 0, secN = 0;
  for (let i = 0; i < n; i++) {
    if (items[i]!.oneoff) continue;
    const nb = neighbours(S, i);
    cnt++;
    p1 += rel(i, nb[0]!) === "topic" ? 1 : 0;
    p3 += nb.slice(0, 3).filter((j) => rel(i, j) === "topic").length / 3;
    if (items[i]!.topics.length > 1) {
      const t2 = items[i]!.topics[1]!;
      if (items.some((it, j) => j !== i && it.topics.includes(t2))) {
        secN++;
        if (nb.slice(0, 5).some((j) => items[j]!.topics.includes(t2))) sec++;
      }
    }
  }
  return { p1: p1 / cnt, p3: p3 / cnt, sec: secN ? sec / secN : 0 };
}

// ---------------------------------------------------------------- run
log(`# Graph spike: ${name}\n`);
log(`Synthetic only. ${n} conversations, ${items.reduce((s, it) => s + it.chunks.length, 0)} chunks; ${Object.keys(genericMsg).length} with an added generic message. Gold: ${goldTopic} topic-sharing pairs, ${goldCross} of them cross-topic (via a second topic).\n`);
log(`Preparation ${Math.round(prepMs)} ms: ${[...timing].map(([k, v]) => `${k} ${Math.round(v)} ms`).join(", ")}.\n`);
log("## 1. Nearest-neighbour quality (no edge rule)\n");
log("| representation | P@1 topic | P@3 topic | second topic in top 5 |\n|---|---|---|---|");
for (const [r, S] of reps) {
  const q = rankQuality(S);
  log(`| ${r} | ${f2(q.p1)} | ${f2(q.p3)} | ${f2(q.sec)} |`);
}
log();
log("## 2. Edge rules\n");
log("*related* = shares a topic or theme; *false* = shares neither; *cross-topic* = shares a topic but primary topics differ (recall over all such gold pairs); *cross-theme* = related across primary themes.\n");
const HEADER = "| representation | rule | edges | mean deg | max deg | isolated | related isolated | largest comp | P topic | P related | false | cross-topic (recall) | cross-theme | cross-lang | one-offs linked |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";
const RULES: [string, (S: Float32Array) => Edge[]][] = [
  ["kNN k=3", (S) => knn(S, 3, false)],
  ["mutual k=3", (S) => knn(S, 3, true)],
  ["mutual k=5", (S) => knn(S, 5, true)],
  ["mutual k=10", (S) => knn(S, 10, true)],
  ["top pairs, mean deg 3", (S) => topPairs(S, 3)],
  ["CSLS mutual k=5", (S) => knn(csls(S), 5, true)],
];
/** kNN (or mutual kNN) restricted to pairs at or above an absolute similarity floor. */
const floored = (S: Float32Array, k: number, mutual: boolean, floor: number) => knn(S, k, mutual).filter(([i, j]) => S[i * n + j]! >= floor);
/** The similarity at the top q share of all pairs (for reading the floors). */
function quantile(S: Float32Array, q: number): number {
  const all: number[] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) all.push(S[i * n + j]!);
  all.sort((a, b) => b - a);
  return all[Math.floor(q * all.length)]!;
}
const FLOORS: Record<string, number[]> = { "mean [det]": [0.3, 0.35, 0.4, 0.45, 0.5], "chamfer [det]": [0.25, 0.3, 0.35, 0.4], "max [det]": [0.5, 0.6, 0.7] };
const edgeSets = new Map<string, Edge[]>();
for (const [r, floors] of Object.entries(FLOORS)) {
  log(`Similarity at the top 0.5% / 1% / 2% of all pairs, ${r}: ${[0.005, 0.01, 0.02].map((q) => f2(quantile(reps.get(r)!, q))).join(" / ")}`);
  for (const fl of floors) {
    RULES.push([`kNN k=5, ${r} ≥ ${fl}`, (S) => (S === reps.get(r) ? floored(S, 5, false, fl) : [])]);
    RULES.push([`mutual k=5, ${r} ≥ ${fl}`, (S) => (S === reps.get(r) ? floored(S, 5, true, fl) : [])]);
  }
}
log();
log(HEADER);
for (const [r, S] of reps)
  for (const [rule, f] of RULES) {
    if (rule.includes("≥") && !rule.endsWith(`${r} ≥ ${rule.split("≥ ")[1]}`)) continue;
    const e = f(S);
    edgeSets.set(`${r} | ${rule}`, e);
    const g = graphStats(e);
    log(`| ${r} | ${rule} | ${g.edges} | ${g.meanDeg.toFixed(1)} | ${g.maxDeg} | ${pct(g.isolated)} | ${pct(g.isolatedRelated)} | ${pct(g.lcc)} | ${f2(g.pTopic)} | ${f2(g.pRelated)} | **${f2(g.falseRate)}** | ${g.cross} (${f2(g.crossRecall)}) | ${g.crossTh} | ${pct(g.crossLang)} | ${pct(g.oneoffLinked)} |`);
  }
log();

// Generic boilerplate: for max-type links, how often is the best pair a generic chunk, and how wrong are those?
if (Object.keys(genericMsg).length > 0) {
  log("## 3. Generic boilerplate\n");
  log("| representation | rule | edges whose best chunk pair has a generic chunk | of those, false | false edges overall |\n|---|---|---|---|---|");
  for (const [r, pairs] of [["max", rawPairs], ["max [det]", detPairs], ["chamfer [det]", detPairs]] as const)
    for (const rule of ["mutual k=5", "CSLS mutual k=5"]) {
      const e = edgeSets.get(`${r} | ${rule}`)!;
      let g = 0, gn = 0, none = 0;
      for (const [i, j] of e) {
        const o = (i * n + j) * 2;
        const a = pairs.flat[pairs.best[o]!]!, b = pairs.flat[pairs.best[o + 1]!]!;
        const isG = a.generic || b.generic;
        if (isG) g++;
        if (rel(i, j) === "none") {
          none++;
          if (isG) gn++;
        }
      }
      log(`| ${r} | ${rule} | ${g} of ${e.length} (${pct(g / e.length)}) | ${gn} | ${none} (${pct(none / e.length)}) |`);
    }
  log();
}

// Examples for reading, with the best-matching passages (corrected chunks) as the "why".
const snippet = (s: string) => JSON.stringify(s.replace(/\s+/g, " ").slice(0, 110));
function examples(key: string, file: string) {
  const e = edgeSets.get(key)!;
  const S = reps.get(key.split(" | ")[0]!)!;
  const out: string[] = [`# Edges: ${key} (${name})\n`, "Each edge: similarity, titles, labels (primary topic / second topic), and the best-matching pair of passages.\n"];
  const fmt = ([i, j]: Edge) => {
    const a = items[i]!, b = items[j]!;
    const o = (i * n + j) * 2;
    const ka = detPairs.flat[detPairs.best[o]!]!, kb = detPairs.flat[detPairs.best[o + 1]!]!;
    const lab = (x: Item) => `${x.oneoff ? "one-off" : `${x.topics.join("+")}`}, ${x.lang}`;
    return `- **${f2(S[i * n + j]!)}** “${a.title}” (${lab(a)}) ↔ “${b.title}” (${lab(b)})${ka.generic || kb.generic ? " **[generic passage]**" : ""}\n  - ${snippet(ka.text)}\n  - ${snippet(kb.text)}`;
  };
  const groups: [string, Edge[]][] = [
    ["Cross-theme links the labels support", e.filter(([i, j]) => crossTheme(i, j))],
    ["Cross-topic links within a theme (via a second topic)", e.filter(([i, j]) => crossTopic(i, j) && !crossTheme(i, j))],
    ["False by the labels (shares neither topic nor theme)", e.filter(([i, j]) => rel(i, j) === "none")],
    ["Same theme, different topic", e.filter(([i, j]) => rel(i, j) === "theme" && !crossTheme(i, j))],
  ];
  for (const [title, es] of groups) {
    out.push(`\n## ${title} (${es.length})\n`);
    out.push(...es.map(fmt));
  }
  fs.writeFileSync(`${OUT}/${file}`, out.join("\n"));
}
for (const key of process.env.EXAMPLES?.split(";") ?? []) examples(key, `edges-${name}-${key.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.md`);

fs.writeFileSync(`${OUT}/metrics-${name}.md`, lines.join("\n"));

// ---------------------------------------------------------------- follow-ups (after reading the edges)
{
  // (a) Evidence for an edge without a global chunk pass: in each conversation, the passage closest to
  // the OTHER conversation's average (corrected chunks). Does it avoid boilerplate better than the best pair?
  const key = "mean [det] | kNN k=5, mean [det] ≥ 0.35";
  const e = edgeSets.get(key)!;
  const mean = items.map((it, i) => meanVec(corrected[i]!.filter((k) => !k.short || used(it).every((u) => u.short))));
  let pairG = 0, centroidG = 0;
  for (const [i, j] of e) {
    const o = (i * n + j) * 2;
    if (detPairs.flat[detPairs.best[o]!]!.generic || detPairs.flat[detPairs.best[o + 1]!]!.generic) pairG++;
    const pick = (x: number, y: number) => corrected[x]!.filter((k) => !k.short || used(items[x]!).every((u) => u.short)).reduce((b, k) => (dot(k.v, mean[y]!) > dot(b.v, mean[y]!) ? k : b));
    if (pick(i, j).generic || pick(j, i).generic) centroidG++;
  }
  log(`## 4. Evidence passages for ${key}\n`);
  log(`Edges whose evidence shows a generic passage: best chunk pair ${pairG} of ${e.length}; passage closest to the other conversation's average ${centroidG} of ${e.length}.\n`);

  // (b) Does an absolute floor carry over to smaller archives? Recompute everything on random subsets.
  log("## 5. The floor on smaller archives (`mean [det]`, kNN k=5 with a floor, recomputed per subset)\n");
  log("| n | floor | mean deg | max deg | related isolated | false |\n|---|---|---|---|---|---|");
  let seed = 99;
  const r = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (const size of [100, 200, 300]) {
    const acc = new Map<number, number[]>();
    for (let draw = 0; draw < 3; draw++) {
      const idx = items.map((_, i) => i).sort(() => r() - 0.5).slice(0, size).sort((a, b) => a - b);
      // language means and centring on the subset only
      const sub = idx.map((i) => items[i]!);
      const all = new Float64Array(DIMS);
      let cnt = 0;
      const by = new Map<Lang, { s: Float64Array; c: number; convs: Set<number> }>();
      sub.forEach((it, si) =>
        it.chunks.forEach((k) => {
          let a = by.get(k.lang);
          if (!a) by.set(k.lang, (a = { s: new Float64Array(DIMS), c: 0, convs: new Set() }));
          for (let d = 0; d < DIMS; d++) {
            a.s[d]! += k.v[d]!;
            all[d]! += k.v[d]!;
          }
          a.c++;
          cnt++;
          a.convs.add(si);
        }),
      );
      const g = all.map((x) => x / cnt);
      const lm = new Map([...by].map(([l, a]) => [l, l !== "other" && a.convs.size >= 2 ? a.s.map((x) => x / a.c) : g]));
      const vs = centre(sub.map((it) => meanVec(used(it).map((k) => ({ ...k, v: normalise(Float64Array.from(k.v, (x, d) => x - lm.get(k.lang)![d]!)) })))));
      const m = sub.length;
      const Ssub = new Float32Array(m * m);
      for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) if (i !== j) Ssub[i * m + j] = dot(vs[i]!, vs[j]!);
      for (const fl of [0.35, 0.4]) {
        const deg = new Int32Array(m);
        const tops = Array.from({ length: m }, (_, i) => new Set(Array.from({ length: m }, (_, j) => j).filter((j) => j !== i).sort((a, b) => Ssub[i * m + b]! - Ssub[i * m + a]!).slice(0, 5)));
        let edges = 0, none = 0;
        for (let i = 0; i < m; i++)
          for (let j = i + 1; j < m; j++) {
            if (!(tops[i]!.has(j) || tops[j]!.has(i)) || Ssub[i * m + j]! < fl) continue;
            edges++;
            deg[i]!++;
            deg[j]!++;
            if (rel(idx[i]!, idx[j]!) === "none") none++;
          }
        const relIso = sub.filter((it, i) => !it.oneoff && deg[i] === 0).length / sub.filter((it) => !it.oneoff).length;
        const v = acc.get(fl) ?? [0, 0, 0, 0];
        v[0]! += (2 * edges) / m;
        v[1]! += Math.max(...deg);
        v[2]! += relIso;
        v[3]! += edges ? none / edges : 0;
        acc.set(fl, v);
      }
    }
    for (const [fl, v] of acc) log(`| ${size} | ${fl} | ${(v[0]! / 3).toFixed(1)} | ${(v[1]! / 3).toFixed(0)} | ${pct(v[2]! / 3)} | ${f2(v[3]! / 3)} |`);
  }
  log();

  // (c) Cost: one conversation's neighbours (ego view) vs all pairs (whole graph), resampled vectors.
  log("## 6. Cost (`mean [det]` vectors, resampled with noise; timing only)\n");
  log("| conversations | one conversation's top 5 (ego view) | ego view with 2nd hop and mutual check (6 rows) | all pairs + kNN (whole graph) |\n|---|---|---|---|");
  const base = centre(items.map((_, i) => meanVec(corrected[i]!)));
  for (const size of [1000, 3000, 10000]) {
    const vs = Array.from({ length: size }, () => normalise(base[Math.floor(r() * n)]!.map((x) => x + (r() - 0.5) * 0.01)));
    const row = (i: number) => {
      const s = new Float32Array(size);
      for (let j = 0; j < size; j++) s[j] = dot(vs[i]!, vs[j]!);
      return s;
    };
    let t1 = performance.now();
    row(0);
    const one = performance.now() - t1;
    t1 = performance.now();
    for (let i = 0; i < 6; i++) row(i);
    const ego = performance.now() - t1;
    let all = "skipped";
    if (size <= 3000) {
      t1 = performance.now();
      for (let i = 0; i < size; i++) {
        const s = row(i);
        let top = -Infinity;
        for (let j = 0; j < size; j++) if (j !== i && s[j]! > top) top = s[j]!;
      }
      all = `${Math.round(performance.now() - t1)} ms`;
    }
    log(`| ${size} | ${one.toFixed(1)} ms | ${ego.toFixed(1)} ms | ${all} |`);
  }
  log();
  fs.writeFileSync(`${OUT}/metrics-${name}.md`, lines.join("\n"));
}

// ---------------------------------------------------------------- checks of the advisory review (2026-11-18)
{
  const S = reps.get("mean [det]")!;
  const top5 = Array.from({ length: n }, (_, i) => neighbours(S, i).slice(0, 5));
  const list = (i: number, floor: number) => top5[i]!.filter((j) => S[i * n + j]! >= floor);
  log("## 7. Checks of the advisory review\n");
  // (a) one-offs and the false rate
  for (const fl of [0.35, 0.4]) {
    const e = edgeSets.get(`mean [det] | kNN k=5, mean [det] ≥ ${fl}`)!;
    const labelled = e.filter(([i, j]) => !items[i]!.oneoff && !items[j]!.oneoff);
    log(`- **Floor ${fl}:** ${e.length - labelled.length} of ${e.length} edges involve a one-off; false among edges between labelled conversations: ${f2(labelled.filter(([i, j]) => rel(i, j) === "none").length / labelled.length)} (all edges: ${f2(e.filter(([i, j]) => rel(i, j) === "none").length / e.length)}).`);
  }
  // (b) what one focus conversation shows: its own top 5 above the floor; mutual pairs and ≥ 0.45 as "strong"
  log("\n| floor | listed per conversation | empty lists (labelled conversations) | related among listed | mutual: share / related | ≥ 0.45: share / related |\n|---|---|---|---|---|---|");
  for (const fl of [0.35, 0.4]) {
    let listed = 0, related = 0, mut = 0, mutRel = 0, hi = 0, hiRel = 0, empty = 0, labelled = 0;
    for (let i = 0; i < n; i++) {
      const l = list(i, fl);
      if (!items[i]!.oneoff) {
        labelled++;
        if (l.length === 0) empty++;
      }
      for (const j of l) {
        listed++;
        const ok = rel(i, j) !== "none";
        if (ok) related++;
        if (top5[j]!.includes(i)) {
          mut++;
          if (ok) mutRel++;
        }
        if (S[i * n + j]! >= 0.45) {
          hi++;
          if (ok) hiRel++;
        }
      }
    }
    log(`| ${fl} | ${(listed / n).toFixed(1)} | ${pct(empty / labelled)} | ${f2(related / listed)} | ${pct(mut / listed)} / ${f2(mutRel / mut)} | ${pct(hi / listed)} / ${f2(hiRel / hi)} |`);
  }
  // (c) second hop: does it reach new, still-sensible places?
  {
    const fl = 0.35;
    let themes1 = 0, themes12 = 0, hop2 = 0, hop2RelParent = 0, hop2NewTheme = 0, foci = 0;
    for (let i = 0; i < n; i++) {
      const l1 = list(i, fl);
      if (l1.length === 0) continue;
      foci++;
      const t1 = new Set(l1.flatMap((j) => items[j]!.themes));
      const seen = new Set([i, ...l1]);
      const t12 = new Set(t1);
      for (const j of l1)
        for (const k of list(j, fl)) {
          if (seen.has(k)) continue;
          seen.add(k);
          hop2++;
          if (rel(j, k) !== "none") hop2RelParent++;
          if (!items[k]!.themes.some((x) => items[i]!.themes.includes(x) || t1.has(x))) hop2NewTheme++;
          items[k]!.themes.forEach((x) => t12.add(x));
        }
      themes1 += t1.size;
      themes12 += t12.size;
    }
    log(`\n- **Second hop (floor 0.35):** per conversation with a list, themes reached ${f2(themes1 / foci)} at one hop and ${f2(themes12 / foci)} with two; ${(hop2 / foci).toFixed(1)} new conversations at the second hop, ${f2(hop2RelParent / hop2)} of them related to the conversation that led there, ${f2(hop2NewTheme / hop2)} in a theme the first hop didn't reach.`);
  }
  // (d) a relative floor (top 1% of pairs) grows with n
  log(`- **Relative floor:** the top 1% of pairs is ${f2(quantile(S, 0.01))} here; it always admits 1% of all pairs, i.e. a mean degree of 0.01 × (n − 1): ${(0.01 * (n - 1)).toFixed(1)} at ${n}, 30 at 3,000, 100 at 10,000.`);
  // (e) evidence: closest to the other's average vs min(closest to other, closest to own)
  {
    const e = edgeSets.get("mean [det] | kNN k=5, mean [det] ≥ 0.35")!;
    const own = (x: number) => corrected[x]!.filter((k) => !k.short || used(items[x]!).every((u) => u.short));
    const avg = items.map((_, x) => meanVec(own(x)));
    let other = 0, both = 0;
    for (const [i, j] of e) {
      const pick = (x: number, y: number, mode: "other" | "both") =>
        own(x).reduce((b, k) => {
          const s = (c: Chunk) => (mode === "other" ? dot(c.v, avg[y]!) : Math.min(dot(c.v, avg[y]!), dot(c.v, avg[x]!)));
          return s(k) > s(b) ? k : b;
        });
      if (pick(i, j, "other").generic || pick(j, i, "other").generic) other++;
      if (pick(i, j, "both").generic || pick(j, i, "both").generic) both++;
    }
    log(`- **Evidence with a generic passage:** closest to the other's average ${other} of ${e.length}; min(closest to the other's, to its own average) ${both} of ${e.length}.`);
  }
  log();
  fs.writeFileSync(`${OUT}/metrics-${name}.md`, lines.join("\n"));
}
