// Mind-map spike v2, post-hoc control (2026-11-17, after the frozen run; exploratory, not a decision rule).
// Questions (from the advisory review):
//  1. How much of hierarchical's gain is language correction alone? → k-means on `all [det]` at
//     k = 12 and at a group count matched to the hierarchical cut.
//  2. Do the proposed cut rules behave? Topics: smallest t in [0.65, 0.85] leaving ≤ 15% unsorted.
//     Themes: target count clamp(round(√n / 2), 8, 20), cut from the same tree.
//  3. Does per-language centring erase a tiny language's content, and does shrinkage fix it?
//     μ̂_lang = w·μ_lang + (1 − w)·μ_all, w = chunks / (chunks + λ), λ = 200.
// Usage: fnm exec --using=24 -- node docs/spikes/mindmap/v2/control-v2.mts <v1-vectors.json> <v2-vectors.json> [outDir]
import fs from "node:fs";
import path from "node:path";
import { cluster, groupConversations } from "../../../../src/lib/semantic/topics/topics.ts";
import { MIN_SEARCH_TOKENS } from "../../../../src/lib/semantic/search/vector-cache.ts";
import * as A from "../algorithms.mts";
import { averageLinkageNN, cutMerges, type Merge } from "./algorithms-v2.mts";
import { buildReps, detectLang, loadDev, loadTest, type Item } from "./shared.mts";

const [devFile, testFile, outDir = "docs/spikes/mindmap/v2/results"] = process.argv.slice(2);
const ROOT = process.cwd();
const test = loadTest(testFile!, ROOT);
const dev = loadDev(devFile!, ROOT);
const lines: string[] = [];
const log = (s = "") => {
  lines.push(s);
  console.log(s);
};
const f2 = (x: number) => x.toFixed(2);
const pct = (x: number) => `${Math.round(x * 100)}%`;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- representations
const meanOf = (vs: Float64Array[]) => {
  const out = new Float64Array(vs[0]!.length);
  for (const v of vs) for (let i = 0; i < v.length; i++) out[i]! += v[i]!;
  return A.normalise(out);
};

/** `all [det]` with per-language means; λ = null → plain per-language mean (as frozen), else shrunk toward the global mean. */
function repDet(items: readonly Item[], lambda: number | null): Float64Array[] {
  const tagged = items.map((c) => c.chunks.map((k) => detectLang(c.messages[k.msg]!)));
  const dims = items[0]!.chunks[0]!.v.length;
  const sums = new Map<string, { s: Float64Array; n: number }>();
  const all = new Float64Array(dims);
  let nAll = 0;
  items.forEach((c, ci) =>
    c.chunks.forEach((k, ki) => {
      const l = tagged[ci]![ki]!;
      let acc = sums.get(l);
      if (!acc) sums.set(l, (acc = { s: new Float64Array(dims), n: 0 }));
      for (let d = 0; d < dims; d++) {
        acc.s[d]! += k.v[d]!;
        all[d]! += k.v[d]!;
      }
      acc.n++;
      nAll++;
    }),
  );
  const muAll = all.map((x) => x / nAll);
  const mean = new Map(
    [...sums].map(([l, a]) => {
      const w = lambda === null ? 1 : a.n / (a.n + lambda);
      return [l, a.s.map((x, d) => w * (x / a.n) + (1 - w) * muAll[d]!)];
    }),
  );
  const centred = (v: Float64Array, l: string) => A.normalise(Float64Array.from(v, (x, d) => x - mean.get(l)![d]!));
  return items.map((c, ci) => {
    const ks = c.chunks.map((k, ki) => ({ k, l: tagged[ci]![ki]! }));
    const long = ks.filter((x) => x.k.tokenCount >= MIN_SEARCH_TOKENS);
    return meanOf((long.length > 0 ? long : ks).map((x) => centred(x.k.v, x.l)));
  });
}

// ---------------------------------------------------------------- groupers
type Grouper = (X: Float64Array[], items: readonly Item[]) => A.Grouping;
const kmeansProd: Grouper = (X, items) => {
  const map = new Map(items.map((c, i) => [c.id, X[i]!]));
  const { topics } = groupConversations(items.map((c) => ({ id: c.id, title: c.title, updatedAtSec: null })), map);
  const pos = new Map(items.map((c, i) => [c.id, i]));
  const g: A.Grouping = items.map(() => []);
  topics.forEach((t, j) => t.conversations.forEach((c) => g[pos.get(c.id)!]!.push(j)));
  return g;
};
const kmeansK = (k: number): Grouper => (X) => A.toGrouping(cluster(A.centre(X), k).assignment);
const hierT = (t: number): Grouper => (X) => {
  const C = A.centre(X);
  return A.toGrouping(cutMerges(C.length, averageLinkageNN(C), t));
};

const grid = (lo: number, hi: number) => Array.from({ length: Math.round((hi - lo) / 0.01) + 1 }, (_, i) => Math.round((lo + i * 0.01) * 100) / 100);
const unsortedShare = (g: A.Grouping) => g.filter((x) => x.length === 0).length / g.length;
const groupCount = (g: A.Grouping) => A.groupsOf(g).size;

/** Topic rule: smallest t in [0.65, 0.85] leaving ≤ 15% unsorted (0.85 if none). */
function topicT(n: number, merges: readonly Merge[]): number {
  for (const t of grid(0.65, 0.85)) if (unsortedShare(A.toGrouping(cutMerges(n, merges, t))) <= 0.15) return t;
  return 0.85;
}
const themeTarget = (n: number) => Math.max(8, Math.min(20, Math.round(Math.sqrt(n) / 2)));
/** Theme rule: from the topic cut upwards, the first t with at most `target` groups. */
function themeT(n: number, merges: readonly Merge[], from: number): number {
  const target = themeTarget(n);
  for (const t of grid(from, 1.5)) if (groupCount(A.toGrouping(cutMerges(n, merges, t))) <= target) return t;
  return 1.5;
}

// ---------------------------------------------------------------- metrics (as analyse-v2.mts)
type Level = "topic" | "theme";
function metrics(items: readonly Item[], g: A.Grouping, level: Level) {
  const n = items.length;
  const labels = items.map((c) => (level === "topic" ? c.topics : c.themes));
  const groups = [...A.groupsOf(g).values()];
  let catchAll = 0;
  for (const m of groups) {
    const tc = new Map<string, number>();
    for (const i of m) for (const t of labels[i]!) tc.set(t, (tc.get(t) ?? 0) + 1);
    const top = [...tc].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0];
    const bad = m.filter((i) => !labels[i]!.includes(top)).length;
    if (m.length >= 5 && bad / m.length > 0.5) catchAll++;
  }
  let sx = 0, sxn = 0;
  for (let i = 0; i < n; i++) {
    if (items[i]!.oneoff) continue;
    for (let j = i + 1; j < n; j++) {
      if (items[j]!.oneoff || items[i]!.lang === items[j]!.lang) continue;
      if (!labels[i]!.some((x) => labels[j]!.includes(x))) continue;
      sxn++;
      if (g[i]!.some((x) => g[j]!.includes(x))) sx++;
    }
  }
  const sizes = groups.map((m) => m.length);
  return { groups: groups.length, largest: Math.max(0, ...sizes) / n, unsorted: unsortedShare(g), f: A.bcubed(g, labels).f, catchAll, cross: sxn ? sx / sxn : 0 };
}

function stability(items: readonly Item[], X: Float64Array[], grouper: Grouper, full: A.Grouping, seed = 7): number {
  const r = rng(seed);
  const h = A.hard(full);
  let s = 0;
  for (let k = 0; k < 20; k++) {
    const idx = items.map((_, i) => i).filter(() => r() < 0.9);
    s += A.ari(A.hard(grouper(idx.map((i) => X[i]!), idx.map((i) => items[i]!))), idx.map((i) => h[i]!));
  }
  return s / 20;
}

const HEAD = "| method | setting | groups | largest | unsorted | B³ F | catch-alls | same subject, other language | stability |\n|---|---|---|---|---|---|---|---|---|";
function row(items: readonly Item[], level: Level, name: string, setting: string, X: Float64Array[], grouper: Grouper) {
  const g = grouper(X, items);
  const m = metrics(items, g, level);
  log(`| ${name} | ${setting} | ${m.groups} | ${pct(m.largest)} | ${pct(m.unsorted)} | **${f2(m.f)}** | ${m.catchAll} | ${f2(m.cross)} | ${f2(stability(items, X, grouper, g))} |`);
  return m;
}

// ---------------------------------------------------------------- run
log("# Post-hoc control (2026-11-17; after the frozen run, exploratory, not used as a decision rule)\n");
log("Synthetic data only. Rows marked *rule* use the proposed cut rules, chosen after the v2 results were seen.\n");

// Sanity: the plain per-language mean reproduces the frozen `all [det]` representation.
{
  const a = buildReps(test, "all [det]");
  const b = repDet(test, null);
  const maxDiff = Math.max(...a.map((v, i) => Math.max(...v.map((x, d) => Math.abs(x - b[i]![d]!)))));
  log(`Sanity: repDet(λ = none) vs frozen \`all [det]\`: max difference ${maxDiff.toExponential(1)}.\n`);
  if (maxDiff > 1e-9) throw new Error("repDet does not reproduce buildReps");
}

for (const [name, items] of [["Test set (453)", test], ["Dev set (94, v1)", dev]] as const) {
  const n = items.length;
  const Xb = buildReps(items, "all");
  const Xd = repDet(items, null);
  const Xs = repDet(items, 200);
  const merges = averageLinkageNN(A.centre(Xd));
  const tTopic = topicT(n, merges);
  const tTheme = themeT(n, merges, tTopic);
  const ref = A.toGrouping(cutMerges(n, merges, tTopic));
  const kMatch = groupCount(ref);
  const kAll = kMatch + ref.filter((x) => x.length === 0).length;

  log(`## ${name}: topic level\n`);
  log(`Topic rule picks t = ${tTopic} (${kMatch} groups, ${pct(unsortedShare(ref))} unsorted). k-means matched: k = ${kMatch} (groups) and k = ${kAll} (groups + unsorted singletons).\n`);
  log(HEAD);
  row(items, "topic", "k-means (production)", "`all`, k = √n ≤ 12", Xb, kmeansProd);
  row(items, "topic", "k-means", "`all [det]`, k = 12", Xd, kmeansK(12));
  row(items, "topic", "k-means", `\`all [det]\`, k = ${kMatch}`, Xd, kmeansK(kMatch));
  row(items, "topic", "k-means", `\`all [det]\`, k = ${kAll}`, Xd, kmeansK(kAll));
  row(items, "topic", "hierarchical", `\`all\` (no correction), t = ${tTopic}`, Xb, hierT(tTopic));
  row(items, "topic", "hierarchical", `\`all [det]\`, t = ${tTopic} *rule*`, Xd, hierT(tTopic));
  row(items, "topic", "hierarchical", `\`all [det]\` shrunk λ = 200, t = ${tTopic} *rule*`, Xs, hierT(tTopic));
  if (name.startsWith("Test")) row(items, "topic", "hierarchical", "`all [det]`, t = 0.75 (v2 oracle)", Xd, hierT(0.75));
  log();

  const target = themeTarget(n);
  log(`## ${name}: theme level\n`);
  log(`Theme rule: target ${target} groups → t = ${tTheme}.\n`);
  log(HEAD);
  row(items, "theme", "k-means (production)", "`all`, k = √n ≤ 12", Xb, kmeansProd);
  row(items, "theme", "k-means", `\`all [det]\`, k = ${target}`, Xd, kmeansK(target));
  row(items, "theme", "hierarchical", `\`all [det]\`, t = ${tTheme} *rule*`, Xd, hierT(tTheme));
  row(items, "theme", "hierarchical", "`all [det]`, t = 0.90 (v2 exploratory)", Xd, hierT(0.9));
  log();
}

// Scale: does the topic rule drift? Random subsets of the test set.
log("## Topic rule across archive sizes (test-set subsets, `all [det]`)\n");
log("| n | draw | rule t | groups | unsorted | B³ F rule | B³ F t = 0.75 | B³ F k-means `[det]` matched |\n|---|---|---|---|---|---|---|---|");
for (const size of [100, 200, 300]) {
  for (const draw of [1, 2, 3]) {
    const r = rng(size * 10 + draw);
    const idx = test.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [idx[i], idx[j]] = [idx[j]!, idx[i]!];
    }
    const sub = idx.slice(0, size).sort((a, b) => a - b).map((i) => test[i]!);
    const X = repDet(sub, null);
    const merges = averageLinkageNN(A.centre(X));
    const t = topicT(sub.length, merges);
    const g = A.toGrouping(cutMerges(sub.length, merges, t));
    const k = groupCount(g);
    const fixed = A.toGrouping(cutMerges(sub.length, merges, 0.75));
    log(`| ${size} | ${draw} | ${t} | ${k} | ${pct(unsortedShare(g))} | ${f2(metrics(sub, g, "topic").f)} | ${f2(metrics(sub, fixed, "topic").f)} | ${f2(metrics(sub, kmeansK(k)(X, sub), "topic").f)} |`);
  }
}
log();

// Small language: keep all en/no conversations and only m Russian ones (non-one-off).
log("## A tiny language: all English and Norwegian, only m Russian conversations (hierarchical, t = 0.75)\n");
log("*Joined* = share of the kept Russian conversations (with a same-topic partner in the set) whose group contains a same-topic conversation. Mean of 5 draws.\n");
log("| m Russian | representation | joined | Russian unsorted | B³ F (all) |\n|---|---|---|---|---|");
const base = test.filter((c) => c.lang !== "ru");
const ruPool = test.filter((c) => c.lang === "ru" && !c.oneoff);
for (const m of [3, 8, 20]) {
  const acc = new Map<string, { j: number; u: number; f: number }>();
  for (let draw = 0; draw < 5; draw++) {
    const r = rng(1000 + m * 10 + draw);
    const pool = [...ruPool];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    const items = [...base, ...pool.slice(0, m)].sort((a, b) => (a.id < b.id ? -1 : 1));
    const ru = items.map((c, i) => (c.lang === "ru" ? i : -1)).filter((i) => i >= 0);
    for (const [rep, X] of [
      ["`all` (no correction)", buildReps(items, "all")],
      ["`all [det]` plain", repDet(items, null)],
      ["`all [det]` shrunk λ = 200", repDet(items, 200)],
    ] as const) {
      const g = hierT(0.75)(X as Float64Array[], items);
      const eligible = ru.filter((i) => items.some((c, j) => j !== i && c.topics.some((t) => items[i]!.topics.includes(t))));
      const joined = eligible.filter((i) => [...A.groupsOf(g).values()].some((mem) => mem.includes(i) && mem.some((j) => j !== i && items[j]!.topics.some((t) => items[i]!.topics.includes(t))))).length;
      const a = acc.get(rep) ?? { j: 0, u: 0, f: 0 };
      a.j += eligible.length ? joined / eligible.length : 0;
      a.u += ru.filter((i) => g[i]!.length === 0).length / ru.length;
      a.f += metrics(items, g, "topic").f;
      acc.set(rep, a);
    }
  }
  for (const [rep, a] of acc) log(`| ${m} | ${rep} | ${f2(a.j / 5)} | ${pct(a.u / 5)} | ${f2(a.f / 5)} |`);
}
log();

fs.writeFileSync(path.join(outDir, "control.md"), lines.join("\n"));
