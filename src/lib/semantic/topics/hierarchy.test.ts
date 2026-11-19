import { describe, expect, it } from "vitest";
import { averageLinkage, chooseTopicCut, cutTree, singletonShare, TOPIC_CUT, type Merge } from "./hierarchy";

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const unit = (v: number[]) => {
  const n = Math.hypot(...v);
  return Float64Array.from(v, (x) => x / n);
};
/** Unit vectors around a few random centres, so the tree has structure. */
function points(n: number, seed: number, dims = 8, centres = 4): Float64Array[] {
  const r = rng(seed);
  const cs = Array.from({ length: centres }, () => Array.from({ length: dims }, () => r() * 2 - 1));
  return Array.from({ length: n }, (_, i) => unit(cs[i % centres]!.map((x) => x + (r() - 0.5) * 0.8)));
}
const dot = (a: Float64Array, b: Float64Array) => a.reduce((s, x, i) => s + x * b[i]!, 0);

/** Textbook O(n³) average linkage: heights of the merges, in merge order. */
function naiveHeights(vs: readonly Float64Array[]): { heights: number[]; partitionAt: (t: number) => string } {
  let clusters = vs.map((_, i) => [i]);
  const d = (a: number[], b: number[]) => a.reduce((s, i) => s + b.reduce((s2, j) => s2 + (1 - dot(vs[i]!, vs[j]!)), 0), 0) / (a.length * b.length);
  const steps: { height: number; clusters: number[][] }[] = [];
  while (clusters.length > 1) {
    let best = [0, 1, Infinity] as [number, number, number];
    for (let i = 0; i < clusters.length; i++) for (let j = i + 1; j < clusters.length; j++) {
      const x = d(clusters[i]!, clusters[j]!);
      if (x < best[2]) best = [i, j, x];
    }
    const [i, j, h] = best;
    clusters = [...clusters.filter((_, k) => k !== i && k !== j), [...clusters[i]!, ...clusters[j]!]];
    steps.push({ height: h, clusters });
  }
  return {
    heights: steps.map((s) => s.height),
    partitionAt: (t) => canonical(steps.filter((s) => s.height <= t).at(-1)?.clusters ?? vs.map((_, i) => [i])),
  };
}
const canonical = (clusters: number[][]) => JSON.stringify(clusters.map((c) => [...c].sort((a, b) => a - b)).sort((a, b) => a[0]! - b[0]!));
const partition = (assignment: readonly number[]) => {
  const m = new Map<number, number[]>();
  assignment.forEach((a, i) => m.set(a, [...(m.get(a) ?? []), i]));
  return canonical([...m.values()]);
};

describe("averageLinkage (nearest-neighbour chain)", () => {
  it.each([1, 2, 3, 4, 5])("matches the textbook method on random inputs (seed %i)", (seed) => {
    const vs = points(24, seed);
    const merges = averageLinkage(vs);
    expect(merges).toHaveLength(23);
    const naive = naiveHeights(vs);
    const ours = merges.map((m) => m.height).sort((a, b) => a - b);
    const theirs = [...naive.heights].sort((a, b) => a - b);
    ours.forEach((h, i) => expect(h).toBeCloseTo(theirs[i]!, 5));
    // Same partition between every pair of consecutive heights.
    for (let i = 0; i + 1 < theirs.length; i++) {
      if (theirs[i + 1]! - theirs[i]! < 1e-4) continue;
      const t = (theirs[i]! + theirs[i + 1]!) / 2;
      expect(partition(cutTree(vs.length, merges, t))).toBe(naive.partitionAt(t));
    }
  });

  it("gives the same groups whatever the input order", () => {
    const vs = points(40, 9);
    const r = rng(42);
    const perm = vs.map((_, i) => i).sort(() => r() - 0.5);
    const a = cutTree(vs.length, averageLinkage(vs), 0.3);
    const bShuffled = cutTree(vs.length, averageLinkage(perm.map((i) => vs[i]!)), 0.3);
    const b = new Array<number>(vs.length);
    perm.forEach((orig, k) => (b[orig] = bShuffled[k]!));
    expect(partition(b)).toBe(partition(a));
  });

  it("handles tiny inputs", () => {
    expect(averageLinkage([])).toEqual([]);
    expect(averageLinkage([unit([1, 0])])).toEqual([]);
    const [m] = averageLinkage([unit([1, 0]), unit([0, 1])]);
    expect(m!.height).toBeCloseTo(1, 6);
  });

  it("identical vectors merge at height 0 without looping", () => {
    const v = unit([1, 2, 3]);
    const merges = averageLinkage([v, v, v, unit([3, 2, 1])]);
    expect(merges).toHaveLength(3);
    expect(partition(cutTree(4, merges, 0.01))).toBe(canonical([[0, 1, 2], [3]]));
  });
});

describe("cutTree and singletonShare", () => {
  it("numbers clusters by first appearance; no merges → everyone alone", () => {
    expect(cutTree(0, [], 0.5)).toEqual([]);
    expect(cutTree(3, [], 0.5)).toEqual([0, 1, 2]);
    expect(cutTree(4, [{ a: 3, b: 1, height: 0.2 }], 0.5)).toEqual([0, 1, 2, 1]);
    expect(singletonShare([0, 1, 2, 1])).toBe(0.5);
    expect(singletonShare([])).toBe(0);
  });
});

describe("chooseTopicCut", () => {
  /** n = 10: four pairs joined at 0.5; items 8 and 9 join others only at `late`. */
  const merges = (late: number): Merge[] => [
    { a: 0, b: 1, height: 0.5 },
    { a: 2, b: 3, height: 0.5 },
    { a: 4, b: 5, height: 0.5 },
    { a: 6, b: 7, height: 0.5 },
    { a: 8, b: 0, height: late },
    { a: 9, b: 2, height: late },
    { a: 0, b: 2, height: 1.1 },
    { a: 4, b: 6, height: 1.1 },
    { a: 0, b: 4, height: 1.2 },
  ];

  it("takes the smallest t that leaves at most 15% alone", () => {
    expect(chooseTopicCut(10, merges(0.78))).toBe(0.78); // 20% alone below 0.78
  });

  it("is clamped to [0.65, 0.85]", () => {
    expect(chooseTopicCut(10, merges(0.3))).toBe(TOPIC_CUT.min);
    expect(chooseTopicCut(10, merges(0.95))).toBe(TOPIC_CUT.max);
  });

  it("everyone alone (one conversation) → the upper bound", () => {
    expect(chooseTopicCut(1, [])).toBe(TOPIC_CUT.max);
  });
});
