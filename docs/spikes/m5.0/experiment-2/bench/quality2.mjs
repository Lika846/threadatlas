// Experiment 2 retrieval quality: representations × query sets, with the direct runtime.
// Usage: node --import ./tripwire.mjs quality2.mjs <rt> <modelDir> <corpus.json> <queries.json> <keywordRaw.json> <outDir> <tag> [reps] [batch]
// Writes raw rankings per representation and a summary with chunk counts, timings and evidence hits.
import fs from "node:fs";
import path from "node:path";
import { createDirectEmbedder } from "./direct.mjs";

const [rt, modelDir, corpusFile, queriesFile, kwFile, outDir, tag, repsArg, batchArg] = process.argv.slice(2);
const REPS = (repsArg ?? "message,turn,win256,win64,sent256,sent64,sent64title").split(",");
const BATCH = Number(batchArg ?? 16);
const corpus = JSON.parse(fs.readFileSync(corpusFile, "utf8")).conversations;
const queries = JSON.parse(fs.readFileSync(queriesFile, "utf8")).queries;
const kw = new Map(JSON.parse(fs.readFileSync(kwFile, "utf8")).map((r) => [r.id, r]));
const e = await createDirectEmbedder({ rt, modelDir });
const T = e.tokenizer;
const ntok = (s) => T.encode(s, { add_special_tokens: false }).ids.length;

// Sentence spans with character offsets (paragraph breaks and . ! ? followed by whitespace).
function sentences(text) {
  const out = [];
  const re = /[^.!?\n]+(?:[.!?]+|$)|\n+/g;
  let m;
  while ((m = re.exec(text))) {
    if (/^\s*$/.test(m[0])) continue;
    const lead = m[0].length - m[0].trimStart().length;
    out.push({ start: m.index + lead, end: m.index + m[0].trimEnd().length });
  }
  return out;
}
// Packs whole sentences up to `max` tokens; one sentence of overlap; an over-long sentence becomes its own unit.
function sentenceChunks(text, max) {
  const ss = sentences(text).map((s) => ({ ...s, n: ntok(text.slice(s.start, s.end)) }));
  const chunks = [];
  let i = 0;
  while (i < ss.length) {
    let j = i, n = 0;
    while (j < ss.length && (j === i || n + ss[j].n <= max)) { n += ss[j].n; j++; }
    chunks.push({ start: ss[i].start, end: ss[j - 1].end });
    if (j >= ss.length) break;
    i = j - 1 > i ? j - 1 : j; // overlap one sentence when the chunk has more than one
  }
  return chunks;
}
function tokenWindows(text, size, overlap) {
  const ids = T.encode(text, { add_special_tokens: false }).ids;
  if (ids.length <= size) return [{ text }];
  const out = [];
  for (let s = 0; s < ids.length; s += size - overlap) {
    out.push({ text: T.decode(ids.slice(s, s + size), { skip_special_tokens: true }) });
    if (s + size >= ids.length) break;
  }
  return out;
}

function units(rep) {
  const out = [];
  for (const c of corpus) {
    c.messages.forEach((m, k) => {
      const num = k + 1;
      if (rep === "message") out.push({ cid: c.id, msgs: [num], text: m });
      else if (rep === "turn") { if (k % 2 === 0) out.push({ cid: c.id, msgs: [num, num + 1].filter((x) => x <= c.messages.length), text: c.messages.slice(k, k + 2).join("\n\n") }); }
      else if (rep.startsWith("win")) { const size = Number(rep.slice(3)); for (const w of tokenWindows(m, size, size === 256 ? 32 : 16)) out.push({ cid: c.id, msgs: [num], text: w.text }); }
      else if (rep.startsWith("sent")) {
        const max = Number(rep.match(/\d+/)[0]);
        for (const ch of sentenceChunks(m, max)) out.push({ cid: c.id, msgs: [num], text: m.slice(ch.start, ch.end), start: ch.start, end: ch.end, prefix: rep.endsWith("title") ? `${c.title}. ` : "" });
      }
    });
  }
  return out;
}

// The text the model actually sees (after the 512-token limit), to judge whether a unit "explains" a hit.
function embeddedText(u) {
  const full = "passage: " + (u.prefix ?? "") + u.text;
  const ids = e.encode(full);
  if (ids.length < 512) return full;
  return T.decode(ids, { skip_special_tokens: true });
}

const RRF = 60;
function rrf(lists) {
  const s = new Map(), num = new Map();
  for (const list of lists) list.slice(0, 20).forEach((r, i) => { s.set(r.sid, (s.get(r.sid) ?? 0) + 1 / (RRF + i + 1)); if (!num.has(r.sid)) num.set(r.sid, r.num); });
  return [...s].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([sid]) => ({ sid, num: num.get(sid) }));
}

const summary = { tag, batch: BATCH, corpusConversations: corpus.length, queries: queries.length, loadMs: e.loadMs, reps: {} };
const qv = new Map();
for (const q of queries) qv.set(q.id, (await e.embedBatched(["query: " + q.text], 1))[0]);

for (const rep of REPS) {
  const us = units(rep);
  const texts = us.map((u) => "passage: " + (u.prefix ?? "") + u.text);
  const toks = texts.map((t) => e.encode(t).length);
  const t0 = performance.now();
  let uv = await e.embedBatched(texts, BATCH);
  const indexMs = performance.now() - t0;
  if (process.env.M5_INT8) uv = uv.map((v) => { let m = 0; for (const x of v) m = Math.max(m, Math.abs(x)); const s = m / 127 || 1; return Float32Array.from(v, (x) => Math.round(x / s) * s); }); // as stored by the int8 table
  const raw = [];
  const evidence = [];
  const lat = [];
  for (const q of queries) {
    const t = performance.now();
    const v = qv.get(q.id);
    const best = new Map();
    for (let i = 0; i < uv.length; i++) {
      let s = 0;
      for (let k = 0; k < v.length; k++) s += v[k] * uv[i][k];
      const b = best.get(us[i].cid);
      if (!b || s > b.s) best.set(us[i].cid, { s, i });
    }
    const sem = [...best].sort((a, b) => b[1].s - a[1].s).slice(0, 50).map(([sid, b]) => ({ sid, num: us[b.i].msgs.length === 1 ? us[b.i].msgs[0] : us[b.i].msgs, unit: b.i }));
    lat.push(performance.now() - t);
    const k = kw.get(q.id);
    const gated = k.and.length > 0 ? rrf([sem, k.and]) : sem.slice(0, 20); // a priori design, not tuned
    raw.push({ id: q.id, and: k.and, or: k.or, sem: sem.slice(0, 20).map(({ sid, num }) => ({ sid, num })), fusedOr: rrf([sem, k.or]), gated: gated.map(({ sid, num }) => ({ sid, num })) });
    if (q.evidence && q.target) {
      const hit = sem.find((r) => r.sid === q.target[0]);
      const u = hit ? us[hit.unit] : null;
      const rank = hit ? sem.indexOf(hit) + 1 : null;
      const inUnit = u ? embeddedText(u).toLowerCase().includes(q.evidence.toLowerCase()) : false;
      evidence.push({ id: q.id, rank, evidenceInBestUnit: inUnit, bestUnitTokens: u ? toks[hit.unit] : null, bestUnitExcerpt: u ? u.text.slice(0, 160) : null, offsets: u && u.start !== undefined ? [u.start, u.end] : null });
    }
  }
  const sorted = [...lat].sort((a, b) => a - b);
  summary.reps[rep] = {
    units: us.length, tokensMean: +(toks.reduce((a, b) => a + b, 0) / us.length).toFixed(1), tokensMax: Math.max(...toks),
    truncatedUnits: toks.filter((n) => n > 512).length, indexMs: +indexMs.toFixed(0), unitsPerSec: +(us.length / (indexMs / 1000)).toFixed(1),
    retrieveMs: { p50: +sorted[Math.floor(sorted.length / 2)].toFixed(2), p95: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2) },
    evidenceHit: evidence.length ? +(evidence.filter((x) => x.evidenceInBestUnit && x.rank !== null && x.rank <= 10).length / evidence.length).toFixed(3) : null,
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `raw-${tag}-${rep}.json`), JSON.stringify(raw));
  fs.writeFileSync(path.join(outDir, `evidence-${tag}-${rep}.json`), JSON.stringify(evidence, null, 1));
  console.error(`${tag} ${rep}: ${us.length} units, ${(indexMs / 1000).toFixed(1)} s`);
}
summary.peakRssMb = +(process.resourceUsage().maxRSS / 1024).toFixed(0);
summary.tripwire = globalThis.__tripwireAttempts?.();
fs.writeFileSync(path.join(outDir, `summary-${tag}.json`), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary));
await e.release();
