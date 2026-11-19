// Retrieval quality and query latency on the synthetic set, for three representations.
// Usage: M5_DATASET=... M5_KEYWORD_RAW=... node --import ./tripwire.mjs quality.mjs
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { dot, embed, loadModel, loadTransformers, ortVersionLoaded, peakRssMb, pct, readDataset, report } from "./common.mjs";

const CHUNK_TOKENS = Number(process.env.M5_CHUNK_TOKENS ?? 256); // content tokens per chunk (e5 limit is 512 incl. prefix and specials)
const OVERLAP = Number(process.env.M5_OVERLAP ?? 32);
const REPS = (process.env.M5_REPS ?? "message,chunk,turn").split(",");
const TAG = process.env.M5_TAG ?? "";
const RRF_K = 60;

const { tf, importMs } = await loadTransformers();
const { extractor, tokenizer, loadMs } = await loadModel(tf);
const data = readDataset();
const keywordRaw = new Map(JSON.parse(fs.readFileSync(process.env.M5_KEYWORD_RAW, "utf8")).map((r) => [r.id, r]));

const tokens = (text) => tokenizer.encode(text, { add_special_tokens: false });

// ---- units per representation: { cid, msgs: [message numbers], text }
function units(rep) {
  const out = [];
  for (const c of data.conversations) {
    if (rep === "message") c.messages.forEach((t, i) => out.push({ cid: c.id, msgs: [i + 1], text: t }));
    if (rep === "turn") for (let i = 0; i < c.messages.length; i += 2) out.push({ cid: c.id, msgs: [i + 1, i + 2].filter((n) => n <= c.messages.length), text: c.messages.slice(i, i + 2).join("\n\n") });
    if (rep === "chunk") c.messages.forEach((t, i) => {
      const ids = tokens(t);
      if (ids.length <= CHUNK_TOKENS) return void out.push({ cid: c.id, msgs: [i + 1], text: t });
      for (let s = 0; s < ids.length; s += CHUNK_TOKENS - OVERLAP) {
        out.push({ cid: c.id, msgs: [i + 1], text: tokenizer.decode(ids.slice(s, s + CHUNK_TOKENS), { skip_special_tokens: true }) });
        if (s + CHUNK_TOKENS >= ids.length) break;
      }
    });
  }
  return out;
}

// ---- in-process keyword side for latency: FTS5 OR + bm25 (same tokenizer as the app), from the project's better-sqlite3
const require = createRequire(path.join(process.env.M5_PROJECT, "package.json"));
const Database = require("better-sqlite3");
const kdb = new Database(":memory:");
kdb.exec(`CREATE VIRTUAL TABLE m USING fts5(cid UNINDEXED, num UNINDEXED, body, tokenize = 'unicode61 remove_diacritics 2')`);
const ins = kdb.prepare("INSERT INTO m (cid, num, body) VALUES (?, ?, ?)");
for (const c of data.conversations) c.messages.forEach((t, i) => ins.run(c.id, i + 1, t));
const kstmt = kdb.prepare("SELECT cid, bm25(m) AS s FROM m WHERE m MATCH ?");
const kq = { all: (fts) => { const best = new Map(); for (const r of kstmt.all(fts)) if (!best.has(r.cid) || r.s < best.get(r.cid)) best.set(r.cid, r.s); return [...best].sort((x, y) => x[1] - y[1]).slice(0, 20); } };
const orQuery = (terms) => terms.map((x) => `"${x.replace(/"/g, '""')}"`).join(" OR ");

function rankSemantic(qv, uv, us) {
  const best = new Map();
  for (let i = 0; i < uv.length; i++) {
    const s = dot(qv, uv[i]);
    const b = best.get(us[i].cid);
    if (!b || s > b.s) best.set(us[i].cid, { s, num: us[i].msgs.length === 1 ? us[i].msgs[0] : us[i].msgs });
  }
  return [...best.entries()].sort((a, b) => b[1].s - a[1].s).slice(0, 50).map(([sid, v]) => ({ sid, num: v.num, s: v.s }));
}
function fuse(sem, kw) {
  const score = new Map();
  const num = new Map();
  sem.forEach((r, i) => { score.set(r.sid, (score.get(r.sid) ?? 0) + 1 / (RRF_K + i + 1)); num.set(r.sid, r.num); });
  kw.forEach((r, i) => { score.set(r.sid, (score.get(r.sid) ?? 0) + 1 / (RRF_K + i + 1)); if (!num.has(r.sid)) num.set(r.sid, r.num); });
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([sid]) => ({ sid, num: num.get(sid) }));
}

const results = { ortVersion: ortVersionLoaded(), importMs, loadMs, reps: {} };
// warm-up
await embed(extractor, ["query: warm up", "query: oppvarming", "query: разогрев"], 1);

for (const rep of REPS) {
  const us = units(rep);
  const tokenCounts = us.map((u) => tokens("passage: " + u.text).length + 2);
  const t0 = performance.now();
  const uv = await embed(extractor, us.map((u) => "passage: " + u.text), 16);
  const indexMs = performance.now() - t0;
  const raw = [];
  const lat = { embed: [], retrieve: [], keyword: [], fuse: [], total: [] };
  for (const q of data.queries) {
    const k = keywordRaw.get(q.id);
    const a = performance.now();
    const [qv] = await embed(extractor, ["query: " + q.text], 1);
    const b = performance.now();
    const sem = rankSemantic(qv, uv, us);
    const c = performance.now();
    if (k.terms) kq.all(orQuery(k.terms)); // timing only; quality uses the app's committed OR ranking
    const d = performance.now();
    const hyb = fuse(sem, k.or);
    const e = performance.now();
    lat.embed.push(b - a); lat.retrieve.push(c - b); lat.keyword.push(d - c); lat.fuse.push(e - d); lat.total.push(e - a);
    raw.push({ id: q.id, and: k.and, or: k.or, sem: sem.slice(0, 20).map(({ sid, num }) => ({ sid, num })), hyb });
  }
  const sum = (xs) => Object.fromEntries(["p50", "p95", "max"].map((p, i) => [p, +[pct(xs, 0.5), pct(xs, 0.95), Math.max(...xs)][i].toFixed(2)]));
  results.reps[rep] = {
    units: us.length,
    tokensMean: +(tokenCounts.reduce((x, y) => x + y, 0) / us.length).toFixed(1),
    tokensMax: Math.max(...tokenCounts),
    truncatedUnits: tokenCounts.filter((n) => n > 512).length,
    indexMs: +indexMs.toFixed(0),
    unitsPerSec: +(us.length / (indexMs / 1000)).toFixed(1),
    latencyMs: Object.fromEntries(Object.entries(lat).map(([k, v]) => [k, sum(v)])),
  };
  fs.mkdirSync(path.join(process.env.M5_OUT), { recursive: true });
  fs.writeFileSync(path.join(process.env.M5_OUT, `raw-${rep}${TAG}.json`), JSON.stringify(raw));
}

// Retrieval scan cost at larger sizes (random unit vectors, 384 dims, float32).
const scan = {};
for (const n of process.env.M5_SKIP_SCAN ? [] : [5_000, 50_000, 100_000]) {
  const dim = 384;
  const buf = new Float32Array(n * dim);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.random() - 0.5;
  const q = buf.subarray(0, dim);
  const times = [];
  for (let r = 0; r < 20; r++) {
    const t = performance.now();
    let best = -Infinity;
    for (let i = 0; i < n; i++) {
      let s = 0;
      const o = i * dim;
      for (let j = 0; j < dim; j++) s += q[j] * buf[o + j];
      if (s > best) best = s;
    }
    times.push(performance.now() - t);
  }
  scan[n] = { p50: +pct(times, 0.5).toFixed(2), p95: +pct(times, 0.95).toFixed(2) };
}
results.scanMs = scan;
results.peakRssMb = +peakRssMb().toFixed(0);
results.tripwireAttempts = globalThis.__tripwireAttempts?.() ?? null;
report(`quality${TAG}`, results);
console.log(JSON.stringify(results, null, 1));
