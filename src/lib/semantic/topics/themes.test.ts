import { describe, expect, it } from "vitest";
import { averageLinkage, cutTree } from "./hierarchy";
import { buildHierarchy, chooseThemeCut, THEME_CUT } from "./themes";

/**
 * Themes of topics on an orthogonal basis, so the distances are known: conversations in a topic
 * are 0.06 apart, topics of one theme about 0.91, different themes 1.0. With more than
 * `THEME_CUT.maxThemes` topics, the theme cut must join topics within their themes.
 */
function archive(themes: number, topicsPerTheme: number, perTopic: number, loners = 0) {
  const dims = themes + themes * topicsPerTheme * (1 + perTopic) + loners;
  let next = 0;
  const basis = () => {
    const v = new Float64Array(dims);
    v[next++] = 1;
    return v;
  };
  const unit = (v: Float64Array) => v.map((x) => x / Math.hypot(...v));
  const add = (a: Float64Array, b: Float64Array, k: number) => a.map((x, i) => x + k * b[i]!);
  const vectors: Float64Array[] = [];
  const truth: { theme: number; topic: number }[] = [];
  for (let th = 0; th < themes; th++) {
    const e = basis();
    for (let tp = 0; tp < topicsPerTheme; tp++) {
      const topic = unit(add(basis(), e, 1 / 3));
      for (let k = 0; k < perTopic; k++) {
        vectors.push(unit(add(topic, basis(), 0.25)));
        truth.push({ theme: th, topic: th * topicsPerTheme + tp });
      }
    }
  }
  for (let i = 0; i < loners; i++) vectors.push(basis());
  return { vectors, truth };
}

describe("buildHierarchy", () => {
  it("finds themes and the topics inside them, and every topic lies inside one theme", () => {
    const { vectors, truth } = archive(6, 4, 4);
    const h = buildHierarchy(vectors);
    expect(h.themes).toHaveLength(6);
    expect(h.themes.flatMap((t) => t.topics)).toHaveLength(24);
    for (const t of h.themes) {
      expect(new Set(t.members.map((i) => truth[i]!.theme)).size).toBe(1);
      for (const topic of t.topics) {
        expect(new Set(topic.map((i) => truth[i]!.topic)).size).toBe(1);
        expect(topic.every((i) => t.members.includes(i))).toBe(true);
      }
    }
    expect(h.themeCut!).toBeGreaterThanOrEqual(h.topicCut!);
  });

  it("orders themes and topics largest first, members most typical first", () => {
    const { vectors } = archive(6, 4, 3);
    const h = buildHierarchy([...vectors, ...vectors.slice(0, 6)]); // the first theme's first topics twice: bigger
    expect(h.themes[0]!.members.length).toBeGreaterThan(h.themes[1]!.members.length);
    const sizes = h.themes.map((t) => t.members.length);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    for (const t of h.themes) {
      const ts = t.topics.map((m) => m.length);
      expect(ts).toEqual([...ts].sort((a, b) => b - a));
    }
  });

  it("keeps conversations close to no other under other, and loose ones inside their theme", () => {
    const { vectors } = archive(6, 4, 3, 2);
    const h = buildHierarchy(vectors);
    expect(h.other).toEqual([72, 73]);
    expect(h.themes.flatMap((t) => t.members)).not.toContain(72);
    expect(h.themes.every((t) => t.loose.length === 0)).toBe(true);
    // One conversation of its own inside a theme's direction is loose in that theme, not other.
    const near = new Float64Array(vectors[0]!.length);
    near[0] = 1; // the first theme's own axis: about 0.69 from its conversations
    const h2 = buildHierarchy([...vectors.slice(0, 72), near]);
    const home = h2.themes.find((t) => t.members.includes(0))!;
    expect(home.loose).toEqual([72]);
  });

  it("degenerate inputs: nothing, one conversation, identical conversations", () => {
    expect(buildHierarchy([])).toEqual({ topicCut: null, themeCut: null, themes: [], other: [] });
    expect(buildHierarchy([Float64Array.of(1, 0)])).toEqual({ topicCut: null, themeCut: null, themes: [], other: [0] });
    const zero = new Float64Array(4);
    expect(buildHierarchy([zero, zero, zero])).toEqual({ topicCut: null, themeCut: null, themes: [], other: [0, 1, 2] });
  });

  it("is independent of input order, apart from indices", () => {
    const { vectors } = archive(6, 4, 3);
    const order = vectors.map((_, i) => i).reverse();
    const a = buildHierarchy(vectors);
    const b = buildHierarchy(order.map((i) => vectors[i]!));
    const sets = (h: ReturnType<typeof buildHierarchy>, map: (i: number) => number) => h.themes.map((t) => t.members.map(map).sort((x, y) => x - y).join(",")).sort();
    expect(sets(b, (i) => order[i]!)).toEqual(sets(a, (i) => i));
  });
});

describe("chooseThemeCut", () => {
  it("never leaves more than the maximum number of themes, and stays at or above the topic cut", () => {
    const { vectors } = archive(20, 2, 3);
    const merges = averageLinkage(vectors);
    const t = chooseThemeCut(vectors.length, merges, 0.7);
    expect(t).toBeGreaterThanOrEqual(0.8);
    const groups = new Map<number, number>();
    for (const a of cutTree(vectors.length, merges, t)) groups.set(a, (groups.get(a) ?? 0) + 1);
    expect([...groups.values()].filter((s) => s >= 2).length).toBeLessThanOrEqual(THEME_CUT.maxThemes);
  });

  it("is the topic cut itself when the topics are already few enough", () => {
    const { vectors } = archive(2, 2, 4);
    const merges = averageLinkage(vectors);
    expect(chooseThemeCut(vectors.length, merges, 0.83)).toBe(0.83);
  });
});
