/**
 * Semantic-pipeline error codes.
 *
 * Privacy rule (as for import issues): an `EmbeddingError` carries a code and a
 * static message only. Messages are never built from texts, vectors, file paths,
 * native error messages or stack traces, and the original error is not attached.
 */

export const EMBEDDING_ERRORS = {
  MODEL_MISSING: "The semantic model is not installed. Run `npm run model:fetch` to download it.",
  MODEL_INVALID:
    "The semantic model files do not match the approved manifest. Run `npm run model:fetch` to replace them.",
  MODEL_DIR_INVALID: "The semantic model directory setting must be an absolute path.",
  RUNTIME_UNAVAILABLE: "The local inference runtime (ONNX Runtime) could not be loaded on this system.",
  MODEL_LOAD_FAILED: "The local inference runtime could not load the semantic model.",
  INFERENCE_FAILED: "Embedding failed in the local inference runtime.",
  INVALID_INPUT: "The embedding request was not valid.",
  CANCELLED: "The embedding request was cancelled.",
  CLOSED: "The embedder has been shut down.",
  WORKER_FAILED: "The embedding worker stopped unexpectedly.",
  FETCH_FAILED: "A model file could not be downloaded or copied.",
  FETCH_VERIFY_FAILED: "A downloaded model file did not match the approved size or SHA-256 checksum.",
} as const;

export type EmbeddingErrorCode = keyof typeof EMBEDDING_ERRORS;

export class EmbeddingError extends Error {
  readonly code: EmbeddingErrorCode;

  constructor(code: EmbeddingErrorCode) {
    super(EMBEDDING_ERRORS[code]);
    this.name = "EmbeddingError";
    this.code = code;
  }
}

export function isEmbeddingErrorCode(value: unknown): value is EmbeddingErrorCode {
  return typeof value === "string" && Object.hasOwn(EMBEDDING_ERRORS, value);
}

/** The code of an `EmbeddingError`, or `fallback` for anything else (never its message). */
export function errorCodeOf(err: unknown, fallback: EmbeddingErrorCode): EmbeddingErrorCode {
  return err instanceof EmbeddingError ? err.code : fallback;
}
