import { describe, expect, it } from "vitest";
import { buildBatch } from "./encoding";
import { EmbeddingError } from "./errors";
import { createOrtBackend } from "./ort-backend";

// Fake ONNX Runtime modules only: the real runtime is never loaded on the test's main thread.
const SECRET = "/Users/someone/private/path: dlopen failed";

class FakeTensor {
  constructor(
    readonly type: string,
    readonly data: BigInt64Array,
    readonly dims: number[],
  ) {}
}

function fakeOrt(opts: { inputs?: string[]; run?: (feeds: Record<string, FakeTensor>) => unknown; create?: () => never } = {}) {
  const calls: { feeds: Record<string, FakeTensor>[]; released: number } = { feeds: [], released: 0 };
  const session = {
    inputNames: opts.inputs ?? ["input_ids", "attention_mask", "token_type_ids"],
    outputNames: ["last_hidden_state"],
    async run(feeds: Record<string, FakeTensor>) {
      calls.feeds.push(feeds);
      if (opts.run) return opts.run(feeds);
      const [n, len] = feeds.input_ids!.dims as [number, number];
      return { last_hidden_state: { data: new Float32Array(n * len * 3).fill(1), dims: [n, len, 3] } };
    },
    async release() {
      calls.released++;
    },
  };
  const mod = {
    InferenceSession: {
      async create() {
        if (opts.create) opts.create();
        return session;
      },
    },
    Tensor: FakeTensor,
  };
  return { mod, calls };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (err) {
    expect(err).toBeInstanceOf(EmbeddingError);
    expect((err as Error).message).not.toContain("dlopen");
    expect((err as Error).message).not.toContain("/Users/");
    return (err as EmbeddingError).code;
  }
}

describe("createOrtBackend", () => {
  it("maps a runtime that cannot be loaded to RUNTIME_UNAVAILABLE without its message", async () => {
    const importer = async () => {
      throw new Error(SECRET);
    };
    expect(await codeOf(createOrtBackend("/m/model.onnx", importer))).toBe("RUNTIME_UNAVAILABLE");
    expect(await codeOf(createOrtBackend("/m/model.onnx", async () => ({ nothing: true })))).toBe("RUNTIME_UNAVAILABLE");
  });

  it("maps a model the runtime rejects to MODEL_LOAD_FAILED", async () => {
    const { mod } = fakeOrt({
      create: () => {
        throw new Error(SECRET);
      },
    });
    expect(await codeOf(createOrtBackend("/m/model.onnx", async () => mod))).toBe("MODEL_LOAD_FAILED");
  });

  it("rejects a model without the expected inputs and releases its session", async () => {
    const { mod, calls } = fakeOrt({ inputs: ["pixel_values"] });
    expect(await codeOf(createOrtBackend("/m/model.onnx", async () => mod))).toBe("MODEL_LOAD_FAILED");
    expect(calls.released).toBe(1);
  });

  it("feeds int64 ids, mask and zero token types, accepting a default-export module", async () => {
    const { mod, calls } = fakeOrt();
    const backend = await createOrtBackend("/m/model.onnx", async () => ({ default: mod }));
    const out = await backend.run(buildBatch([[0, 5, 2], [0, 2]], 1));
    expect(out.dims).toBe(3);
    expect(out.data.length).toBe(2 * 3 * 3);
    const feeds = calls.feeds[0]!;
    expect(Object.keys(feeds).sort()).toEqual(["attention_mask", "input_ids", "token_type_ids"]);
    expect(feeds.input_ids!.type).toBe("int64");
    expect(feeds.input_ids!.dims).toEqual([2, 3]);
    expect(Array.from(feeds.attention_mask!.data, Number)).toEqual([1, 1, 1, 1, 1, 0]);
    expect(Array.from(feeds.token_type_ids!.data, Number)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("omits token_type_ids for models without that input", async () => {
    const { mod, calls } = fakeOrt({ inputs: ["input_ids", "attention_mask"] });
    const backend = await createOrtBackend("/m/model.onnx", async () => mod);
    await backend.run(buildBatch([[0, 2]], 1));
    expect(Object.keys(calls.feeds[0]!).sort()).toEqual(["attention_mask", "input_ids"]);
  });

  it("maps inference failures and malformed outputs to INFERENCE_FAILED", async () => {
    const throwing = fakeOrt({
      run: () => {
        throw new Error(SECRET);
      },
    });
    const b1 = await createOrtBackend("/m", async () => throwing.mod);
    expect(await codeOf(b1.run(buildBatch([[0, 2]], 1)))).toBe("INFERENCE_FAILED");

    const wrongShape = fakeOrt({ run: () => ({ last_hidden_state: { data: new Float32Array(3), dims: [1, 1, 3] } }) });
    const b2 = await createOrtBackend("/m", async () => wrongShape.mod);
    expect(await codeOf(b2.run(buildBatch([[0, 2]], 1)))).toBe("INFERENCE_FAILED");
  });

  it("releases once and refuses to run afterwards", async () => {
    const { mod, calls } = fakeOrt();
    const backend = await createOrtBackend("/m", async () => mod);
    await backend.release();
    await backend.release();
    expect(calls.released).toBe(1);
    expect(await codeOf(backend.run(buildBatch([[0, 2]], 1)))).toBe("CLOSED");
  });
});
