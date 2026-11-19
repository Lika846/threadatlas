// Transformers.js 3.8.1 side: token ids and embeddings at batch 16 and batch 1.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [rt, models, textsFile, outFile] = process.argv.slice(2);
const tf = await import(pathToFileURL(path.join(rt, "@huggingface/transformers/dist/transformers.node.mjs")).href);
Object.assign(tf.env, { allowRemoteModels: false, allowLocalModels: true, localModelPath: models + "/", useFSCache: false, useBrowserCache: false });
const ex = await tf.pipeline("feature-extraction", "Xenova/multilingual-e5-small", { dtype: "q8", device: "cpu" });
const texts = JSON.parse(fs.readFileSync(textsFile, "utf8"));
const ids = texts.map((t) => Array.from(ex.tokenizer(t, { truncation: true }).input_ids.data, Number));
async function run(batch) {
  const out = [];
  for (let i = 0; i < texts.length; i += batch) {
    const r = await ex(texts.slice(i, i + batch), { pooling: "mean", normalize: true });
    const [n, d] = r.dims;
    for (let k = 0; k < n; k++) out.push(Array.from(r.data.subarray(k * d, (k + 1) * d)));
  }
  return out;
}
fs.writeFileSync(outFile, JSON.stringify({ ids, b16: await run(16), b1: await run(1) }));
console.log("tfjs done", globalThis.__tripwireAttempts?.());
