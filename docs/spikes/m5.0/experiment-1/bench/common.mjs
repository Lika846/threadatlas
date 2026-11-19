// M5.0 experiment 1 — shared setup (research only; scratch directory, not committed).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const EXP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RT = path.join(EXP, "rt", "node_modules");
export const MODELS = path.join(EXP, "models") + path.sep;
export const MODEL_ID = "Xenova/multilingual-e5-small";
export const DATASET = process.env.M5_DATASET; // committed synthetic set (read-only)

/** Loads Transformers.js from the scratch runtime with remote loading disabled. */
export async function loadTransformers() {
  const t0 = performance.now();
  const tf = await import(pathToFileURL(path.join(RT, "@huggingface/transformers/dist/transformers.node.mjs")).href);
  const importMs = performance.now() - t0;
  tf.env.allowRemoteModels = false;
  tf.env.allowLocalModels = true;
  tf.env.localModelPath = MODELS;
  tf.env.useFSCache = false;
  tf.env.useBrowserCache = false;
  tf.env.cacheDir = path.join(EXP, "cache-unused");
  return { tf, importMs };
}

export async function loadModel(tf) {
  const t0 = performance.now();
  const extractor = await tf.pipeline("feature-extraction", MODEL_ID, { dtype: "q8", device: "cpu" });
  const loadMs = performance.now() - t0;
  const tokenizer = extractor.tokenizer;
  return { extractor, tokenizer, loadMs };
}

/** Embeds texts in batches; returns Float32Array rows (mean pooled, L2 normalised). */
export async function embed(extractor, texts, batch = 16) {
  const out = [];
  for (let i = 0; i < texts.length; i += batch) {
    const t = await extractor(texts.slice(i, i + batch), { pooling: "mean", normalize: true });
    const [n, d] = t.dims;
    for (let r = 0; r < n; r++) out.push(Float32Array.from(t.data.subarray(r * d, (r + 1) * d)));
  }
  return out;
}

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function readDataset() {
  return JSON.parse(fs.readFileSync(DATASET, "utf8"));
}

export function ortVersionLoaded() {
  return JSON.parse(fs.readFileSync(path.join(RT, "onnxruntime-node/package.json"), "utf8")).version;
}

export const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
};

export function report(name, obj) {
  const file = path.join(EXP, "results", `${name}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 1));
}

export function peakRssMb() {
  return process.resourceUsage().maxRSS / 1024; // maxRSS is in kilobytes
}
