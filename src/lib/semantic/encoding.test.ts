import { describe, expect, it } from "vitest";
import { buildBatch, poolAndNormalise, truncateIds } from "./encoding";

describe("truncateIds", () => {
  it("leaves inputs within the limit unchanged", () => {
    expect(truncateIds([0, 5, 6, 2], 4, 2)).toEqual([0, 5, 6, 2]);
  });

  it("keeps the first max - 1 ids and ends with </s> (reference behaviour)", () => {
    expect(truncateIds([0, 5, 6, 7, 8, 2], 4, 2)).toEqual([0, 5, 6, 2]);
  });
});

describe("buildBatch", () => {
  it("right-pads with the pad id and masks the padding", () => {
    const b = buildBatch([[0, 9, 2], [0, 2]], 1);
    expect(b.n).toBe(2);
    expect(b.length).toBe(3);
    expect(Array.from(b.inputIds, Number)).toEqual([0, 9, 2, 0, 2, 1]);
    expect(Array.from(b.attentionMask, Number)).toEqual([1, 1, 1, 1, 1, 0]);
  });
});

describe("poolAndNormalise", () => {
  it("averages the unmasked token vectors and L2-normalises", () => {
    const batch = buildBatch([[0, 9], [0]], 1); // row 1 has one real token and one pad
    // n=2, length=2, dims=2
    const hidden = { dims: 2, data: Float32Array.from([1, 0, 3, 4, /* row 1 */ 0, 2, 100, 100]) };
    const out = poolAndNormalise(batch, hidden);
    // row 0: mean (2, 2) → (√½, √½); row 1: (0, 2) only, padding ignored → (0, 1)
    expect(out[0]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(out[1]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(out[2]).toBe(0);
    expect(out[3]).toBe(1);
  });

  it("returns zeros for a zero vector and rejects a shape mismatch", () => {
    const batch = buildBatch([[0]], 1);
    expect(Array.from(poolAndNormalise(batch, { dims: 2, data: new Float32Array(2) }))).toEqual([0, 0]);
    expect(() => poolAndNormalise(batch, { dims: 3, data: new Float32Array(2) })).toThrow(RangeError);
  });
});
