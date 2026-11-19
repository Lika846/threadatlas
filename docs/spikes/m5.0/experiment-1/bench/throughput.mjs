// Indexing throughput: embeds N synthetic chunks of ~T tokens (windows over the synthetic set's text).
// Usage: node --import ./tripwire.mjs throughput.mjs <N> <batch> <tokens>
import { embed, loadModel, loadTransformers, peakRssMb, readDataset, report } from "./common.mjs";

const [N, BATCH, TOKENS] = process.argv.slice(2).map(Number);
const { tf, importMs } = await loadTransformers();
const { extractor, tokenizer, loadMs } = await loadModel(tf);
const rssAfterLoad = process.memoryUsage().rss / 1048576;

const data = readDataset();
const ids = tokenizer.encode(data.conversations.flatMap((c) => c.messages).join("\n"), { add_special_tokens: false });
const chunks = [];
for (let i = 0; chunks.length < N; i++) {
  const start = (i * 37) % (ids.length - TOKENS);
  chunks.push("passage: " + tokenizer.decode(ids.slice(start, start + TOKENS), { skip_special_tokens: true }));
}
const lens = chunks.map((c) => tokenizer.encode(c).length);
await embed(extractor, chunks.slice(0, Math.min(BATCH, N)), BATCH); // warm-up batch
const t0 = performance.now();
const vecs = await embed(extractor, chunks, BATCH);
const ms = performance.now() - t0;
const tokensTotal = lens.reduce((a, b) => a + b, 0);
const out = {
  n: N, batch: BATCH, tokensTarget: TOKENS, tokensMean: +(tokensTotal / N).toFixed(1), dims: vecs[0].length,
  importMs: +importMs.toFixed(0), loadMs: +loadMs.toFixed(0), embedMs: +ms.toFixed(0),
  chunksPerSec: +(N / (ms / 1000)).toFixed(1), tokensPerSec: +(tokensTotal / (ms / 1000)).toFixed(0),
  rssAfterLoadMb: +rssAfterLoad.toFixed(0), peakRssMb: +peakRssMb().toFixed(0),
  vectorBytesFloat32: N * vecs[0].length * 4,
  tripwireAttempts: globalThis.__tripwireAttempts?.() ?? null,
};
report(`throughput-${N}-b${BATCH}-t${TOKENS}`, out);
console.log(JSON.stringify(out));
