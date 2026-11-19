// One shutdown case per process. Usage: node exit-case.mjs <case> <rt> <modelDir> <tfjsRt> <modelsRoot>
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { createDirectEmbedder } from "../bench/direct.mjs";
const [kase, rt, modelDir, tfjsRt, modelsRoot] = process.argv.slice(2);
if (kase.startsWith("tfjs")) {
  const tf = await import(pathToFileURL(path.join(tfjsRt, "@huggingface/transformers/dist/transformers.node.mjs")).href);
  Object.assign(tf.env, { allowRemoteModels: false, localModelPath: modelsRoot + "/", useFSCache: false });
  const ex = await tf.pipeline("feature-extraction", "Xenova/multilingual-e5-small", { dtype: "q8", device: "cpu" });
  await ex(["passage: test"], { pooling: "mean", normalize: true });
  if (kase === "tfjs-throw") throw new Error("deliberate");
  if (kase === "tfjs-dispose-throw") { await ex.dispose(); throw new Error("deliberate"); }
  // tfjs-normal: fall through
} else if (kase.startsWith("worker")) {
  const w = new Worker(new URL("./infer-worker.mjs", import.meta.url), { workerData: { rt, modelDir } });
  await new Promise((r) => w.once("message", r));
  await new Promise((r) => { w.once("message", r); w.postMessage({ type: "index", id: 1, messages: [{ sourceNodeId: "n1", text: "A short test sentence." }] }); });
  if (kase === "worker-throw") throw new Error("deliberate");
  if (kase === "worker-exit-inflight") { w.postMessage({ type: "index", id: 2, messages: Array.from({ length: 40 }, (_, i) => ({ sourceNodeId: "n" + i, text: "Some words in a sentence. ".repeat(40) })) }); setTimeout(() => process.exit(1), 300); await new Promise((r) => setTimeout(r, 10000)); }
  if (kase === "worker-kill-inflight") { w.postMessage({ type: "index", id: 2, messages: Array.from({ length: 40 }, (_, i) => ({ sourceNodeId: "n" + i, text: "Some words in a sentence. ".repeat(40) })) }); setTimeout(() => w.terminate(), 300); await new Promise((r) => setTimeout(r, 1500)); }
  if (kase === "worker-terminate-throw") { await w.terminate(); throw new Error("deliberate"); }
  if (kase === "worker-shutdown-throw") { await new Promise((r) => { w.once("message", r); w.postMessage({ type: "shutdown" }); }); await w.terminate(); throw new Error("deliberate"); }
  await w.terminate();
} else {
  const e = await createDirectEmbedder({ rt, modelDir });
  await e.embedBatched(["passage: test"], 1);
  if (kase === "direct-throw") throw new Error("deliberate");
  if (kase === "direct-reject") { Promise.reject(new Error("deliberate")); await new Promise((r) => setTimeout(r, 50)); }
  if (kase === "direct-release-throw") { await e.release(); throw new Error("deliberate"); }
  if (kase === "direct-exit-inflight") { e.embedBatched(Array(64).fill("passage: " + "word ".repeat(200)), 16); setTimeout(() => process.exit(1), 30); await new Promise((r) => setTimeout(r, 5000)); }
  if (kase === "direct-exitcode") { process.exitCode = 1; }
  // direct-normal: fall through, no release
}
