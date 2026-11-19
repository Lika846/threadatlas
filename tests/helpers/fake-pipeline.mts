/**
 * Deterministic fake embedding pipelines for tests (no model). Loaded by Node directly
 * (type stripping), hence `.mts` and `.ts` imports.
 *
 * - `createFakeIndexPipeline`: the M5.1b-1 indexer fake (moved here unchanged from
 *   `fake-index-worker.mts`): 384 dimensions, the real chunker with a 64-token budget
 *   (tokens = whitespace-separated words), batches of 16, vectors seeded by an FNV-1a hash
 *   of the text (independent of the batch). Faults by marker in a text.
 * - `createOrtLikePipeline`: the real `createPipeline` (so the real batching and the real
 *   cancellation check) over a fake tokenizer and a backend that behaves like
 *   onnxruntime-node: each batch runs synchronously inside `setImmediate`, blocking the
 *   event loop for `blockMs`.
 */
import { chunkMessages } from "../../src/lib/semantic/chunker.ts";
import { EmbeddingError } from "../../src/lib/semantic/errors.ts";
import { createPipeline, type EmbeddingPipeline } from "../../src/lib/semantic/pipeline.ts";
import type { EncodedBatch, HiddenStates, InferenceBackend, TextTokenizer } from "../../src/lib/semantic/backend.ts";

export type FakeFaults = {
  poisonMarker?: string;
  /** A text containing it blocks the thread forever in its batch (a native hang). */
  hangMarker?: string;
  invalidMarker?: string;
  crashMarker?: string;
  nanMarker?: string;
};

export type FakeIndexPipelineOptions = FakeFaults & {
  batchDelayMs?: number;
  /** Batches with a text containing it take `slowMs` (default 250) longer (e2e: a run long enough to pause). */
  slowMarker?: string;
  slowMs?: number;
  dimensions?: number;
};

export type FakeHooks = {
  onBatchStart?: () => void;
  onBatchEnd?: (texts: number) => void;
  onRelease?: () => void;
  /** What a `crashMarker` does: the worker throws asynchronously; the child process aborts. */
  onCrash: () => void;
};

const BATCH = 16;
const words = (s: string) => s.split(/\s+/u).filter(Boolean).length;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const has = (texts: readonly string[], marker: string | undefined) => marker !== undefined && texts.some((t) => t.includes(marker));

function fnv(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function vectorOf(text: string, out: Float32Array, at: number, dims: number): void {
  let x = fnv(text) || 1;
  for (let d = 0; d < dims; d++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[at + d] = (x / 0xffffffff) * 2 - 1;
  }
}

export function createFakeIndexPipeline(opts: FakeIndexPipelineOptions, hooks: FakeHooks): EmbeddingPipeline {
  const dims = opts.dimensions ?? 384;
  return {
    dimensions: dims,
    chunk: (messages) => chunkMessages(messages, { countTokens: words, maxTokens: 64, tokenizerKey: "fake-words" }),
    encode: (_kind, text) => [0, ...Array.from(text, (c) => c.charCodeAt(0)), 2],
    async embed(_kind, texts, o = {}) {
      if (has(texts, opts.invalidMarker)) throw new EmbeddingError("INVALID_INPUT");
      const out = new Float32Array(texts.length * dims);
      for (let b = 0; b < texts.length; b += BATCH) {
        if (o.shouldStop?.()) throw new EmbeddingError("CANCELLED");
        hooks.onBatchStart?.();
        const batch = texts.slice(b, b + BATCH);
        if (has(batch, opts.crashMarker)) {
          hooks.onCrash();
          await sleep(1_000);
        }
        if (has(batch, opts.hangMarker)) for (;;) busyWait(1_000);
        if (has(batch, opts.poisonMarker)) throw new Error("synthetic native failure");
        if (opts.batchDelayMs) await sleep(opts.batchDelayMs);
        if (has(batch, opts.slowMarker)) await sleep(opts.slowMs ?? 250);
        batch.forEach((t, i) => vectorOf(t, out, (b + i) * dims, dims));
        if (has(batch, opts.nanMarker)) out[b * dims] = Number.NaN;
        hooks.onBatchEnd?.(batch.length);
      }
      return out;
    },
    async release() {
      hooks.onRelease?.();
    },
  };
}

export type OrtLikeOptions = Pick<FakeFaults, "hangMarker"> & {
  /** Synchronous busy time per batch, like a native ONNX Runtime run. */
  blockMs?: number;
  batchSize?: number;
  dimensions?: number;
  /** A text containing it makes its batch call `onCrash` (a native abort). */
  crashMarker?: string;
  /** Test only: make every `embed` reply carry one vector too few. */
  shortReply?: boolean;
};

function busyWait(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // a native call: nothing else on this thread runs
  }
}

export function createOrtLikePipeline(opts: OrtLikeOptions, hooks: FakeHooks): EmbeddingPipeline {
  const dims = opts.dimensions ?? 384;
  const vocab = new Map<number, string>();
  const tokenizer: TextTokenizer = {
    encodeWithSpecialTokens(text) {
      const ids = text.split(/\s+/u).filter(Boolean).map((w) => {
        const id = 3 + (fnv(w) % 30_000);
        vocab.set(id, w);
        return id;
      });
      return [0, ...ids, 2];
    },
    countTokens: words,
    padId: 1,
    eosId: 2,
  };
  const backend: InferenceBackend = {
    run(batch: EncodedBatch): Promise<HiddenStates> {
      hooks.onBatchStart?.();
      return new Promise((resolve) => {
        // onnxruntime-node: `setImmediate(() => resolve(session.run(...)))`, synchronous inside.
        setImmediate(() => {
          const rows = Array.from({ length: batch.n }, (_, r) => batch.inputIds.subarray(r * batch.length, (r + 1) * batch.length));
          const texts = rows.map((ids) => Array.from(ids, (id) => vocab.get(Number(id)) ?? "").join(" "));
          if (has(texts, opts.crashMarker)) hooks.onCrash();
          if (has(texts, opts.hangMarker)) for (;;) busyWait(1_000);
          busyWait(opts.blockMs ?? 0);
          const data = new Float32Array(batch.n * batch.length * dims);
          for (let r = 0; r < batch.n; r++) {
            for (let t = 0; t < batch.length; t++) {
              vectorOf(`${batch.inputIds[r * batch.length + t]}`, data, (r * batch.length + t) * dims, dims);
            }
          }
          hooks.onBatchEnd?.(batch.n);
          resolve({ data, dims });
        });
      });
    },
    async release() {
      hooks.onRelease?.();
    },
  };
  const p = createPipeline({
    tokenizer,
    backend,
    spec: { dimensions: dims, maxInputTokens: 512, queryPrefix: "query: ", passagePrefix: "passage: ", batchSize: opts.batchSize ?? 16 },
    tokenizerKey: "fake-ort-like",
  });
  if (!opts.shortReply) return p;
  return { ...p, embed: async (kind, texts, o) => (await p.embed(kind, texts, o)).subarray(dims) };
}
