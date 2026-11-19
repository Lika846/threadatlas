import fs from "node:fs";
const [textsFile, aFile, bFile] = process.argv.slice(2);
const texts = JSON.parse(fs.readFileSync(textsFile, "utf8"));
const A = JSON.parse(fs.readFileSync(aFile, "utf8")), B = JSON.parse(fs.readFileSync(bFile, "utf8"));
const cos = (x, y) => x.reduce((s, v, i) => s + v * y[i], 0);
const maxAbs = (x, y) => x.reduce((m, v, i) => Math.max(m, Math.abs(v - y[i])), 0);
const idMismatch = texts.map((_, i) => JSON.stringify(A.ids[i]) === JSON.stringify(B.ids[i]) ? null : i).filter((x) => x !== null);
function cmp(a, b) { let minCos = 1, mx = 0; a.forEach((v, i) => { minCos = Math.min(minCos, cos(v, b[i])); mx = Math.max(mx, maxAbs(v, b[i])); }); return { minCosine: minCos, maxAbsDiff: mx }; }
const longIdx = texts.map((t, i) => (A.ids[i].length >= 512 ? i : -1)).filter((i) => i >= 0);
const out = {
  texts: texts.length, over512: longIdx.length,
  tokenIdsIdentical: idMismatch.length === 0, idMismatches: idMismatch.slice(0, 5).map((i) => ({ i, text: texts[i].slice(0, 60), a: A.ids[i].length, b: B.ids[i].length })),
  tfjs_b16_vs_direct_b16: cmp(A.b16, B.b16), tfjs_b1_vs_direct_b1: cmp(A.b1, B.b1),
  tfjs_b16_vs_tfjs_b1: cmp(A.b16, A.b1), direct_b16_vs_direct_b1: cmp(B.b16, B.b1),
  truncation_tfjs_vs_reference_on_long: cmp(longIdx.map((i) => B.b16[i]), longIdx.map((i) => B.ref16[i])),
  lastTokenOnLong: longIdx.slice(0, 2).map((i) => ({ tfjs: A.ids[i].at(-1), reference: B.refIds[i].at(-1) })),
};
console.log(JSON.stringify(out, null, 1));
fs.writeFileSync(process.argv[5] ?? "/dev/null", JSON.stringify(out, null, 1));
