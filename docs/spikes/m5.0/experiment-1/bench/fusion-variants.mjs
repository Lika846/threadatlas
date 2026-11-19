// Rank-only fusion variants computed from saved rankings (no re-embedding).
import fs from "node:fs";
const [inFile, outFile] = process.argv.slice(2);
const raw = JSON.parse(fs.readFileSync(inFile, "utf8"));
function rrf(lists, k = 60) {
  const score = new Map(), num = new Map();
  for (const { list, cut, w } of lists) list.slice(0, cut).forEach((r, i) => {
    score.set(r.sid, (score.get(r.sid) ?? 0) + w / (k + i + 1));
    if (!num.has(r.sid)) num.set(r.sid, r.num);
  });
  return [...score].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([sid]) => ({ sid, num: num.get(sid) }));
}
for (const r of raw) {
  r.hyb10 = rrf([{ list: r.sem, cut: 10, w: 1 }, { list: r.or, cut: 10, w: 1 }]);
  r.hybW = rrf([{ list: r.sem, cut: 20, w: 2 }, { list: r.or, cut: 20, w: 1 }]);
}
fs.writeFileSync(outFile, JSON.stringify(raw));
