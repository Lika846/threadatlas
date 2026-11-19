/**
 * Test-only worker entry: the real worker message loop (`worker-core.ts`) serving a fake
 * pipeline, so the embedder's threading, cancellation and shutdown can be tested without
 * the model. Loaded by Node directly (type stripping), hence `.mts` and `.ts` imports.
 *
 * Shared log (Int32Array on a SharedArrayBuffer):
 *   [0] batches started  [1] batches finished  [2] released (1)  [3] batches active at release
 *   [4] max concurrent batches
 */
import { workerData, parentPort } from "node:worker_threads";
import { chunkMessages } from "../../src/lib/semantic/chunker.ts";
import { EmbeddingError } from "../../src/lib/semantic/errors.ts";
import type { EmbeddingPipeline } from "../../src/lib/semantic/pipeline.ts";
import { serveWorker } from "../../src/lib/semantic/worker-core.ts";

type Mode = "ok" | "init-fail" | "crash" | "infer-fail";
const { mode, batchDelayMs, log } = workerData as { mode: Mode; batchDelayMs: number; log: Int32Array };
const DIMS = 3;
const BATCH = 2;
const words = (s: string) => s.split(/\s+/u).filter(Boolean).length;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const pipeline: EmbeddingPipeline = {
  dimensions: DIMS,
  chunk: (messages) => chunkMessages(messages, { countTokens: words, maxTokens: 4, tokenizerKey: "fake" }),
  encode: (_kind, text) => [0, ...text.split("").map((c) => c.charCodeAt(0)), 2],
  async embed(kind, texts, opts = {}) {
    const out = new Float32Array(texts.length * DIMS);
    for (let b = 0; b < texts.length; b += BATCH) {
      if (opts.shouldStop?.()) throw new EmbeddingError("CANCELLED");
      const active = Atomics.add(log, 0, 1) + 1 - Atomics.load(log, 1);
      if (active > Atomics.load(log, 4)) Atomics.store(log, 4, active);
      if (mode === "crash") {
        setImmediate(() => {
          throw new Error("secret text /private/path");
        });
        await sleep(1_000);
      }
      if (mode === "infer-fail") throw new Error("native failure mentioning user text");
      await sleep(batchDelayMs);
      for (let i = b; i < Math.min(texts.length, b + BATCH); i++) {
        out.set([texts[i]!.length, kind === "query" ? 1 : 0, i], i * DIMS);
      }
      Atomics.add(log, 1, 1);
    }
    return out;
  },
  async release() {
    Atomics.store(log, 3, Atomics.load(log, 0) - Atomics.load(log, 1));
    Atomics.store(log, 2, 1);
  },
};

serveWorker(parentPort!, async () => {
  if (mode === "init-fail") throw new EmbeddingError("MODEL_INVALID");
  return pipeline;
});
