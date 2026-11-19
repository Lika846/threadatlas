// Mind-map spike v2, step 3 (POST-HOC, after seeing the frozen results; not part of the decision):
// (1) placeholder titles ("New chat", empty) ignored in all+title; (2) a two-level listing with the
// better representation (all [det]); (3) theme-level numbers for candidate coarse cuts.
// Usage: fnm exec --using=24 -- node docs/spikes/mindmap/v2/explore-v2.mts <v2-vectors.json> [outDir]
import fs from "node:fs";
import path from "node:path";
import * as A from "../algorithms.mts";
import { averageLinkageNN, cutMerges, knnSparse, louvainSparse } from "./algorithms-v2.mts";
import { buildReps, loadTest } from "./shared.mts";

const [file, outDir = "docs/spikes/mindmap/v2/results"] = process.argv.slice(2);
const test = loadTest(file!, process.cwd());
const out: string[] = ["# Post-hoc exploration (after the frozen run; not used for the decision)\n"];
const score = (X: Float64Array[], t: number, level: "topics" | "themes") => {
  const C = A.centre(X);
  const g = A.toGrouping(cutMerges(C.length, averageLinkageNN(C), t));
  const groups = [...A.groupsOf(g).values()];
  return { f: A.bcubed(g, test.map((c) => c[level])).f, groups: groups.length, largest: Math.max(...groups.map((m) => m.length)) / test.length, unsorted: g.filter((x) => !x.length).length / test.length };
};
// (1) placeholder titles
const placeholder = (t: string | null) => !t || /^new chat$/i.test(t.trim());
const cleaned = test.map((c) => (placeholder(c.title) ? { ...c, titleV: null } : c));
out.push("## 1. Ignoring placeholder titles in all+title [det] (topic-level B³ F)\n\n| t | all [det] | all+title [det] | all+title [det], placeholders ignored |\n|---|---|---|---|");
const Xa = buildReps(test, "all [det]");
const Xt = buildReps(test, "all+title [det]");
const Xc = buildReps(cleaned, "all+title [det]");
for (const t of [0.7, 0.75, 0.8, 0.85]) out.push(`| ${t} | ${score(Xa, t, "topics").f.toFixed(2)} | ${score(Xt, t, "topics").f.toFixed(2)} | ${score(Xc, t, "topics").f.toFixed(2)} |`);
// (3) theme level: hierarchical cuts and Louvain, all [det]
out.push("\n## 2. Theme level, all [det]: candidate coarse settings\n\n| setting | groups | largest | unsorted | theme B³ F |\n|---|---|---|---|---|");
for (const t of [0.8, 0.85, 0.9, 0.95]) {
  const s = score(Xa, t, "themes");
  out.push(`| hierarchical t=${t} | ${s.groups} | ${Math.round(s.largest * 100)}% | ${Math.round(s.unsorted * 100)}% | ${s.f.toFixed(2)} |`);
}
const C = A.centre(Xa);
for (const [k, gm] of [[10, 2], [15, 2], [15, 3]] as const) {
  const g = A.toGrouping(louvainSparse(knnSparse(C, k), gm));
  const groups = [...A.groupsOf(g).values()];
  out.push(`| Louvain k=${k} γ=${gm} | ${groups.length} | ${Math.round((Math.max(...groups.map((m) => m.length)) / test.length) * 100)}% | ${Math.round((g.filter((x) => !x.length).length / test.length) * 100)}% | ${A.bcubed(g, test.map((c) => c.themes)).f.toFixed(2)} |`);
}
// (2) two-level listing, all [det]: themes t=0.9, topics t=0.75
const merges = averageLinkageNN(C);
const coarse = cutMerges(C.length, merges, 0.9);
const fine = A.toGrouping(cutMerges(C.length, merges, 0.75));
out.push("\n## 3. Two levels with all [det]: themes (t=0.9) → topics (t=0.75)\n");
const themes = new Map<number, number[]>();
coarse.forEach((x, i) => themes.set(x, [...(themes.get(x) ?? []), i]));
const singles: number[] = [];
for (const m of [...themes.values()].sort((a, b) => b.length - a.length)) {
  if (m.length < 2) {
    singles.push(m[0]!);
    continue;
  }
  const tc = new Map<string, number>();
  for (const i of m) for (const t of test[i]!.themes) tc.set(t, (tc.get(t) ?? 0) + 1);
  const top = [...tc].sort((a, b) => b[1] - a[1])[0]!;
  const langs = new Set(m.map((i) => test[i]!.lang));
  out.push(`### Theme (${m.length}; ${[...langs].join("/")}) — main theme label \`${top[0]}\` ${top[1]}/${m.length}`);
  const sub = new Map<string, number[]>();
  for (const i of m) {
    const key = fine[i]!.length ? `g${fine[i]![0]}` : `u${i}`;
    sub.set(key, [...(sub.get(key) ?? []), i]);
  }
  for (const [key, s] of [...sub].sort((a, b) => b[1].length - a[1].length))
    out.push(`- ${key.startsWith("u") ? "(alone)" : `(${s.length})`} ${s.map((i) => `${test[i]!.title ?? "(no title)"} [${test[i]!.lang}; ${test[i]!.topics.join(", ")}]`).join(" · ")}`);
  out.push("");
}
out.push(`### Not in any theme (${singles.length}): ${singles.map((i) => `${test[i]!.title ?? "(no title)"} [${test[i]!.topics.join(", ")}]`).join(" · ")}\n`);
fs.writeFileSync(path.join(outDir, "explore.md"), out.join("\n"));
console.log(out.slice(0, 22).join("\n"));

// (4) Does the label-free rule just pick the finest cut allowed? Extend the grid downwards (exploratory).
{
  let seed = 7 >>> 0;
  const r = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const subs = Array.from({ length: 20 }, () => test.map((_, i) => i).filter(() => r() < 0.9));
  const subMerges = subs.map((idx) => {
    const Cs = A.centre(idx.map((i) => Xa[i]!));
    return { idx, m: averageLinkageNN(Cs), n: Cs.length };
  });
  const lines4 = ["\n## 4. Extended grid for the label-free rule, all [det] (exploratory)\n", "| t | groups | largest | unsorted | topic B³ F | stability |", "|---|---|---|---|---|---|"];
  for (const t of [0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85]) {
    const g = A.toGrouping(cutMerges(C.length, merges, t));
    const h = A.hard(g);
    const stab = subMerges.reduce((s, { idx, m, n }) => s + A.ari(A.hard(A.toGrouping(cutMerges(n, m, t))), idx.map((i) => h[i]!)), 0) / subs.length;
    const groups = [...A.groupsOf(g).values()];
    lines4.push(`| ${t} | ${groups.length} | ${Math.round((Math.max(...groups.map((x) => x.length)) / test.length) * 100)}% | ${Math.round((g.filter((x) => !x.length).length / test.length) * 100)}% | ${A.bcubed(g, test.map((c) => c.topics)).f.toFixed(2)} | ${stab.toFixed(3)} |`);
  }
  fs.appendFileSync(path.join(outDir, "explore.md"), lines4.join("\n") + "\n");
  console.log(lines4.join("\n"));
}

// (5) Titles-only listing of the recommended setting (all [det], t = 0.75), for a blind read.
{
  const g = A.toGrouping(cutMerges(C.length, merges, 0.75));
  const groups = [...A.groupsOf(g).values()].sort((a, b) => b.length - a.length);
  const blind = ["# Blind listing: hierarchical t=0.75 @ all [det] (titles only)\n"];
  const labelled = ["# Labelled listing: hierarchical t=0.75 @ all [det]\n"];
  groups.forEach((m, j) => {
    blind.push(`**G${j + 1}** (${m.length}): ${m.map((i) => `${test[i]!.title ?? "(no title)"} [${test[i]!.lang}]`).join(" · ")}`);
    labelled.push(`**G${j + 1}** (${m.length}): ${m.map((i) => `${test[i]!.title ?? "(no title)"} [${test[i]!.lang}; ${test[i]!.topics.join(", ")}]`).join(" · ")}`);
  });
  const un = g.map((x, i) => (x.length ? -1 : i)).filter((i) => i >= 0);
  blind.push(`\n**Unsorted** (${un.length}): ${un.map((i) => test[i]!.title ?? "(no title)").join(" · ")}`);
  labelled.push(`\n**Unsorted** (${un.length}): ${un.map((i) => `${test[i]!.title ?? "(no title)"} [${test[i]!.topics.join(", ")}]`).join(" · ")}`);
  fs.writeFileSync(path.join(outDir, "blind-groups-recommended.md"), blind.join("\n") + "\n");
  fs.writeFileSync(path.join(outDir, "groups-recommended.md"), labelled.join("\n") + "\n");
}
