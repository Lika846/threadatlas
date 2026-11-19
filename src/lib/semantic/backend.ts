/**
 * The two seams that keep the pipeline independent of a particular runtime: a
 * tokenizer and an inference backend. ONNX Runtime and `@huggingface/tokenizers` are
 * the approved implementations (ADR 0002); another backend (for example llama.cpp)
 * only has to implement these interfaces.
 */

export interface TextTokenizer {
  /** Token ids for `text` with the model's special tokens (`<s> … </s>`), untruncated. */
  encodeWithSpecialTokens(text: string): number[];
  /** Number of tokens in `text` without special tokens (used for chunk budgets). */
  countTokens(text: string): number;
  readonly padId: number;
  readonly eosId: number;
}

/** A right-padded batch: `n` rows of `length` ids, row-major. */
export type EncodedBatch = {
  readonly n: number;
  readonly length: number;
  readonly inputIds: BigInt64Array;
  readonly attentionMask: BigInt64Array;
};

/** Token-level output: `n × length × dims` floats, row-major. */
export type HiddenStates = {
  readonly data: Float32Array;
  readonly dims: number;
};

export interface InferenceBackend {
  run(batch: EncodedBatch): Promise<HiddenStates>;
  release(): Promise<void>;
}
