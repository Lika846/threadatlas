/**
 * Approved embedding model (ADR 0002, D122): multilingual-e5-small, int8 ONNX export
 * from `Xenova/multilingual-e5-small` at a pinned revision (MIT, from
 * `intfloat/multilingual-e5-small`). Sizes and SHA-256 values were verified in M5.0
 * Experiment 1 against the Hugging Face metadata for this revision.
 *
 * Changing anything here changes `EMBEDDING_VERSION`, which (from M5.1b) invalidates
 * every stored vector. Only change it with an approved decision.
 *
 * This file is loaded by Node directly in the inference worker and by
 * `scripts/model-fetch.ts`, so it uses only erasable TypeScript syntax and relative
 * `.ts` imports.
 */

export type ModelFile = {
  /** Path relative to the model directory and to the repository root on the hub. */
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
};

export type ModelManifest = {
  readonly id: string;
  readonly revision: string;
  readonly license: string;
  readonly files: readonly ModelFile[];
};

export const E5_SMALL_MANIFEST: ModelManifest = {
  id: "Xenova/multilingual-e5-small",
  revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
  license: "MIT",
  files: [
    { path: "config.json", size: 658, sha256: "cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1" },
    { path: "tokenizer_config.json", size: 443, sha256: "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b" },
    { path: "tokenizer.json", size: 17_082_730, sha256: "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39" },
    {
      path: "onnx/model_quantized.onnx",
      size: 118_308_185,
      sha256: "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193",
    },
  ],
};

/** How the approved model is used. Part of `EMBEDDING_VERSION`. */
export const E5_SMALL_SPEC = {
  modelFile: "onnx/model_quantized.onnx",
  tokenizerFile: "tokenizer.json",
  tokenizerConfigFile: "tokenizer_config.json",
  dimensions: 384,
  /** Model input limit, including `<s>` and `</s>`. */
  maxInputTokens: 512,
  queryPrefix: "query: ",
  passagePrefix: "passage: ",
  /** Texts per inference call (M5.0 Experiment 2). */
  batchSize: 16,
} as const;

/**
 * Chunks per embedding call when indexing (M5.1b, design §5.4). Batches are formed per
 * call (sorted by length), so the window rule affects the int8 model's outputs and is
 * part of `EMBEDDING_VERSION`. Windows are taken in chunk order within each page.
 */
export const INDEX_WINDOW_CHUNKS = 256;

/**
 * Identifies everything that determines a vector: model and revision, model file,
 * prefixes, truncation, pooling, normalisation, batching and the indexing window.
 * Stored with each vector from M5.1b; a change means the index must be rebuilt.
 */
export const EMBEDDING_VERSION = [
  `${E5_SMALL_MANIFEST.id}@${E5_SMALL_MANIFEST.revision.slice(0, 8)}`,
  "onnx-q8",
  "prefix-e5",
  "trunc512-keep-eos",
  "mean-l2",
  `batch${E5_SMALL_SPEC.batchSize}-sorted-window${INDEX_WINDOW_CHUNKS}`,
].join("/");

/** Default model directory, relative to the project root (`data/` is git-ignored). */
export const DEFAULT_MODEL_DIR = "data/models/multilingual-e5-small";
