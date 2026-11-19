/**
 * `InferenceBackend` on `onnxruntime-node` 1.23.2, CPU execution provider (ADR 0002).
 *
 * Load this only inside the inference worker: ONNX Runtime on the main thread blocks
 * the server and aborts the process on an uncaught exception or `process.exit()`
 * (M5.0 Experiment 2). The runtime is imported lazily so that a missing or
 * incompatible native binary becomes `RUNTIME_UNAVAILABLE` instead of a crash at
 * import time.
 */
import type { EncodedBatch, HiddenStates, InferenceBackend } from "./backend.ts";
import { EmbeddingError } from "./errors.ts";

/** The subset of the `onnxruntime-node` API this backend uses. */
export type OrtModule = {
  InferenceSession: {
    create(path: string, options: { executionProviders: string[] }): Promise<OrtSession>;
  };
  Tensor: new (type: "int64", data: BigInt64Array, dims: number[]) => unknown;
};

type OrtTensor = { data: unknown; dims: readonly number[]; dispose?: () => void };

type OrtSession = {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor | undefined>>;
  release(): Promise<void>;
};

export type OrtImporter = () => Promise<unknown>;

const defaultImporter: OrtImporter = () => import("onnxruntime-node");

function asOrtModule(mod: unknown): OrtModule | null {
  const candidates = [mod, (mod as { default?: unknown } | null)?.default];
  for (const c of candidates) {
    const m = c as Partial<OrtModule> | null | undefined;
    if (m && typeof m.InferenceSession?.create === "function" && typeof m.Tensor === "function") return m as OrtModule;
  }
  return null;
}

export async function createOrtBackend(modelFile: string, importer: OrtImporter = defaultImporter): Promise<InferenceBackend> {
  let ort: OrtModule | null;
  try {
    ort = asOrtModule(await importer());
  } catch {
    throw new EmbeddingError("RUNTIME_UNAVAILABLE");
  }
  if (!ort) throw new EmbeddingError("RUNTIME_UNAVAILABLE");

  let session: OrtSession;
  try {
    session = await ort.InferenceSession.create(modelFile, { executionProviders: ["cpu"] });
  } catch {
    throw new EmbeddingError("MODEL_LOAD_FAILED");
  }
  const needsTokenTypes = session.inputNames.includes("token_type_ids");
  if (!session.inputNames.includes("input_ids") || !session.inputNames.includes("attention_mask") || !session.outputNames.includes("last_hidden_state")) {
    await session.release().catch(() => {});
    throw new EmbeddingError("MODEL_LOAD_FAILED");
  }
  const Tensor = ort.Tensor;
  let released = false;

  return {
    async run(batch: EncodedBatch): Promise<HiddenStates> {
      if (released) throw new EmbeddingError("CLOSED");
      const shape = [batch.n, batch.length];
      const feeds: Record<string, unknown> = {
        input_ids: new Tensor("int64", batch.inputIds, shape),
        attention_mask: new Tensor("int64", batch.attentionMask, shape),
      };
      if (needsTokenTypes) feeds.token_type_ids = new Tensor("int64", new BigInt64Array(batch.n * batch.length), shape);
      let out: Record<string, OrtTensor | undefined>;
      try {
        out = await session.run(feeds);
      } catch {
        throw new EmbeddingError("INFERENCE_FAILED");
      }
      const h = out.last_hidden_state;
      const dims = h?.dims;
      if (!h || !(h.data instanceof Float32Array) || dims?.length !== 3 || dims[0] !== batch.n || dims[1] !== batch.length) {
        throw new EmbeddingError("INFERENCE_FAILED");
      }
      const data = new Float32Array(h.data); // copy before releasing the native buffer
      h.dispose?.();
      return { data, dims: dims[2]! };
    },
    async release() {
      if (released) return;
      released = true;
      await session.release();
    },
  };
}
