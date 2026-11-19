// Indexing speed and memory by batching strategy on the long corpus (whole messages, 256- and 64-token sentence chunks).
// Usage: node sortbatch.mjs <rt> <modelDir> <union.json> <strategy: b1|b16|sorted16> <rep: message|sent256|sent64>
import fs from "node:fs";
import { createDirectEmbedder } from "./direct.mjs";
import { makeChunker } from "../proto/chunker.mjs";
const [rt, modelDir, unionFile, strategy, rep] = process.argv.slice(2);
const e = await createDirectEmbedder({ rt, modelDir });
const convs = JSON.parse(fs.readFileSync(unionFile, "utf8")).conversations;
const chunk = rep === "message" ? null : makeChunker(e.tokenizer, Number(rep.slice(4)));
let texts = convs.flatMap((c) => c.messages.flatMap((m) => (chunk ? chunk(m).map((s) => m.slice(s.start, s.end)) : [m]))).map((t) => "passage: " + t);
const lens = texts.map((t) => e.encode(t).length);
if (strategy === "sorted16") texts = texts.map((t, i) => [t, lens[i]]).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
await e.embedBatched(texts.slice(0, 16), strategy === "b1" ? 1 : 16);
const t0 = performance.now();
await e.embedBatched(texts, strategy === "b1" ? 1 : 16);
const ms = performance.now() - t0;
const tok = lens.reduce((a, b) => a + b, 0);
console.log(JSON.stringify({ rep, strategy, units: texts.length, tokens: tok, seconds: +(ms / 1000).toFixed(1), unitsPerSec: +(texts.length / (ms / 1000)).toFixed(1), tokensPerSec: Math.round(tok / (ms / 1000)), peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024) }));
await e.release();
