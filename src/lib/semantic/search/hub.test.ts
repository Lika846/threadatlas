import { describe, expect, it } from "vitest";
import { quantizeInt8 } from "../quantize";
import type { ConceptVector } from "../topics/concept-names";
import { HUB_WEIGHT, hubPenalties } from "./hub";
import { pack, topConversations } from "./vector-cache";

const DIMS = 4;
const unit = (...xs: number[]) => {
  const n = Math.hypot(...xs);
  return Float32Array.from(xs, (x) => x / n);
};
const row = (conversationId: string, v: Float32Array, i = 0) => ({ conversationId, sourceNodeId: `n${i}`, start: 0, end: 10, tokenCount: 20, vector: quantizeInt8(v) });

/** General subjects all leaning towards dimension 3: a passage near it matches "everything". */
const vocabulary: ConceptVector[] = Array.from({ length: 12 }, (_, i) => ({ name: `s${i}`, broad: false, vector: unit(0.1 * (i % 3), 0.1 * ((i + 1) % 3), 0, 1) }));

describe("hubPenalties", () => {
  it("is larger for a passage close to subjects in general, and weighted", () => {
    const cache = pack("k", DIMS, [row("generic", unit(0, 0, 0.4, 1)), row("specific", unit(1, 0, 0.4, 0))]);
    const [generic, specific] = hubPenalties(cache, vocabulary);
    expect(generic!).toBeGreaterThan(specific!);
    expect(generic!).toBeLessThanOrEqual(HUB_WEIGHT + 1e-6);
  });

  it("is zero without a vocabulary, or for other dimensions (no correction rather than a wrong one)", () => {
    const cache = pack("k", DIMS, [row("a", unit(0, 0, 0, 1))]);
    expect([...hubPenalties(cache, null)]).toEqual([0]);
    expect([...hubPenalties(cache, [{ name: "x", broad: true, vector: unit(1, 0, 0, 0, 0) }])]).toEqual([0]);
  });


});

describe("topConversations with the hub correction", () => {
  it("ranks a specific passage above a generic one that scores higher before the correction", () => {
    const query = unit(0.5, 0, 0, 0.866);
    const generic = unit(0.3, 0, 0, 1); // close to the query, and to every general subject
    const specific = unit(1, 0, 0, 0.3); // less close to the query, but to nothing else
    const cache = pack("k", DIMS, [row("generic", generic), row("specific", specific)]);
    const raw = (v: Float32Array) => v.reduce((s, x, i) => s + x * query[i]!, 0);
    expect(raw(generic)).toBeGreaterThan(raw(specific)); // the old order
    cache.hub.penalties = hubPenalties(cache, vocabulary);
    expect(topConversations(cache, query, 2).map((h) => h.conversationId)).toEqual(["generic", "specific"]); // off unless asked
    expect(topConversations(cache, query, 2, { correctGeneric: true }).map((h) => h.conversationId)).toEqual(["specific", "generic"]);
  });

  it("computes the penalties once per cache, on first corrected use", () => {
    const cache = pack("k", DIMS, [row("a", unit(1, 0, 0, 0))]);
    topConversations(cache, unit(1, 0, 0, 0), 1);
    expect(cache.hub.penalties).toBeNull();
    topConversations(cache, unit(1, 0, 0, 0), 1, { correctGeneric: true });
    const first = cache.hub.penalties;
    expect(first).not.toBeNull();
    topConversations(cache, unit(1, 0, 0, 0), 1, { correctGeneric: true });
    expect(cache.hub.penalties).toBe(first);
  });
});
