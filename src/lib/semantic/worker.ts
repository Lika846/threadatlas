/**
 * Inference worker entry (started by `embedder.ts`). Owns the tokenizer and the ONNX
 * Runtime session; never touches the database and never logs.
 *
 * Node loads this file directly (type stripping), outside any bundler, so this file
 * and everything it imports use erasable TypeScript syntax and relative `.ts` imports.
 */
import { parentPort, workerData } from "node:worker_threads";
import { loadE5Pipeline } from "./pipeline.ts";
import type { WorkerInit } from "./protocol.ts";
import { serveWorker } from "./worker-core.ts";

if (!parentPort) throw new Error("worker.ts must run in a worker thread");
const init = workerData as WorkerInit;
serveWorker(parentPort, () => loadE5Pipeline(init.modelDir, { verifyHashes: init.verifyHashes }));
