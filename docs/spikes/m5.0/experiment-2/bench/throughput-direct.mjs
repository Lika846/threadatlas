// Same workload as experiment 1's throughput.mjs, with the direct embedder.
// Usage: node --import ./tripwire.mjs throughput-direct.mjs <rt> <modelDir> <dataset> <N> <batch> <tokens>
import fs from "node:fs";
import { createDirectEmbedder } from "./direct.mjs";
const [rt, modelDir, dataset, N, BATCH, TOKENS] = [...process.argv.slice(2, 5), ...process.argv.slice(5).map(Number)];
const e = await createDirectEmbedder({ rt, modelDir });
const rssAfterLoad = process.memoryUsage().rss / 1048576;
const data = JSON.parse(fs.readFileSync(dataset, "utf8"));
const ids = e.tokenizer.encode(data.conversations.flatMap((c) => c.messages).join("\n"), { add_special_tokens: false }).ids;
const chunks = [];
for (let i = 0; chunks.length < N; i++) {
  const start = (i * 37) % (ids.length - TOKENS);
  chunks.push("passage: " + e.tokenizer.decode(ids.slice(start, start + TOKENS), { skip_special_tokens: true }));
}
const lens = chunks.map((c) => e.tokenCount(c));
await e.embedBatched(chunks.slice(0, Math.min(BATCH, N)), BATCH);
const t0 = performance.now();
const v = await e.embedBatched(chunks, BATCH);
const ms = performance.now() - t0;
const tok = lens.reduce((a, b) => a + b, 0);
console.log(JSON.stringify({ runtime: "direct", n: N, batch: BATCH, tokensMean: +(tok / N).toFixed(1), importMs: +e.importMs.toFixed(0), loadMs: +e.loadMs.toFixed(0), embedMs: +ms.toFixed(0), chunksPerSec: +(N / (ms / 1000)).toFixed(1), tokensPerSec: +(tok / (ms / 1000)).toFixed(0), rssAfterLoadMb: +rssAfterLoad.toFixed(0), peakRssMb: +(process.resourceUsage().maxRSS / 1024).toFixed(0), dims: v[0].length, tripwire: globalThis.__tripwireAttempts() }));
await e.release();
