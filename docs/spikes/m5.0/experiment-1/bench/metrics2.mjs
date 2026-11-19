import fs from "node:fs";
const [dir, rawFile, outFile, modesArg] = process.argv.slice(2);
const MODES = (modesArg ?? "and,or").split(",");
const { queries, conversations } = JSON.parse(fs.readFileSync(`${dir}/dataset.json`, "utf8"));
const raw = new Map(JSON.parse(fs.readFileSync(rawFile, "utf8")).map((r) => [r.id, r]));
const langOf = new Map(conversations.map((c) => [c.id, c.lang]));
const K = 10;
function score(q, ranked) {
  const top = ranked.slice(0, K);
  const rel = q.relevant;
  const relIds = Object.keys(rel);
  const found = top.filter((r) => r.sid in rel).length;
  const recall = found / Math.min(relIds.length, K);
  const first = top.findIndex((r) => r.sid in rel);
  const mrr = first === -1 ? 0 : 1 / (first + 1);
  const dcg = top.reduce((s, r, i) => s + ((2 ** (rel[r.sid] ?? 0) - 1) / Math.log2(i + 2)), 0);
  const ideal = Object.values(rel).sort((a, b) => b - a).slice(0, K).reduce((s, g, i) => s + (2 ** g - 1) / Math.log2(i + 2), 0);
  const msg = q.target ? ((() => { const got = [top.find((r) => r.sid === q.target[0])?.num].flat(); return [q.target[1]].flat().some((n) => got.includes(n)) ? 1 : 0; })()) : null;
  return { recall, mrr, ndcg: ideal ? dcg / ideal : 0, msg, hit1: first === 0 ? 1 : 0, returned: ranked.length };
}
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const groups = { all: () => true };
for (const c of ["paraphrase", "crosslingual", "buried", "decoy", "unfinished", "keyword"]) groups[c] = (q) => q.category === c;
for (const l of ["en", "no", "ru"]) groups[`query:${l}`] = (q) => q.lang === l;
groups["same-language"] = (q) => Object.keys(q.relevant).every((id) => langOf.get(id) === q.lang);
groups["cross-language"] = (q) => Object.keys(q.relevant).some((id) => langOf.get(id) !== q.lang);
const rows = [];
const per = [];
for (const mode of MODES) {
  const s = new Map(queries.map((q) => [q.id, score(q, raw.get(q.id)[mode])]));
  for (const [g, f] of Object.entries(groups)) {
    const qs = queries.filter(f);
    const v = qs.map((q) => s.get(q.id));
    const m = v.map((x) => x.msg).filter((x) => x !== null);
    rows.push({ mode, group: g, n: qs.length, "R@10": avg(v.map((x) => x.recall)), "MRR@10": avg(v.map((x) => x.mrr)), "nDCG@10": avg(v.map((x) => x.ndcg)), "hit@1": avg(v.map((x) => x.hit1)), "msg@10": avg(m), zeroResults: v.filter((x) => x.returned === 0).length });
  }
  for (const q of queries) per.push({ mode, id: q.id, cat: q.category, ...s.get(q.id), top3: raw.get(q.id)[mode].slice(0, 3).map((r) => `${r.sid}#${r.num}`).join(" ") });
}
const timing = {};
const out = { rows, per, timing };
fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
const f = (x) => (Number.isNaN(x) ? "–" : x.toFixed(2));
for (const r of rows) console.log(`${r.mode.padEnd(4)} ${r.group.padEnd(15)} n=${String(r.n).padStart(2)}  R@10 ${f(r["R@10"])}  MRR ${f(r["MRR@10"])}  nDCG ${f(r["nDCG@10"])}  hit@1 ${f(r["hit@1"])}  msg ${f(r["msg@10"])}  zero ${r.zeroResults}`);
console.log(JSON.stringify(timing));
