// Plain-Node check of how ONNX Runtime 1.23.2 reacts when its worker thread is ended.
// Usage: node kill-mid.mjs <exit|terminate|drain|exit-idle|terminate-idle> <project root> <model dir>
//   exit / terminate:            process.exit() or worker.terminate() while a batch runs
//   exit-idle / terminate-idle:  the same once the worker is idle (session still loaded)
//   drain:                       cancel flag + shutdown message, wait for the worker to exit
import { Worker } from "node:worker_threads";
const [mode, root, modelDir] = process.argv.slice(2);
const idle = mode.endsWith("-idle");
const w = new Worker(new URL(`file://${root}/src/lib/semantic/worker.ts`), { workerData: { modelDir, verifyHashes: false } });
w.on("error", (e) => console.log("worker-error", e?.code ?? "unknown"));
w.on("exit", (c) => console.log("worker-exit", c));
await new Promise((r) => w.once("message", (m) => { console.log("first", m.type); r(); }));
const texts = Array.from({ length: idle ? 20 : 4000 }, (_, i) => `Synthetic passage ${i} about gardening, budgets and travel plans in Oslo.`);
const cancel = new Int32Array(new SharedArrayBuffer(4));
w.postMessage({ type: "embed", id: 1, kind: "passage", texts, cancel });
w.on("message", (m) => console.log("msg", m.type));
if (idle) await new Promise((r) => w.once("message", r));
await new Promise((r) => setTimeout(r, idle ? 300 : 700));
const t = performance.now();
if (mode.startsWith("exit")) process.exit(143);
if (mode.startsWith("terminate")) { await w.terminate(); console.log("terminated in", Math.round(performance.now() - t), "ms"); process.exit(0); }
if (mode === "drain") {
  Atomics.store(cancel, 0, 1);
  w.postMessage({ type: "shutdown" });
  w.once("exit", () => { console.log("drained in", Math.round(performance.now() - t), "ms"); process.exit(143); });
}
