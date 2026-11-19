// Mind-map spike v2: check that the scalable algorithms and the shared loader reproduce v1 on the dev set.
// Usage: fnm exec --using=24 -- node docs/spikes/mindmap/v2/verify-v2.mts <v1-vectors.json>
import * as A from "../algorithms.mts";
import { averageLinkageNN, cutMerges, knnSparse, louvainSparse } from "./algorithms-v2.mts";
import { buildReps, loadDev } from "./shared.mts";

const dev = loadDev(process.argv[2]!, process.cwd());
let ok = true;
for (const rep of ["all", "all [det]", "all+title [det]"] as const) {
  const X = A.centre(buildReps(dev, rep));
  const S = A.simMatrix(X);
  const d1 = A.averageLinkage(S);
  const m2 = averageLinkageNN(X);
  for (const t of [0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1.0]) {
    const a = A.cutAt(d1, t);
    const b = cutMerges(X.length, m2, t);
    const same = A.ari(a, b) === 1;
    ok &&= same;
    if (!same) console.log(`hier ${rep} t=${t}: ARI ${A.ari(a, b).toFixed(4)}`);
  }
  for (const k of [4, 6, 8, 10, 15])
    for (const g of [0.5, 1, 1.5, 2, 3]) {
      const a = A.louvain(A.knnGraph(S, k), g);
      const b = louvainSparse(knnSparse(X, k), g);
      const same = a.every((x, i) => x === b[i]);
      ok &&= same;
      if (!same) console.log(`louvain ${rep} k=${k} γ=${g}: ARI ${A.ari(a, b).toFixed(4)}`);
    }
}
// v1 reported B³ F for hier t=0.85 @ all+title [det] = 0.60 and @ all [det] = 0.55 (dev labels).
const labels = dev.map((c) => c.topics);
for (const [rep, expected] of [["all [det]", 0.55], ["all+title [det]", 0.6]] as const) {
  const X = A.centre(buildReps(dev, rep));
  const f = A.bcubed(A.toGrouping(cutMerges(X.length, averageLinkageNN(X), 0.85)), labels).f;
  console.log(`hier t=0.85 @ ${rep}: B³ F ${f.toFixed(2)} (v1: ${expected.toFixed(2)})`);
  ok &&= f.toFixed(2) === expected.toFixed(2);
}
console.log(ok ? "OK: v2 reproduces v1 on the dev set" : "MISMATCH");
