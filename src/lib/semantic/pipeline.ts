/**
 * The embedding pipeline: chunking, prefixes, tokenisation, truncation, batching,
 * inference, pooling and normalisation. Independent of the runtime through
 * `TextTokenizer` and `InferenceBackend`; runs inside the inference worker.
 *
 * **Batching (reproducibility):** the texts of one call are ordered by token length
 * (ties by input position) and embedded in batches of `batchSize`. Vectors depend
 * slightly on batch composition (M5.0 Experiment 2: median cosine 0.997 between batch
 * sizes 1 and 16), so the same list of texts always gives bit-identical vectors, and a
 * caller that embeds one conversation per call gets vectors independent of every other
 * conversation.
 *
 * **Cancellation:** `shouldStop` is checked before every batch, after one event-loop turn
 * (so a cancel message that arrived during the previous batch has been read). A batch
 * that has started always finishes; the call then fails with `CANCELLED` and returns
 * nothing.
 */
import type { InferenceBackend, TextTokenizer } from "./backend.ts";
import { chunkMessages, type Chunk, type MessageInput } from "./chunker.ts";
import { buildBatch, poolAndNormalise, truncateIds } from "./encoding.ts";
import { EmbeddingError } from "./errors.ts";
import { verifyModelDir, modelFilePath } from "./model-files.ts";
import { E5_SMALL_MANIFEST, E5_SMALL_SPEC, type ModelManifest } from "./model-manifest.ts";
import { createOrtBackend } from "./ort-backend.ts";
import { loadHfTokenizer } from "./tokenizer.ts";

export type TextKind = "query" | "passage";

export type PipelineSpec = {
  readonly dimensions: number;
  readonly maxInputTokens: number;
  readonly queryPrefix: string;
  readonly passagePrefix: string;
  readonly batchSize: number;
};

export type EmbedOptions = {
  readonly shouldStop?: () => boolean;
  readonly batchSize?: number;
};

export type EmbeddingPipeline = {
  readonly dimensions: number;
  chunk(messages: readonly MessageInput[]): Chunk[];
  /** Model input ids for a text: prefix, `<s> … </s>`, truncation. */
  encode(kind: TextKind, text: string): number[];
  /** `texts.length × dimensions` floats, row-major, in input order. */
  embed(kind: TextKind, texts: readonly string[], opts?: EmbedOptions): Promise<Float32Array>;
  release(): Promise<void>;
};

export function createPipeline(parts: {
  tokenizer: TextTokenizer;
  backend: InferenceBackend;
  spec: PipelineSpec;
  tokenizerKey: string;
  chunkTokens?: number;
}): EmbeddingPipeline {
  const { tokenizer, backend, spec } = parts;
  const encode = (kind: TextKind, text: string) =>
    truncateIds(
      tokenizer.encodeWithSpecialTokens((kind === "query" ? spec.queryPrefix : spec.passagePrefix) + text),
      spec.maxInputTokens,
      tokenizer.eosId,
    );

  return {
    dimensions: spec.dimensions,
    chunk: (messages) =>
      chunkMessages(messages, {
        countTokens: tokenizer.countTokens,
        maxTokens: parts.chunkTokens,
        tokenizerKey: parts.tokenizerKey,
      }),
    encode,
    async embed(kind, texts, opts = {}) {
      const batchSize = opts.batchSize ?? spec.batchSize;
      if (!Number.isInteger(batchSize) || batchSize < 1) throw new EmbeddingError("INVALID_INPUT");
      const d = spec.dimensions;
      const ids = texts.map((t) => encode(kind, t));
      const order = ids.map((_, i) => i).sort((a, b) => ids[a]!.length - ids[b]!.length || a - b);
      const out = new Float32Array(texts.length * d);
      for (let b = 0; b < order.length; b += batchSize) {
        if (opts.shouldStop) {
          // ONNX Runtime runs a batch synchronously (inside setImmediate), blocking this
          // thread's event loop. A cancel sent over IPC (M5.1b-2 child process) is only
          // read once the loop turns, so yield once before checking: otherwise the check
          // would run before the message is read and one more batch would start.
          await yieldToEventLoop();
          if (opts.shouldStop()) throw new EmbeddingError("CANCELLED");
        }
        const rows = order.slice(b, b + batchSize);
        const batch = buildBatch(
          rows.map((i) => ids[i]!),
          tokenizer.padId,
        );
        const hidden = await backend.run(batch);
        if (hidden.dims !== d) throw new EmbeddingError("INFERENCE_FAILED");
        const pooled = poolAndNormalise(batch, hidden);
        rows.forEach((i, r) => out.set(pooled.subarray(r * d, (r + 1) * d), i * d));
      }
      return out;
    },
    release: () => backend.release(),
  };
}

/** Resolves in the check phase of the next event-loop turn, after pending I/O (IPC messages) was read. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** The tokenizer's identity for chunk ids: the approved `tokenizer.json` hash. */
export function tokenizerKeyOf(manifest: ModelManifest): string {
  const f = manifest.files.find((x) => x.path === E5_SMALL_SPEC.tokenizerFile);
  if (!f) throw new EmbeddingError("MODEL_INVALID");
  return `${manifest.id}/${f.sha256.slice(0, 16)}`;
}

/**
 * Loads the approved pipeline from a local directory: verifies every file against the
 * manifest (sizes, then SHA-256), loads the tokenizer, then ONNX Runtime. Never
 * downloads anything.
 */
export async function loadE5Pipeline(modelDir: string, opts: { verifyHashes?: boolean } = {}): Promise<EmbeddingPipeline> {
  const manifest = E5_SMALL_MANIFEST;
  await verifyModelDir(modelDir, manifest, { hash: opts.verifyHashes !== false });
  const tokenizer = await loadHfTokenizer(modelDir, E5_SMALL_SPEC);
  const modelFile = modelFilePath(modelDir, E5_SMALL_SPEC.modelFile);
  const backend = await createOrtBackend(modelFile);
  return createPipeline({ tokenizer, backend, spec: E5_SMALL_SPEC, tokenizerKey: tokenizerKeyOf(manifest) });
}
