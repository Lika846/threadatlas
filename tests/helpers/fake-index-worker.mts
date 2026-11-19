/**
 * Test-only worker entry for the semantic indexer (M5.1b-1): the real worker message
 * loop (`worker-core.ts`) serving a deterministic fake pipeline with the production
 * shape (384 dimensions, the real chunker with a 64-token budget, batches of 16), so
 * the indexer runs through a real worker thread without the model. Loaded by Node
 * directly (type stripping), hence `.mts` and `.ts` imports. The pipeline itself is in
 * `fake-pipeline.mts` (shared with the child-process fake).
 *
 * - Vectors: a pseudo-random unit-scale vector seeded by an FNV-1a hash of the text,
 *   independent of the batch (bit-identical on every run and in every process).
 * - Tokens: whitespace-separated words.
 * - Faults, by marker in a text: `poisonMarker` → INFERENCE_FAILED, `invalidMarker` →
 *   INVALID_INPUT, `crashMarker` → the worker dies (WORKER_FAILED), `nanMarker` → a NaN.
 *
 * Shared log (Int32Array on a SharedArrayBuffer, optional):
 *   [0] batches started  [1] batches finished  [2] texts embedded  [3] released (1)
 */
import { parentPort, workerData } from "node:worker_threads";
import { serveWorker } from "../../src/lib/semantic/worker-core.ts";
import { createFakeIndexPipeline, type FakeIndexPipelineOptions } from "./fake-pipeline.mts";

export type FakeIndexWorkerData = FakeIndexPipelineOptions & { log?: Int32Array };

const opts = workerData as FakeIndexWorkerData;
const log = opts.log;

const pipeline = createFakeIndexPipeline(opts, {
  onBatchStart: () => {
    if (log) Atomics.add(log, 0, 1);
  },
  onBatchEnd: (texts) => {
    if (log) {
      Atomics.add(log, 2, texts);
      Atomics.add(log, 1, 1);
    }
  },
  onRelease: () => {
    if (log) Atomics.store(log, 3, 1);
  },
  // An uncaught error ends the worker thread (WORKER_FAILED in the client).
  onCrash: () =>
    setImmediate(() => {
      throw new Error("synthetic worker crash");
    }),
});

serveWorker(parentPort!, async () => pipeline);
