import { describe, expect, it } from "vitest";
import { EVIDENCE_MIN, evidencePassage, nearestConversations, RELATED_FLOOR, RELATED_LIMIT } from "./similarity";

const unit = (...v: number[]) => {
  const n = Math.hypot(...v);
  return Float64Array.from(v, (x) => x / n);
};
/** A unit vector at similarity `s` to (1, 0, …) in the plane of axis `axis`. */
const at = (s: number, axis: number, dims = 12) => {
  const v = new Float64Array(dims);
  v[0] = s;
  v[axis] = Math.sqrt(1 - s * s);
  return v;
};

describe("nearestConversations", () => {
  it("keeps only similarity ≥ the floor, most similar first, never the conversation itself", () => {
    const vs = [at(1, 1), at(0.5, 2), at(0.34, 3), at(0.9, 4), at(RELATED_FLOOR, 5)];
    expect(nearestConversations(vs, 0).map((x) => x.index)).toEqual([3, 1, 4]);
    expect(nearestConversations(vs, 0)[0]!.similarity).toBeCloseTo(0.9, 9);
  });

  it(`returns at most ${RELATED_LIMIT}, with ties in input order`, () => {
    const vs = [at(1, 1), ...Array.from({ length: 8 }, (_, i) => at(0.6, 2 + i))];
    expect(nearestConversations(vs, 0).map((x) => x.index)).toEqual([1, 2, 3, 4, 5]);
  });

  it("no forced matches: nothing close → nothing", () => {
    expect(nearestConversations([at(1, 1), at(0.1, 2), at(-0.5, 3)], 0)).toEqual([]);
    expect(nearestConversations([at(1, 1)], 0)).toEqual([]);
  });
});

describe("evidencePassage", () => {
  const own = unit(1, 1, 0, 0);
  const other = unit(1, 0, 1, 0);
  it("picks the passage closest to both averages (the smaller of the two similarities)", () => {
    const chunks = [unit(0, 1, 0, 0), unit(1, 0, 0, 0), unit(0, 0, 1, 0)]; // own-only, both, other-only
    expect(evidencePassage(chunks, own, other)?.index).toBe(1);
  });

  it("skips excluded passages (boilerplate) and takes the next one", () => {
    const chunks = [unit(1, 0.1, 0.1, 0), unit(1, 0.3, 0.3, 0.5)];
    expect(evidencePassage(chunks, own, other)?.index).toBe(0);
    expect(evidencePassage(chunks, own, other, (i) => i === 0)?.index).toBe(1);
  });

  it(`returns null when no remaining passage reaches ${EVIDENCE_MIN}, or every passage is excluded`, () => {
    expect(evidencePassage([unit(0, 0, 0, 1)], own, other)).toBeNull();
    expect(evidencePassage([unit(1, 0, 0, 0)], own, other, () => true)).toBeNull();
    expect(evidencePassage([], own, other)).toBeNull();
  });
});
