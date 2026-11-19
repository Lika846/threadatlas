// Direct side: same texts, both truncation modes, batch 16 and batch 1.
import fs from "node:fs";
import { createDirectEmbedder } from "./direct.mjs";
const [rt, modelDir, textsFile, outFile] = process.argv.slice(2);
const texts = JSON.parse(fs.readFileSync(textsFile, "utf8"));
const e = await createDirectEmbedder({ rt, modelDir, truncation: "tfjs" });
const r = await createDirectEmbedder({ rt, modelDir, truncation: "reference" });
const arr = (vs) => vs.map((v) => Array.from(v));
fs.writeFileSync(outFile, JSON.stringify({
  ids: texts.map((t) => e.encode(t)),
  b16: arr(await e.embedBatched(texts, 16)), b1: arr(await e.embedBatched(texts, 1)),
  refIds: texts.map((t) => r.encode(t)), ref16: arr(await r.embedBatched(texts, 16)),
}));
await e.release(); await r.release();
console.log("direct done", globalThis.__tripwireAttempts?.());
