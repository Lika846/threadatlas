/** Provisional topic groups for the mind map: clustering, names, grouping (synthetic vectors). */
import { describe, expect, it } from "vitest";
import { cluster, groupConversations, topicCount, topicWords, type TopicConversation } from "./topics";

const unit = (...v: number[]) => {
  const n = Math.hypot(...v);
  return Float64Array.from(v, (x) => x / n);
};
/** Points scattered around a direction, deterministically. */
const around = (dir: number[], n: number, spread = 0.1) =>
  Array.from({ length: n }, (_, i) => unit(...dir.map((x, d) => x + spread * Math.sin(i * 7 + d * 3))));

describe("topicCount", () => {
  it.each([
    [0, 0],
    [1, 1],
    [2, 1],
    [3, 2],
    [11, 3],
    [34, 6],
    [100, 10],
    [5_000, 12],
  ])("%i conversations → %i groups", (n, k) => expect(topicCount(n)).toBe(k));
});

describe("cluster (spherical k-means)", () => {
  const a = around([1, 0, 0, 0], 6);
  const b = around([0, 1, 0, 0], 5);
  const c = around([0, 0, 1, 0], 4);
  const all = [...a, ...b, ...c];

  it("separates well-separated groups", () => {
    const { assignment } = cluster(all, 3);
    const groupsOf = (from: number, n: number) => new Set(assignment.slice(from, from + n));
    expect(groupsOf(0, 6).size).toBe(1);
    expect(groupsOf(6, 5).size).toBe(1);
    expect(groupsOf(11, 4).size).toBe(1);
    expect(new Set(assignment).size).toBe(3);
  });

  it("is deterministic", () => {
    expect(cluster(all, 3).assignment).toEqual(cluster(all, 3).assignment);
  });

  it("never asks for more groups than vectors, and handles identical vectors", () => {
    expect(new Set(cluster(all.slice(0, 2), 5).assignment).size).toBeLessThanOrEqual(2);
    const same = [unit(1, 0), unit(1, 0), unit(1, 0)];
    expect(cluster(same, 3).assignment).toHaveLength(3);
    expect(cluster([], 3)).toEqual({ assignment: [], centroids: [] });
  });
});

describe("topicWords", () => {
  it("picks words frequent in a group's titles and rare in the others'", () => {
    const words = topicWords([
      ["Python KeyError debugging", "Python import error", "Debugging a Python script", "SQL join question"],
      ["Dinner idea with chickpeas", "Quick dinner recipe", "Recipe for bread"],
    ]);
    expect(words[0]).toContain("python");
    expect(words[0]).toContain("debugging");
    expect(words[1]![0]).toMatch(/dinner|recipe/);
  });

  it("skips stop words, numbers and words in only one title of a larger group", () => {
    const words = topicWords([["How to write a cover letter", "What is the best tax app", "Write an email to 2024 landlord", "Explain photosynthesis"]]);
    expect(words[0]).toEqual([]);
  });
});

describe("groupConversations", () => {
  const conv = (id: string, title: string | null, updatedAtSec: number | null = null): TopicConversation => ({ id, title, updatedAtSec });

  it("groups indexed conversations, keeps the rest apart, largest group first, newest first inside", () => {
    const conversations = [
      conv("a1", "Garden tomatoes", 10),
      conv("a2", "Garden roses", 30),
      conv("a3", "Garden soil", 20),
      conv("b1", "Python error", 5),
      conv("b2", "Python loops", 6),
      conv("x", "Not indexed yet", 99),
    ];
    const vectors = new Map([
      ["a1", unit(1, 0.05, 0)],
      ["a2", unit(1, 0, 0.05)],
      ["a3", unit(1, 0.02, 0.02)],
      ["b1", unit(0, 1, 0.05)],
      ["b2", unit(0.05, 1, 0)],
    ]);
    const r = groupConversations(conversations, vectors);
    expect(r.ungrouped.map((c) => c.id)).toEqual(["x"]);
    expect(r.topics.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(r.topics[0]!.conversations.map((c) => c.id)).toEqual(["a2", "a3", "a1"]);
    expect(r.topics[0]!.words).toContain("garden");
    expect(r.topics[0]!.label).toContain("garden");
    expect(r.topics[1]!.conversations.map((c) => c.id)).toEqual(["b2", "b1"]);
  });

  it("names a group of four or more after its most typical title when no word is shared", () => {
    // 16 conversations → 4 groups; four clear directions of four each; every title a different word.
    const titles = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta", "Iota", "Kappa", "Lambda", "Omicron", "Sigma", "Upsilon", "Omega", "Rho"];
    const dirs = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
    const conversations = titles.map((t, i) => conv(`c${i}`, t));
    const vectors = new Map(titles.map((_, i) => [`c${i}`, unit(...dirs[i >> 2]!.map((x, d) => x + 0.03 * ((i + d) % 3)))] as const));
    const r = groupConversations(conversations, vectors);
    expect(r.topics).toHaveLength(4);
    for (const t of r.topics) {
      expect(t.conversations).toHaveLength(4);
      expect(t.words).toEqual([]);
      expect(titles.map((x) => `“${x}”`)).toContain(t.label);
    }
  });

  it("names a small group from its titles' words", () => {
    const r = groupConversations([conv("a", "Alpha"), conv("b", "Beta")], new Map([["a", unit(1, 0)], ["b", unit(1, 0.01)]]));
    expect(r.topics[0]!.label).toBe("alpha · beta");
  });

  it("with nothing indexed, everything is ungrouped", () => {
    expect(groupConversations([conv("a", "A")], new Map())).toEqual({ topics: [], ungrouped: [conv("a", "A")] });
  });
});
