// Mind-map spike, step 2: compare groupings on the synthetic vectors from embed.mts.
// Usage: fnm exec --using=24 -- node docs/spikes/mindmap/analyse.mts <vectors.json> [outDir]
// Uses the PRODUCTION k-means (`groupConversations` in topics.ts) as the baseline.
import fs from "node:fs";
import path from "node:path";
import { dequantizeInt8, quantizeInt8 } from "../../../src/lib/semantic/quantize.ts";
import { cluster, groupConversations, topicWords } from "../../../src/lib/semantic/topics/topics.ts";
import { MIN_SEARCH_TOKENS } from "../../../src/lib/semantic/search/vector-cache.ts";
import { LABELS } from "./labels.mjs";
import * as A from "./algorithms.mts";
import { CHAT_CORPUS } from "../../../tests/helpers/chat-corpus.ts";

type Chunk = { msg: number; role: "user" | "assistant"; tokenCount: number; v: number[]; q: number[] | null };
type Conv = { id: string; set: string; lang: string; title: string; chunks: Chunk[]; titleV: number[] };

const [file, outDir = "docs/spikes/mindmap/results"] = process.argv.slice(2);
const convs: Conv[] = (JSON.parse(fs.readFileSync(file!, "utf8")) as Conv[]).sort((a, b) => (a.id < b.id ? -1 : 1));
const labels = convs.map((c) => (LABELS as Record<string, string[]>)[c.id]!);
if (labels.some((l) => !l)) throw new Error("missing label");
const langs = convs.map((c) => c.lang);
const primary = labels.map((l) => l[0]!);
const N = convs.length;

// ---------------------------------------------------------------- representations
const int8 = (v: number[]) => Float64Array.from(dequantizeInt8(quantizeInt8(Float32Array.from(v)), v.length));
const meanOf = (vs: Float64Array[]) => {
  const out = new Float64Array(vs[0]!.length);
  for (const v of vs) for (let i = 0; i < v.length; i++) out[i]! += v[i]!;
  return A.normalise(out);
};
const longFirst = (cs: Chunk[]) => {
  const long = cs.filter((c) => c.tokenCount >= MIN_SEARCH_TOKENS);
  return long.length > 0 ? long : cs;
};
/** Production: mean of long chunks (else all), int8 round trip, as conversationVectors() in topics.ts. */
const repAll = (c: Conv) => meanOf(longFirst(c.chunks).map((k) => int8(k.v)));
const repUser = (c: Conv) => {
  const u = c.chunks.filter((k) => k.role === "user");
  return u.length > 0 ? meanOf(longFirst(u).map((k) => int8(k.v))) : repAll(c);
};
// ---- label-free language detection per MESSAGE (no dependency), then per-language centring of CHUNK vectors
const evalSet = (f: string) => JSON.parse(fs.readFileSync(path.join("docs/spikes/m5.0/eval", f), "utf8")).conversations as { id: string; messages: string[] }[];
const MESSAGES = new Map<string, string[]>([...CHAT_CORPUS, ...evalSet("dataset.json"), ...evalSet("long.json")].map((c) => [c.id, c.messages]));
const NO_WORDS = new Set("og ikke jeg det er på til med som har vi du kan hva hvordan å av den om så min må skal vil bør når eller fra hvis meg hun han oss deg også bare noe etter".split(" "));
const EN_WORDS = new Set("the and is to of in it you that with my what how can on this be are your do if or from should when not have will about".split(" "));
export function detectLang(text: string): string {
  const letters = text.match(/\p{L}/gu) ?? [];
  const cyr = letters.filter((c) => /[\u0400-\u04FF]/.test(c)).length;
  if (letters.length > 0 && cyr / letters.length > 0.3) return "ru";
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  const no = words.filter((w) => NO_WORDS.has(w)).length + (/[æøå]/i.test(text) ? 2 : 0);
  const en = words.filter((w) => EN_WORDS.has(w)).length;
  return no > en ? "no" : "en";
}
const chunkLang = new Map<Chunk, string>();
const msgLangAgree = { same: 0, total: 0 };
for (const c of convs) {
  const msgs = MESSAGES.get(c.id)!;
  for (const k of c.chunks) chunkLang.set(k, detectLang(msgs[k.msg]!));
  for (const m of msgs) {
    msgLangAgree.total++;
    if (detectLang(m) === c.lang) msgLangAgree.same++;
  }
}
const detLangMeans = new Map<string, Float64Array>();
for (const l of new Set(chunkLang.values())) {
  const vs = [...chunkLang].filter(([, x]) => x === l).map(([k]) => int8(k.v));
  const m = new Float64Array(vs[0]!.length);
  for (const v of vs) for (let i = 0; i < m.length; i++) m[i]! += v[i]! / vs.length;
  detLangMeans.set(l, m);
}
const det = (k: Chunk) => {
  const m = detLangMeans.get(chunkLang.get(k)!)!;
  return A.normalise(Float64Array.from(int8(k.v), (x, i) => x - m[i]!));
};
/** Title vector centred by the conversation's majority detected language. */
const detTitle = (c: Conv) => {
  const ls = c.chunks.map((k) => chunkLang.get(k)!);
  const top = [...new Set(ls)].sort((a, b) => ls.filter((x) => x === b).length - ls.filter((x) => x === a).length)[0]!;
  const m = detLangMeans.get(top)!;
  return A.normalise(Float64Array.from(int8(c.titleV), (x, i) => x - m[i]!));
};
const repAllDet = (c: Conv) => meanOf(longFirst(c.chunks).map(det));
const repUserDet = (c: Conv) => {
  const u = c.chunks.filter((k) => k.role === "user");
  return u.length > 0 ? meanOf(longFirst(u).map(det)) : repAllDet(c);
};
const plus = (a: Float64Array, b: Float64Array, wb = 1) => A.normalise(Float64Array.from(a, (x, i) => x + wb * b[i]!));
const REPS: Record<string, (c: Conv) => Float64Array> = {
  all: repAll,
  user: repUser,
  "user+title": (c) => plus(repUser(c), A.normalise(int8(c.titleV))),
  "all+title": (c) => plus(repAll(c), A.normalise(int8(c.titleV))),
  title: (c) => A.normalise(int8(c.titleV)),
  "all [det]": repAllDet,
  "user [det]": repUserDet,
  "all+title [det]": (c) => plus(repAllDet(c), detTitle(c)),
  "user+title [det]": (c) => plus(repUserDet(c), detTitle(c)),
  "user(query:)": (c) => {
    const u = c.chunks.filter((k) => k.role === "user" && k.q);
    return u.length > 0 ? meanOf(longFirst(u).map((k) => int8(k.q!))) : repAll(c);
  },
};

// ---------------------------------------------------------------- algorithms (on an index subset)
type Algo = (X: Float64Array[], idx: number[]) => A.Grouping;
/** Preprocessing of the subset's vectors before clustering (default: none; every algorithm centres). */
type Prep = (X: Float64Array[], idx: number[]) => Float64Array[];
const none: Prep = (X) => X;
/** Per-language centring (oracle language labels from the datasets). */
const langCentre: Prep = (X, idx) => {
  const out = X.slice();
  for (const l of new Set(idx.map((i) => langs[i]!))) {
    const pos = idx.map((i, p) => (langs[i] === l ? p : -1)).filter((p) => p >= 0);
    A.centre(pos.map((p) => X[p]!)).forEach((v, k) => (out[pos[k]!] = v));
  }
  return out;
};
/** Label-free: centre, then remove the top m principal components (power iteration). */
const dropPCs =
  (m: number): Prep =>
  (X) => {
    let Y = A.centre(X);
    const d = Y[0]!.length;
    for (let c = 0; c < m; c++) {
      let u: A.Vec = new Float64Array(d).fill(1 / Math.sqrt(d));
      for (let it = 0; it < 200; it++) {
        const w = new Float64Array(d);
        for (const y of Y) {
          const s = A.dot(y, u);
          for (let i = 0; i < d; i++) w[i]! += s * y[i]!;
        }
        u = A.normalise(w);
      }
      Y = Y.map((y) => {
        const s = A.dot(y, u);
        return A.normalise(Float64Array.from(y, (x, i) => x - s * u[i]!));
      });
    }
    return Y;
  };
/** Label-free language guess: Louvain at low resolution (it recovers the languages exactly at γ=0.5), then per-group centring. */
const coarseCentre: Prep = (X) => {
  const comm = A.louvain(A.knnGraph(A.simMatrix(A.centre(X)), 8), 0.5);
  const out = X.slice();
  for (const c of new Set(comm)) {
    const pos = comm.map((x, p) => (x === c ? p : -1)).filter((p) => p >= 0);
    A.centre(pos.map((p) => X[p]!)).forEach((v, k) => (out[pos[k]!] = v));
  }
  return out;
};
const PREPS: Record<string, Prep> = { none, lang: langCentre, "pc1": dropPCs(1), "pc3": dropPCs(3), "pc5": dropPCs(5), coarse: coarseCentre };
const kmeans: Algo = (X, idx) => {
  const items = idx.map((i) => ({ id: convs[i]!.id, title: convs[i]!.title, updatedAtSec: null }));
  const map = new Map(idx.map((i, p) => [convs[i]!.id, X[p]!]));
  const { topics } = groupConversations(items, map);
  const pos = new Map(idx.map((i, p) => [convs[i]!.id, p]));
  const g: A.Grouping = idx.map(() => []);
  topics.forEach((t, j) => t.conversations.forEach((c) => g[pos.get(c.id)!]!.push(j)));
  return g;
};
/** k-means with a chosen k: the production cluster() via groupConversations is fixed to √n, so call cluster() on centred vectors. */
const kmeansK =
  (k: number): Algo =>
  (X) => {
    const { assignment } = cluster(A.centre(X), k);
    return assignment.map((a) => [a]);
  };
const graph =
  (k: number, gamma: number, mutual = false, min = 2): Algo =>
  (X) => {
    const S = A.simMatrix(A.centre(X));
    return A.toGrouping(A.louvain(A.knnGraph(S, k, mutual), gamma), min);
  };
const hier =
  (t: number, min = 2): Algo =>
  (X) => {
    const S = A.simMatrix(A.centre(X));
    return A.toGrouping(A.cutAt(A.averageLinkage(S), t), min);
  };

// ---------------------------------------------------------------- evaluation
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
const ALL = [...Array(N).keys()];
const shares = (i: number, j: number) => labels[i]!.some((x) => labels[j]!.includes(x));

function evaluate(vs: Float64Array[], algo: Algo, prep: Prep = none) {
  const go = (idx: number[]) => algo(prep(idx.map((i) => vs[i]!), idx), idx);
  const g = go(ALL);
  const groups = A.groupsOf(g);
  const sizes = [...groups.values()].map((m) => m.length).sort((a, b) => b - a);
  const unsorted = g.filter((x) => x.length === 0).length;
  const b3 = A.bcubed(g, labels);
  // Intruders: members without the group's most common tag.
  let intruders = 0;
  let grouped = 0;
  for (const m of groups.values()) {
    const tc = new Map<string, number>();
    for (const i of m) for (const t of labels[i]!) tc.set(t, (tc.get(t) ?? 0) + 1);
    const top = [...tc].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0];
    intruders += m.filter((i) => !labels[i]!.includes(top)).length;
    grouped += m.length;
  }
  // Language vs subject: co-grouping rates for pair types.
  const pairs = { sameSubjCrossLang: [0, 0], sameSubjSameLang: [0, 0], diffSubjSameLang: [0, 0], diffSubjCrossLang: [0, 0] };
  for (let i = 0; i < N; i++)
    for (let j = i + 1; j < N; j++) {
      const together = g[i]!.some((x) => g[j]!.includes(x)) ? 1 : 0;
      const key = `${shares(i, j) ? "sameSubj" : "diffSubj"}${langs[i] === langs[j] ? "SameLang" : "CrossLang"}` as keyof typeof pairs;
      pairs[key][0]! += together;
      pairs[key][1]!++;
    }
  const rate = (k: keyof typeof pairs) => pairs[k][0]! / pairs[k][1]!;
  const h = A.hard(g);
  // Stability: 20 subsamples of 90%; ARI against the full grouping restricted to the subsample.
  const r = rng(7);
  const aris: number[] = [];
  for (let s = 0; s < 20; s++) {
    const idx = ALL.filter(() => r() < 0.9);
    const sub = A.hard(go(idx));
    aris.push(A.ari(sub, idx.map((i) => h[i]!)));
  }
  return {
    g,
    groups: groups.size,
    sizes,
    unsorted,
    largest: sizes[0] ?? 0,
    bcubed: b3,
    intruderRate: grouped ? intruders / grouped : 0,
    nmiSubject: A.nmi(h, primary),
    nmiLang: A.nmi(h, langs),
    nmiSet: A.nmi(h, convs.map((c) => c.set)),
    sameSubjCrossLang: rate("sameSubjCrossLang"),
    sameSubjSameLang: rate("sameSubjSameLang"),
    diffSubjSameLang: rate("diffSubjSameLang"),
    diffSubjCrossLang: rate("diffSubjCrossLang"),
    stability: aris.reduce((a, b) => a + b, 0) / aris.length,
  };
}

const f2 = (x: number) => x.toFixed(2);
const row = (name: string, e: ReturnType<typeof evaluate>) =>
  `| ${name} | ${e.groups} | ${e.largest} | ${e.unsorted} | ${f2(e.bcubed.p)} | ${f2(e.bcubed.r)} | **${f2(e.bcubed.f)}** | ${f2(e.intruderRate)} | ${f2(e.sameSubjCrossLang)} | ${f2(e.diffSubjSameLang)} | ${f2(e.diffSubjCrossLang)} | ${f2(e.nmiSubject)} / ${f2(e.nmiLang)} | ${f2(e.stability)} |`;
const HEAD =
  "| config | groups | largest | unsorted | B³ P | B³ R | B³ F | intruders | co-grouped: same subject, other lang | diff subject, same lang | diff subject, other lang | NMI subject / lang | stability (ARI) |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|";

const lines: string[] = [];
const log = (s = "") => {
  lines.push(s);
  console.log(s);
};
const vecs = Object.fromEntries(Object.entries(REPS).map(([k, f]) => [k, convs.map(f)]));
const results: Record<string, ReturnType<typeof evaluate>> = {};
const run = (name: string, rep: string, algo: Algo, prep = "none") => {
  const e = evaluate(vecs[rep]!, algo, PREPS[prep]);
  if (prep !== "none") rep = `${rep} +${prep}`;
  results[`${name} @ ${rep}`] = e;
  return e;
};

// Reference points: gold labels as a grouping (primary tag), and language only.
const asGrouping = (keys: string[]): A.Grouping => {
  const ids = new Map<string, number>();
  return keys.map((k) => [ids.has(k) ? ids.get(k)! : (ids.set(k, ids.size), ids.size - 1)]);
};
const ref = (name: string, g: A.Grouping) => {
  const b = A.bcubed(g, labels);
  log(`- ${name}: B³ F ${f2(b.f)} (P ${f2(b.p)}, R ${f2(b.r)}), groups ${A.groupsOf(g).size}`);
};
log(`# Mind-map spike results (${N} synthetic conversations; ${new Set(langs).size} languages: ${[...new Set(langs)].map((l) => `${l} ${langs.filter((x) => x === l).length}`).join(", ")})\n`);
log("Reference points:");
ref("gold primary tag (upper bound for one topic per conversation)", asGrouping(primary));
ref("language only", asGrouping(langs));
ref("everything in one group", asGrouping(primary.map(() => "x")));
ref("everything unsorted", ALL.map(() => []));

log("\n## 1. Algorithms × representations (default settings)\n");
log(HEAD);
const DEFAULTS: [string, Algo][] = [
  ["k-means (prod, k=10)", kmeans],
  ["graph k=6 γ=1", graph(6, 1)],
  ["hier t=0.75", hier(0.75)],
];
for (const rep of Object.keys(REPS)) for (const [name, algo] of DEFAULTS) log(row(`${name} @ ${rep}`, run(name, rep, algo)));

const sweepRep = process.env.SWEEP_REP ?? "user+title";
log(`\n## 2. Parameter sweep @ ${sweepRep}\n`);
log(HEAD);
for (const k of [4, 6, 8, 10, 15]) for (const gm of [0.5, 0.75, 1, 1.5, 2]) log(row(`graph k=${k} γ=${gm}`, run(`graph k=${k} γ=${gm}`, sweepRep, graph(k, gm))));
for (const k of [6, 10]) log(row(`graph mutual k=${k} γ=1`, run(`graph mutual k=${k} γ=1`, sweepRep, graph(k, 1, true))));
for (const t of [0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95]) log(row(`hier t=${t}`, run(`hier t=${t}`, sweepRep, hier(t))));

log("\n## 3. Removing the language signal (preprocessing) × representation\n");
log(HEAD);
for (const prep of ["lang", "coarse", "pc1", "pc3", "pc5"])
  for (const rep of ["all", "user", "user+title", "all+title"])
    for (const [name, algo] of [...DEFAULTS, ["graph k=6 γ=1.5", graph(6, 1.5)] as [string, Algo], ["hier t=0.85", hier(0.85)] as [string, Algo]])
      log(row(`${name} @ ${rep} +${prep}`, run(name, rep, algo, prep)));
log(`\n## 4. Label-free: per-message language detection, chunk-level centring\n\nDetector agrees with the dataset language for ${msgLangAgree.same} of ${msgLangAgree.total} messages.\n`);
log(HEAD);
for (const rep of ["all [det]", "user [det]", "all+title [det]", "user+title [det]"])
  for (const [name, algo] of [...DEFAULTS, ["graph k=6 γ=1.5", graph(6, 1.5)] as [string, Algo], ["hier t=0.85", hier(0.85)] as [string, Algo]])
    log(row(`${name} @ ${rep}`, run(name, rep, algo)));
log("\n## 5. Sweeps @ all+title [det]\n");
log(HEAD);
for (const k of [4, 6, 8, 10]) for (const gm of [1, 1.5, 2, 3]) log(row(`graph k=${k} γ=${gm}`, run(`graph k=${k} γ=${gm}`, "all+title [det]", graph(k, gm))));
for (const t of [0.75, 0.8, 0.85, 0.9, 0.95, 1.0]) log(row(`hier t=${t}`, run(`hier t=${t}`, "all+title [det]", hier(t))));
for (const k of [6, 8, 12, 15, 20]) log(row(`k-means k=${k}`, run(`k-means k=${k}`, "all+title [det]", kmeansK(k))));

log("\nNMI with the source dataset (chat / v0 / long) for selected configs:");
for (const k of Object.keys(results).filter((k) => /k-means.*@ (all|user\+title)( \+lang)?$/.test(k))) log(`- ${k}: ${f2(results[k]!.nmiSet)}`);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "metrics.md"), lines.join("\n") + "\n");
fs.writeFileSync(
  path.join(outDir, "metrics.json"),
  JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, e]) => [k, { ...e, g: undefined }])), null, 1),
);

// ---------------------------------------------------------------- readable group listings
export function listing(title: string, g: A.Grouping) {
  const groups = [...A.groupsOf(g).values()].sort((a, b) => b.length - a.length);
  const names = topicWords(groups.map((m) => m.map((i) => convs[i]!.title)));
  const out = [`## ${title}\n`];
  groups.forEach((m, j) => {
    const tc = new Map<string, number>();
    for (const i of m) for (const t of labels[i]!) tc.set(t, (tc.get(t) ?? 0) + 1);
    const top = [...tc].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0];
    out.push(`**G${j + 1}** (${m.length}) — name from titles: *${names[j]!.join(" · ") || "(none)"}* — majority tag: \`${top}\``);
    for (const i of m) out.push(`- ${labels[i]!.includes(top) ? "" : "✗ "}${convs[i]!.title} [${convs[i]!.lang}; ${labels[i]!.join(", ")}]${g[i]!.length > 1 ? ` (also G${g[i]!.filter((x) => x !== g[i]![0]).join(",")})` : ""}`);
    out.push("");
  });
  const un = g.map((x, i) => (x.length === 0 ? i : -1)).filter((i) => i >= 0);
  if (un.length) out.push(`**Unsorted** (${un.length}): ${un.map((i) => `${convs[i]!.title} [${convs[i]!.lang}; ${labels[i]!.join(", ")}]`).join(" · ")}\n`);
  return out.join("\n");
}
const LIST = (process.env.LIST ?? "").split(";").filter(Boolean);
const docs: string[] = [];
for (const spec of LIST) {
  const [name, rep] = spec.split("@").map((s) => s.trim());
  const g = results[`${name} @ ${rep}`]?.g;
  if (g) docs.push(listing(`${name} @ ${rep}`, g));
}
if (docs.length) fs.writeFileSync(path.join(outDir, "groups.md"), docs.join("\n"));
export { convs, labels, vecs, evaluate, graph, hier, kmeans };

// ---------------------------------------------------------------- 6. multi-topic membership
// On the recommended setting: hierarchical t=0.85 @ all+title [det]. Two ways to add a second group:
//  (a) conversation level: also join the nearest other group if within δ of the own group's centroid;
//  (b) turn level: each user turn (+ its reply) is assigned to its nearest group centroid; a turn
//      that lands in another group, closer to it than to the own group by a margin, adds that group.
if (process.env.MULTI !== "0") {
  const REP = "all+title [det]";
  const X = A.centre(vecs[REP]!);
  const base = hier(0.85)(vecs[REP]!, ALL);
  const groups = A.groupsOf(base);
  const cent = new Map([...groups].map(([gid, m]) => [gid, meanOf(m.map((i) => X[i]!))]));
  // Global mean used by A.centre, to place turn vectors in the same space.
  const raw = vecs[REP]!;
  const gmean = new Float64Array(raw[0]!.length);
  for (const v of raw) for (let d = 0; d < gmean.length; d++) gmean[d]! += v[d]! / raw.length;
  const toSpace = (v: Float64Array) => A.normalise(Float64Array.from(v, (x, d) => x - gmean[d]!));
  const majority = (gid: number) => {
    const tc = new Map<string, number>();
    for (const i of groups.get(gid)!) for (const t of labels[i]!) tc.set(t, (tc.get(t) ?? 0) + 1);
    return [...tc].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0];
  };
  const report = (name: string, g: A.Grouping) => {
    const b = A.bcubed(g, labels);
    let extras = 0, right = 0;
    const multi = ALL.filter((i) => labels[i]!.length > 1);
    let multiHit = 0;
    const lines2: string[] = [];
    g.forEach((gs, i) => gs.slice(1).forEach((x) => {
      extras++;
      const ok = labels[i]!.includes(majority(x));
      if (ok) right++;
      lines2.push(`  - ${ok ? "✓" : "✗"} ${convs[i]!.title} [${labels[i]!.join(", ")}] → also group of \`${majority(x)}\``);
    }));
    for (const i of multi) if (g[i]!.length > 1 && g[i]!.slice(1).some((x) => labels[i]!.slice(1).includes(majority(x)))) multiHit++;
    log(`| ${name} | ${f2(b.p)} | ${f2(b.r)} | **${f2(b.f)}** | ${extras} | ${right} | ${multiHit} / ${multi.length} |`);
    return lines2;
  };
  log("\n## 6. Multi-topic membership @ hier t=0.85, all+title [det]\n");
  log("| variant | B³ P | B³ R | B³ F | extra memberships | extras matching a label | multi-label conversations given a secondary label's group |\n|---|---|---|---|---|---|---|");
  const detail: string[] = [];
  report("one group each", base);
  for (const delta of [0.02, 0.05, 0.1]) {
    const g = base.map((gs, i) => {
      if (gs.length === 0) return gs;
      // Leave-one-out: the own group's centroid without this conversation.
      const mates = groups.get(gs[0]!)!.filter((j) => j !== i);
      const own = mates.length ? A.dot(X[i]!, meanOf(mates.map((j) => X[j]!))) : -1;
      const others = [...cent].filter(([gid]) => gid !== gs[0]).map(([gid, c]) => [gid, A.dot(X[i]!, c)] as const).sort((a, b) => b[1] - a[1]);
      return others[0] && others[0][1] >= own - delta ? [gs[0]!, others[0][0]] : gs;
    });
    const l = report(`(a) centroid δ=${delta}`, g);
    detail.push(`(a) δ=${delta}:`, ...l);
  }
  for (const margin of [0, 0.05, 0.1]) {
    const g = base.map((gs, i) => {
      if (gs.length === 0) return gs;
      const c = convs[i]!;
      const turns = new Map<number, Chunk[]>();
      for (const k of c.chunks) {
        const t = Math.floor(k.msg / 2);
        turns.set(t, [...(turns.get(t) ?? []), k]);
      }
      const extra = new Set<number>();
      for (const ks of turns.values()) {
        // Only turns whose user message says something (a chunk of MIN_SEARCH_TOKENS or more).
        if (!ks.some((k) => k.role === "user" && k.tokenCount >= MIN_SEARCH_TOKENS)) continue;
        if (turns.size < 2) continue; // a single-turn conversation has no second topic to find
        const v = toSpace(meanOf(longFirst(ks).map(det)));
        const mates = groups.get(gs[0]!)!.filter((j) => j !== i);
        const own = mates.length ? A.dot(v, meanOf(mates.map((j) => X[j]!))) : -1;
        const best = [...cent].map(([gid, cv]) => [gid, A.dot(v, cv)] as const).sort((a, b) => b[1] - a[1])[0]!;
        if (best[0] !== gs[0] && best[1] > own + margin) extra.add(best[0]);
      }
      return [gs[0]!, ...[...extra].slice(0, 1)];
    });
    const l = report(`(b) turn level, margin ${margin}`, g);
    detail.push(`(b) margin ${margin}:`, ...l);
  }
  fs.writeFileSync(path.join(outDir, "multi-topic.md"), detail.join("\n") + "\n");

  // Two-level hierarchy: broad themes (t=0.95) containing topics (t=0.85).
  const Xc = A.centre(vecs[REP]!);
  const dendro = A.averageLinkage(A.simMatrix(Xc));
  const fine = A.toGrouping(A.cutAt(dendro, 0.85));
  const coarse = A.cutAt(dendro, 0.95);
  const out = ["## Two-level hierarchy @ all+title [det]: themes (t=0.95) → topics (t=0.85)\n"];
  const themes = new Map<number, number[]>();
  ALL.forEach((i) => themes.set(coarse[i]!, [...(themes.get(coarse[i]!) ?? []), i]));
  const tlist = [...themes.values()].sort((a, b) => b.length - a.length);
  const tnames = topicWords(tlist.map((m) => m.map((i) => convs[i]!.title)));
  tlist.forEach((m, j) => {
    out.push(`### Theme ${j + 1} (${m.length}) — *${tnames[j]!.join(" · ") || "(no shared title words)"}*`);
    const sub = new Map<string, number[]>();
    for (const i of m) {
      const key = fine[i]!.length ? `g${fine[i]![0]}` : `u${i}`;
      sub.set(key, [...(sub.get(key) ?? []), i]);
    }
    for (const [key, s] of [...sub].sort((a, b) => b[1].length - a[1].length))
      out.push(`- ${key.startsWith("u") ? "(on its own) " : ""}${s.map((i) => `${convs[i]!.title} [${convs[i]!.lang}; ${labels[i]!.join(", ")}]`).join(" · ")}`);
    out.push("");
  });
  fs.writeFileSync(path.join(outDir, "hierarchy.md"), out.join("\n"));
}
fs.writeFileSync(path.join(outDir, "metrics.md"), lines.join("\n") + "\n");
