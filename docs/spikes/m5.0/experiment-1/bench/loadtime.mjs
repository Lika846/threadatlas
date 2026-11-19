// Model load time in a fresh process: module import, pipeline creation, first (cold) query embedding.
import { embed, loadModel, loadTransformers, peakRssMb } from "./common.mjs";

const { tf, importMs } = await loadTransformers();
const { extractor, loadMs } = await loadModel(tf);
const rssAfterLoadMb = process.memoryUsage().rss / 1048576;
let t = performance.now();
await embed(extractor, ["query: first query after start"], 1);
const firstQueryMs = performance.now() - t;
t = performance.now();
await embed(extractor, ["query: second query"], 1);
const secondQueryMs = performance.now() - t;
console.log(JSON.stringify({
  importMs: +importMs.toFixed(0), loadMs: +loadMs.toFixed(0), firstQueryMs: +firstQueryMs.toFixed(1), secondQueryMs: +secondQueryMs.toFixed(1),
  rssAfterLoadMb: +rssAfterLoadMb.toFixed(0), peakRssMb: +peakRssMb().toFixed(0), tripwireAttempts: globalThis.__tripwireAttempts(),
}));
