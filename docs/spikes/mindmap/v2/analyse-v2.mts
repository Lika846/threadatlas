// Mind-map spike v2, step 2: frozen comparison on the held-out test set (SPEC.md).
// Usage: fnm exec --using=24 -- node docs/spikes/mindmap/v2/analyse-v2.mts <v1-vectors.json> <v2-vectors.json> [outDir]
import fs from "node:fs";
import path from "node:path";
import { groupConversations, topicWords } from "../../../../src/lib/semantic/topics/topics.ts";
import * as A from "../algorithms.mts";
import { averageLinkageNN, cutMerges, knnSparse, louvainSparse, type Merge } from "./algorithms-v2.mts";
import { buildReps, detectLang, loadDev, loadTest, type Item, type RepName } from "./shared.mts";

const [devFile, testFile, outDir = "docs/spikes/mindmap/v2/results"] = process.argv.slice(2);
const ROOT = process.cwd();
const test = loadTest(testFile!, ROOT);
const dev = loadDev(devFile!, ROOT);
fs.mkdirSync(outDir, { recursive: true });
const lines: string[] = [];
const log = (s = "") => {
  lines.push(s);
  console.log(s);
};
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "–");
const pct = (x: number) => `${Math.round(x * 100)}%`;

// ---------------------------------------------------------------- frozen grids (SPEC.md)
const T_GRID = [0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1.0, 1.05];
const K_GRID = [6, 10, 15];
const G_GRID = [1, 1.5, 2, 3, 4];
const REPS: RepName[] = ["all [det]", "all+title [det]"];
const SUBSAMPLES = 20;

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

// ---------------------------------------------------------------- groupers (on a subset of items, given full-set vectors)
type Grouper = (X: Float64Array[], items: readonly Item[]) => A.Grouping;
const kmeansProd: Grouper = (X, items) => {
  const map = new Map(items.map((c, i) => [c.id, X[i]!]));
  const { topics } = groupConversations(items.map((c) => ({ id: c.id, title: c.title, updatedAtSec: null })), map);
  const pos = new Map(items.map((c, i) => [c.id, i]));
  const g: A.Grouping = items.map(() => []);
  topics.forEach((t, j) => t.conversations.forEach((c) => g[pos.get(c.id)!]!.push(j)));
  return g;
};

/** Every hierarchical cut from one dendrogram, and every Louvain setting from one kNN graph per k. */
function allSettings(X: Float64Array[]): Map<string, A.Grouping> {
  const out = new Map<string, A.Grouping>();
  const C = A.centre(X);
  const merges = averageLinkageNN(C);
  for (const t of T_GRID) out.set(`hier t=${t}`, A.toGrouping(cutMerges(C.length, merges, t)));
  for (const k of K_GRID) {
    const g = knnSparse(C, k);
    for (const gm of G_GRID) out.set(`louvain k=${k} γ=${gm}`, A.toGrouping(louvainSparse(g, gm)));
  }
  return out;
}

// ---------------------------------------------------------------- metrics
type Level = "topic" | "theme";
function metrics(items: readonly Item[], g: A.Grouping, level: Level) {
  const n = items.length;
  const labels = items.map((c) => (level === "topic" ? c.topics : c.themes));
  const groups = [...A.groupsOf(g).values()];
  const sizes = groups.map((m) => m.length).sort((a, b) => b - a);
  const unsorted = g.filter((x) => x.length === 0).length;
  const b3 = A.bcubed(g, labels);
  let intruders = 0;
  let catchAll = 0;
  let residue = 0;
  for (const m of groups) {
    const tc = new Map<string, number>();
    for (const i of m) for (const t of labels[i]!) tc.set(t, (tc.get(t) ?? 0) + 1);
    const top = [...tc].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0];
    const bad = m.filter((i) => !labels[i]!.includes(top)).length;
    intruders += bad;
    if (m.length >= 5 && bad / m.length > 0.5) catchAll++;
    const lc = new Map<string, number>();
    for (const i of m) lc.set(items[i]!.lang, (lc.get(items[i]!.lang) ?? 0) + 1);
    if (m.length >= 3 && Math.max(...lc.values()) / m.length >= 0.9 && bad / m.length > 0.5) residue++;
  }
  const one = items.map((c, i) => (c.oneoff ? i : -1)).filter((i) => i >= 0);
  // Cross-language: pairs of non-one-off conversations.
  let sx = 0, sxn = 0, ds = 0, dsn = 0;
  for (let i = 0; i < n; i++) {
    if (items[i]!.oneoff) continue;
    for (let j = i + 1; j < n; j++) {
      if (items[j]!.oneoff) continue;
      const same = labels[i]!.some((x) => labels[j]!.includes(x));
      const cross = items[i]!.lang !== items[j]!.lang;
      const tog = g[i]!.some((x) => g[j]!.includes(x)) ? 1 : 0;
      if (same && cross) {
        sx += tog;
        sxn++;
      }
      if (!same && !cross) {
        ds += tog;
        dsn++;
      }
    }
  }
  return {
    groups: groups.length,
    largestShare: (sizes[0] ?? 0) / n,
    unsortedShare: unsorted / n,
    b3,
    intruderRate: n - unsorted ? intruders / (n - unsorted) : 0,
    catchAll,
    residue,
    oneoffUnsorted: one.length ? one.filter((i) => g[i]!.length === 0).length / one.length : 0,
    sameSubjCrossLang: sxn ? sx / sxn : 0,
    diffSubjSameLang: dsn ? ds / dsn : 0,
    nmiLang: A.nmi(A.hard(g), items.map((c) => c.lang)),
  };
}
type M = ReturnType<typeof metrics> & { stability: number };

// ---------------------------------------------------------------- evaluate one item set
type Result = Map<string, Map<string, M>>; // rep → setting → metrics
function evaluateSet(items: readonly Item[], level: Level, seed = 7): { res: Result; baseline: M; groupings: Map<string, Map<string, A.Grouping>>; baseG: A.Grouping } {
  const res: Result = new Map();
  const groupings = new Map<string, Map<string, A.Grouping>>();
  const r = rng(seed);
  const subs = Array.from({ length: SUBSAMPLES }, () => items.map((_, i) => i).filter(() => r() < 0.9));
  const meanAri = (full: A.Grouping, sub: (idx: number[]) => A.Grouping) => {
    const h = A.hard(full);
    return subs.reduce((s, idx) => s + A.ari(A.hard(sub(idx)), idx.map((i) => h[i]!)), 0) / subs.length;
  };
  // Baseline: production k-means on production vectors.
  const Xb = buildReps(items, "all");
  const baseG = kmeansProd(Xb, items);
  const baseline = { ...metrics(items, baseG, level), stability: meanAri(baseG, (idx) => kmeansProd(idx.map((i) => Xb[i]!), idx.map((i) => items[i]!))) };
  for (const rep of REPS) {
    const X = buildReps(items, rep);
    const full = allSettings(X);
    groupings.set(rep, full);
    const subSettings = subs.map((idx) => ({ idx, s: allSettings(idx.map((i) => X[i]!)) }));
    const m = new Map<string, M>();
    for (const [key, g] of full) {
      const h = A.hard(g);
      const stab = subSettings.reduce((s, { idx, s: ss }) => s + A.ari(A.hard(ss.get(key)!), idx.map((i) => h[i]!)), 0) / subs.length;
      m.set(key, { ...metrics(items, g, level), stability: stab });
    }
    res.set(rep, m);
  }
  return { res, baseline, groupings, baseG };
}

/** (c) label-free rule (SPEC.md): unsorted ≤ 25%, largest ≤ 15%, max stability; ties → more groups. */
function ruleC(m: Map<string, M>, prefix: string): string | null {
  const c = [...m].filter(([k, v]) => k.startsWith(prefix) && v.unsortedShare <= 0.25 && v.largestShare <= 0.15);
  c.sort((a, b) => b[1].stability - a[1].stability || b[1].groups - a[1].groups);
  return c[0]?.[0] ?? null;
}
const best = (m: Map<string, M>, prefix: string) => [...m].filter(([k]) => k.startsWith(prefix)).sort((a, b) => b[1].b3.f - a[1].b3.f)[0]![0];

const HEAD =
  "| method | setting | groups | largest | unsorted | B³ P | B³ R | **B³ F** | intruders | catch-alls | 1-lang residue | one-offs unsorted | same subject, other lang | diff subject, same lang | stability |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";
const row = (name: string, setting: string, v: M) =>
  `| ${name} | ${setting} | ${v.groups} | ${pct(v.largestShare)} | ${pct(v.unsortedShare)} | ${f2(v.b3.p)} | ${f2(v.b3.r)} | **${f2(v.b3.f)}** | ${f2(v.intruderRate)} | ${v.catchAll} | ${v.residue} | ${pct(v.oneoffUnsorted)} | ${f2(v.sameSubjCrossLang)} | ${f2(v.diffSubjSameLang)} | ${f2(v.stability)} |`;

// ---------------------------------------------------------------- 0. detector accuracy on messy test messages
{
  let ok = 0, n = 0;
  const conf = new Map<string, number>();
  for (const c of test)
    c.messages.forEach((m, i) => {
      const want = c.messageLangs![i]!;
      const got = detectLang(m);
      n++;
      if (got === want) ok++;
      else conf.set(`${want}→${got}`, (conf.get(`${want}→${got}`) ?? 0) + 1);
    });
  log(`# Mind-map spike v2 results\n\nTest set: ${test.length} conversations (${["en", "no", "ru"].map((l) => `${l} ${test.filter((c) => c.lang === l).length}`).join(", ")}); dev set: ${dev.length}.\n`);
  log(`Frozen detector, per message, on the test set: ${ok}/${n} correct (${pct(ok / n)}). Errors: ${[...conf].map(([k, v]) => `${k} ${v}`).join(", ") || "none"}.\n`);
}

// ---------------------------------------------------------------- 1. main: test set, topic level
const T = evaluateSet(test, "topic");
log("## 1. Test set, topic level (fine groups vs topic labels)\n");
log(HEAD);
log(row("k-means (production)", "k=12, no correction", T.baseline));
const chosen: Record<string, { a: string; b: string; c: string | null }> = {};
for (const rep of REPS) {
  const m = T.res.get(rep)!;
  for (const [meth, prefix, fixed] of [["hierarchical", "hier", "hier t=0.85"], ["Louvain", "louvain", "louvain k=10 γ=1.5"]] as const) {
    const a = fixed, b = best(m, prefix), c = ruleC(m, prefix);
    chosen[`${meth} @ ${rep}`] = { a, b, c };
    log(row(`${meth} @ ${rep}`, `(a) fixed: ${a.replace(/^\S+ /, "")}`, m.get(a)!));
    log(row(`${meth} @ ${rep}`, `(b) oracle: ${b.replace(/^\S+ /, "")}`, m.get(b)!));
    log(c ? row(`${meth} @ ${rep}`, `(c) label-free: ${c.replace(/^\S+ /, "")}`, m.get(c)!) : `| ${meth} @ ${rep} | (c) label-free: no setting met the constraints | | | | | | | | | | | | | |`);
  }
}
log("\nFull grids:\n");
log(HEAD);
for (const rep of REPS) for (const [k, v] of T.res.get(rep)!) log(row(rep, k, v));

// ---------------------------------------------------------------- 2. decision criteria (SPEC.md)
{
  log("\n## 2. Decision criteria (written before results)\n");
  for (const rep of REPS) {
    const key = chosen[`hierarchical @ ${rep}`]!;
    const m = T.res.get(rep)!;
    const c = key.c ? m.get(key.c)! : null;
    const b = m.get(key.b)!;
    const bl = T.baseline;
    const checks = c
      ? [
          [`1. B³ F ≥ baseline + 0.15 (${f2(c.b3.f)} vs ${f2(bl.b3.f)})`, c.b3.f >= bl.b3.f + 0.15],
          [`2. same-subject cross-language ≥ 0.25 (${f2(c.sameSubjCrossLang)})`, c.sameSubjCrossLang >= 0.25],
          [`3. stability ≥ baseline + 0.15 (${f2(c.stability)} vs ${f2(bl.stability)})`, c.stability >= bl.stability + 0.15],
          [`4. largest ≤ 15% (${pct(c.largestShare)}) and ≤ 1 catch-all (${c.catchAll})`, c.largestShare <= 0.15 && c.catchAll <= 1],
          [`5. (c) within 0.05 of oracle (${f2(c.b3.f)} vs ${f2(b.b3.f)})`, b.b3.f - c.b3.f <= 0.05],
        ]
      : [["(c) found no setting", false]];
    log(`**hierarchical @ ${rep}, (c) = ${key.c ?? "none"}:**`);
    for (const [s, okk] of checks) log(`- ${okk ? "PASS" : "FAIL"} — ${s}`);
    log("");
  }
}

// ---------------------------------------------------------------- 3. theme level (coarse)
const TT = evaluateSet(test, "theme");
log("## 3. Test set, theme level (coarse groups vs theme labels)\n");
log(HEAD);
log(row("k-means (production)", "k=12, no correction", TT.baseline));
for (const rep of REPS) {
  const m = TT.res.get(rep)!;
  for (const key of ["hier t=0.95", best(m, "hier"), "hier t=1", "hier t=1.05", best(m, "louvain")]) log(row(rep, key + (key === best(m, key.split(" ")[0]!) ? " (oracle)" : ""), m.get(key)!));
}

// ---------------------------------------------------------------- 4. combined dev + test (theme level, secondary)
const all = [...dev, ...test];
const CB = evaluateSet(all, "theme");
log("\n## 4. Dev + test combined, theme level (secondary)\n");
log(HEAD);
log(row("k-means (production)", "k=12, no correction", CB.baseline));
for (const rep of REPS) {
  const m = CB.res.get(rep)!;
  const c = ruleC(m, "hier");
  for (const key of ["hier t=0.85", "hier t=0.95", best(m, "hier"), ...(c ? [c] : []), "louvain k=10 γ=1.5"]) log(row(rep, key, m.get(key)!));
}

// ---------------------------------------------------------------- 5. chunk-level detection (secondary)
{
  const X = buildReps(test, "all [detc]");
  const C = A.centre(X);
  const g = A.toGrouping(cutMerges(C.length, averageLinkageNN(C), 0.85));
  const v = metrics(test, g, "topic");
  log("\n## 5. Per-chunk language detection (secondary), hierarchical t=0.85\n");
  log(HEAD);
  log(row("hierarchical @ all [detc]", "t=0.85", { ...v, stability: NaN }));
}

// ---------------------------------------------------------------- 6. scale: does the chosen t drift with n?
{
  log("\n## 6. Scale: random subsets of the test set, hierarchical @ all+title [det]\n");
  log("| n | draw | oracle t | B³ F oracle | (c) t | B³ F (c) | B³ F t=0.85 | B³ F k-means | groups (c) | unsorted (c) |\n|---|---|---|---|---|---|---|---|---|---|");
  for (const n of [100, 200, 300]) {
    for (let d = 0; d < 3; d++) {
      const r = rng(100 + n + d);
      const idx = test.map((_, i) => i).sort((a, b) => Math.sin(a * 9301 + d * 49297 + n) - Math.sin(b * 9301 + d * 49297 + n));
      void r;
      const sub = idx.slice(0, n).sort((a, b) => a - b).map((i) => test[i]!);
      const E = evaluateSet(sub, "topic", 11 + d);
      const m = E.res.get("all+title [det]")!;
      const b = best(m, "hier");
      const c = ruleC(m, "hier");
      log(`| ${n} | ${d + 1} | ${b.slice(7)} | ${f2(m.get(b)!.b3.f)} | ${c ? c.slice(7) : "none"} | ${c ? f2(m.get(c)!.b3.f) : "–"} | ${f2(m.get("hier t=0.85")!.b3.f)} | ${f2(E.baseline.b3.f)} | ${c ? m.get(c)!.groups : "–"} | ${c ? pct(m.get(c)!.unsortedShare) : "–"} |`);
    }
  }
  const m = T.res.get("all+title [det]")!;
  const b = best(m, "hier");
  const c = ruleC(m, "hier");
  log(`| ${test.length} | all | ${b.slice(7)} | ${f2(m.get(b)!.b3.f)} | ${c ? c.slice(7) : "none"} | ${c ? f2(m.get(c)!.b3.f) : "–"} | ${f2(m.get("hier t=0.85")!.b3.f)} | ${f2(T.baseline.b3.f)} | ${c ? m.get(c)!.groups : "–"} | ${c ? pct(m.get(c)!.unsortedShare) : "–"} |`);
}

// ---------------------------------------------------------------- 7. timing (resampled + noise, timing only)
{
  log("\n## 7. Timing on resampled vectors with noise (timing only, not quality)\n");
  log("| n | k-means (production) | average linkage (NN-chain) + cut | kNN graph (k=10) + Louvain |\n|---|---|---|---|");
  const X = buildReps(test, "all+title [det]");
  const r = rng(5);
  const gauss = () => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
  for (const n of [500, 2000, 5000]) {
    const V = Array.from({ length: n }, (_, i) => A.normalise(Float64Array.from(X[i % X.length]!, (x) => x + 0.02 * gauss())));
    const fake = V.map((_, i) => ({ id: `x${String(i).padStart(5, "0")}`, title: null, updatedAtSec: null }));
    let t0 = performance.now();
    groupConversations(fake, new Map(fake.map((c, i) => [c.id, V[i]!])));
    const tk = performance.now() - t0;
    t0 = performance.now();
    const C = A.centre(V);
    cutMerges(n, averageLinkageNN(C), 0.85);
    const th = performance.now() - t0;
    t0 = performance.now();
    louvainSparse(knnSparse(C, 10), 1.5);
    const tl = performance.now() - t0;
    log(`| ${n} | ${Math.round(tk)} ms | ${Math.round(th)} ms | ${Math.round(tl)} ms |`);
  }
  log(`\nAverage linkage holds one Float64Array of n² distances: ${Math.round((5000 * 5000 * 8) / 2 ** 20)} MiB at n = 5,000 (Float32 would halve it).`);
}

fs.writeFileSync(path.join(outDir, "metrics.md"), lines.join("\n") + "\n");

// ---------------------------------------------------------------- 8. listings: blind (titles only) and labelled
const typical = (X: Float64Array[], m: number[], items: readonly Item[]) => {
  const c = A.normalise(m.reduce((acc, i) => acc.map((x, d) => x + X[i]![d]!), new Float64Array(X[0]!.length)));
  return m.slice().sort((a, b) => A.dot(X[b]!, c) - A.dot(X[a]!, c)).slice(0, 3).map((i) => items[i]!.title ?? "Untitled");
};
function listing(title: string, items: readonly Item[], X: Float64Array[], g: A.Grouping, blind: boolean) {
  const groups = [...A.groupsOf(g).values()].sort((a, b) => b.length - a.length);
  const words = topicWords(groups.map((m) => m.map((i) => items[i]!.title)));
  const out = [`## ${title}\n`];
  groups.forEach((m, j) => {
    const tc = new Map<string, number>();
    for (const i of m) for (const t of items[i]!.topics) tc.set(t, (tc.get(t) ?? 0) + 1);
    const top = [...tc].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0];
    const head = `**G${j + 1}** (${m.length}) — typical: ${typical(X, m, items).map((t) => `"${t}"`).join(", ")} — title words: *${words[j]!.join(" · ") || "(none)"}*`;
    out.push(blind ? head : `${head} — main topic: \`${top}\``);
    out.push(
      m
        .map((i) => {
          const c = items[i]!;
          const t = `${c.title ?? "(no title)"} [${c.lang}]`;
          return blind ? t : `${c.topics.includes(top) ? "" : "✗ "}${t} {${c.topics.join(", ")}}`;
        })
        .join(" · ") + "\n",
    );
  });
  const un = g.map((x, i) => (x.length === 0 ? i : -1)).filter((i) => i >= 0);
  if (un.length) out.push(`**Unsorted** (${un.length}): ${un.map((i) => `${items[i]!.title ?? "(no title)"} [${items[i]!.lang}]${blind ? "" : ` {${items[i]!.topics.join(", ")}}`}`).join(" · ")}\n`);
  return out.join("\n");
}
{
  const rep = "all+title [det]";
  const X = buildReps(test, rep);
  const Xb = buildReps(test, "all");
  const ch = chosen[`hierarchical @ ${rep}`]!;
  const lc = chosen[`Louvain @ ${rep}`]!;
  const sets: [string, Float64Array[], A.Grouping][] = [
    ["A", Xb, T.baseG],
    ["B", X, T.groupings.get(rep)!.get(ch.c ?? ch.a)!],
    ["C", X, T.groupings.get(rep)!.get(lc.c ?? lc.a)!],
  ];
  const names: Record<string, string> = { A: "k-means (production)", B: `hierarchical ${ch.c ?? ch.a} @ ${rep}`, C: `Louvain ${lc.c ?? lc.a} @ ${rep}` };
  fs.writeFileSync(path.join(outDir, "blind-groups.md"), sets.map(([k, x, g]) => listing(`Listing ${k}`, test, x, g, true)).join("\n"));
  fs.writeFileSync(path.join(outDir, "groups.md"), sets.map(([k, x, g]) => listing(`Listing ${k}: ${names[k]}`, test, x, g, false)).join("\n"));
  // Two levels: themes at the theme-level oracle-free fixed cut 0.95 and at 1.0, topics at the chosen fine cut.
  const C = A.centre(X);
  const merges: Merge[] = averageLinkageNN(C);
  const fineT = Number((ch.c ?? ch.a).split("=")[1]);
  const out: string[] = [];
  for (const coarseT of [0.95, 1.0]) {
    const coarse = cutMerges(C.length, merges, coarseT);
    const fine = A.toGrouping(cutMerges(C.length, merges, fineT));
    out.push(`# Two levels: themes (t=${coarseT}) → topics (t=${fineT})\n`);
    const themes = new Map<number, number[]>();
    coarse.forEach((x, i) => themes.set(x, [...(themes.get(x) ?? []), i]));
    for (const m of [...themes.values()].sort((a, b) => b.length - a.length)) {
      if (m.length < 2) continue;
      const tc = new Map<string, number>();
      for (const i of m) for (const t of test[i]!.themes) tc.set(t, (tc.get(t) ?? 0) + 1);
      const top = [...tc].sort((a, b) => b[1] - a[1])[0]!;
      out.push(`## Theme (${m.length}) — typical: ${typical(X, m, test).map((t) => `"${t}"`).join(", ")} — main theme label: \`${top[0]}\` (${top[1]}/${m.length})`);
      const sub = new Map<string, number[]>();
      for (const i of m) sub.set(fine[i]!.length ? `g${fine[i]![0]}` : `u${i}`, [...(sub.get(fine[i]!.length ? `g${fine[i]![0]}` : `u${i}`) ?? []), i]);
      for (const [key, s] of [...sub].sort((a, b) => b[1].length - a[1].length))
        out.push(`- ${key.startsWith("u") ? "(alone) " : `(${s.length}) `}${s.map((i) => `${test[i]!.title ?? "(no title)"} [${test[i]!.lang}; ${test[i]!.topics.join(", ")}]`).join(" · ")}`);
      out.push("");
    }
  }
  fs.writeFileSync(path.join(outDir, "hierarchy.md"), out.join("\n"));
}
console.log(`\nWritten to ${outDir}`);
