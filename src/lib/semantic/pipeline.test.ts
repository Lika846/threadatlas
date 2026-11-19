import { describe, expect, it } from "vitest";
import type { EncodedBatch, InferenceBackend, TextTokenizer } from "./backend";
import { EmbeddingError } from "./errors";
import { E5_SMALL_MANIFEST, E5_SMALL_SPEC } from "./model-manifest";
import { createPipeline, tokenizerKeyOf } from "./pipeline";

// Fake tokenizer: <s>=0, </s>=2, <pad>=1; every word is one token with id 100 + its length.
const tokenizer: TextTokenizer = {
  padId: 1,
  eosId: 2,
  encodeWithSpecialTokens: (t) => [0, ...t.split(/\s+/u).filter(Boolean).map((w) => 100 + w.length), 2],
  countTokens: (t) => t.split(/\s+/u).filter(Boolean).length,
};

const DIMS = 4;

/** Fake backend: token vector = [id, position, 1, 0]; records every batch. */
function fakeBackend(onRun?: (b: EncodedBatch) => void): InferenceBackend & { batches: EncodedBatch[]; released: boolean } {
  const self = {
    batches: [] as EncodedBatch[],
    released: false,
    async run(b: EncodedBatch) {
      self.batches.push(b);
      onRun?.(b);
      const data = new Float32Array(b.n * b.length * DIMS);
      for (let i = 0; i < b.n * b.length; i++) {
        data[i * DIMS] = Number(b.inputIds[i]);
        data[i * DIMS + 1] = i % b.length;
        data[i * DIMS + 2] = 1;
      }
      return { data, dims: DIMS };
    },
    async release() {
      self.released = true;
    },
  };
  return self;
}

const spec = { ...E5_SMALL_SPEC, dimensions: DIMS, batchSize: 2, maxInputTokens: 6 };

describe("embedding pipeline", () => {
  it("adds the query and passage prefixes and truncates keeping </s>", () => {
    const p = createPipeline({ tokenizer, backend: fakeBackend(), spec, tokenizerKey: "k" });
    expect(p.encode("query", "ab")).toEqual([0, 106, 102, 2]); // "query:" + "ab"
    expect(p.encode("passage", "ab")).toEqual([0, 108, 102, 2]); // "passage:" + "ab"
    expect(p.encode("passage", "a b c d e f g")).toEqual([0, 108, 101, 101, 101, 2]);
  });

  it("batches by token length (ties by position) and returns vectors in input order", async () => {
    const backend = fakeBackend();
    const p = createPipeline({ tokenizer, backend, spec, tokenizerKey: "k" });
    const texts = ["a b c", "a", "a b", "x"];
    const out = await p.embed("passage", texts);
    // Lengths with specials: 6, 4, 5, 4 → order 1, 3, 2, 0 → batches [1,3], [2,0].
    expect(backend.batches.map((b) => [b.n, b.length])).toEqual([
      [2, 4],
      [2, 6],
    ]);
    expect(out.length).toBe(texts.length * DIMS);
    for (let i = 0; i < texts.length; i++) {
      const v = out.subarray(i * DIMS, (i + 1) * DIMS);
      expect(Math.hypot(...v)).toBeCloseTo(1, 6);
    }
    // Same input → bit-identical output.
    const again = await createPipeline({ tokenizer, backend: fakeBackend(), spec, tokenizerKey: "k" }).embed("passage", texts);
    expect(Buffer.from(again.buffer).equals(Buffer.from(out.buffer))).toBe(true);
  });

  it("checks shouldStop before every batch and never interrupts a started batch", async () => {
    let stop = false;
    const backend = fakeBackend(() => {
      if (backend.batches.length === 2) stop = true; // requested during the second batch
    });
    const p = createPipeline({ tokenizer, backend, spec, tokenizerKey: "k" });
    await expect(p.embed("passage", ["a", "b", "c", "d", "e", "f"], { shouldStop: () => stop })).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(backend.batches.length).toBe(2);
  });

  it("does not start at all when already stopped", async () => {
    const backend = fakeBackend();
    const p = createPipeline({ tokenizer, backend, spec, tokenizerKey: "k" });
    await expect(p.embed("query", ["a"], { shouldStop: () => true })).rejects.toBeInstanceOf(EmbeddingError);
    expect(backend.batches.length).toBe(0);
  });

  it("rejects a bad batch size and a backend with the wrong dimensions", async () => {
    const p = createPipeline({ tokenizer, backend: fakeBackend(), spec, tokenizerKey: "k" });
    await expect(p.embed("passage", ["a"], { batchSize: 0 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const wrong = createPipeline({ tokenizer, backend: fakeBackend(), spec: { ...spec, dimensions: 8 }, tokenizerKey: "k" });
    await expect(wrong.embed("passage", ["a"])).rejects.toMatchObject({ code: "INFERENCE_FAILED" });
  });

  it("returns an empty result for no texts and releases the backend", async () => {
    const backend = fakeBackend();
    const p = createPipeline({ tokenizer, backend, spec, tokenizerKey: "k" });
    expect((await p.embed("passage", [])).length).toBe(0);
    await p.release();
    expect(backend.released).toBe(true);
  });

  it("chunks with the tokenizer's counts and key", () => {
    const p = createPipeline({ tokenizer, backend: fakeBackend(), spec, tokenizerKey: "k", chunkTokens: 3 });
    const chunks = p.chunk([{ sourceNodeId: "n1", text: "a b. c d e f." }]);
    expect(chunks.map((c) => c.text)).toEqual(["a b.", "c d e", "f."]);
  });

  it("keys chunk ids to the approved tokenizer file", () => {
    expect(tokenizerKeyOf(E5_SMALL_MANIFEST)).toBe("Xenova/multilingual-e5-small/0b44a9d7b51c3c62");
  });
});
