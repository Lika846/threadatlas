import { describe, expect, it } from "vitest";
import { EMBEDDING_VERSION } from "../model-manifest";
import { conceptsHash, conceptVectors, nameThemes, type ConceptVector } from "./concept-names";
import { CONCEPT_VECTORS } from "./concept-vectors.generated";
import { CONCEPTS, CONCEPTS_VERSION } from "./concepts";

const v = (...xs: number[]) => Float32Array.from(xs);
const vocabulary: ConceptVector[] = [
  { name: "Food and cooking", broad: true, vector: v(1, 0, 0) },
  { name: "Programming and software", broad: true, vector: v(0, 1, 0) },
  { name: "Music", broad: true, vector: v(0, 0, 1) },
  { name: "Bread and baking", broad: false, vector: v(0.99, 0.1, 0) },
];

describe("nameThemes", () => {
  it("gives each theme its nearest broad name", () => {
    expect(nameThemes([Float64Array.of(0.9, 0.1, 0), Float64Array.of(0.1, 0.9, 0)], vocabulary)).toEqual(["Food and cooking", "Programming and software"]);
  });

  it("uses each name once: the theme it fits best gets it, the other takes its next nearest", () => {
    expect(nameThemes([Float64Array.of(0.7, 0, 0.3), Float64Array.of(0.95, 0, 0.05)], vocabulary)).toEqual(["Music", "Food and cooking"]);
  });

  it("never uses topic-level names for themes, and has no names without a vocabulary", () => {
    expect(nameThemes([Float64Array.of(0.99, 0.1, 0)], vocabulary)).toEqual(["Food and cooking"]);
    expect(nameThemes([Float64Array.of(1, 0, 0)], null)).toEqual([null]);
  });
});

describe("the precomputed vectors", () => {
  it("match the vocabulary and the model this code embeds with (regenerate with npm run concepts:embed)", () => {
    expect(CONCEPT_VECTORS.conceptsVersion).toBe(CONCEPTS_VERSION);
    expect(CONCEPT_VECTORS.embeddingVersion).toBe(EMBEDDING_VERSION);
    expect(CONCEPT_VECTORS.namesHash).toBe(conceptsHash(CONCEPTS));
    const vs = conceptVectors();
    expect(vs).not.toBeNull();
    expect(vs).toHaveLength(CONCEPTS.length);
    for (const c of vs!) expect(Math.hypot(...c.vector)).toBeCloseTo(1, 1);
  });

  it("are not used for another vocabulary or model: no names rather than wrong ones", () => {
    expect(conceptVectors({ ...CONCEPT_VECTORS, embeddingVersion: "another-model" })).toBeNull();
    expect(conceptVectors(CONCEPT_VECTORS, [...CONCEPTS, { name: "Sailing", broad: false }])).toBeNull();
    expect(conceptVectors({ ...CONCEPT_VECTORS, conceptsVersion: CONCEPTS_VERSION + 1 })).toBeNull();
  });

  it("the vocabulary has distinct names, broad ones for themes", () => {
    expect(new Set(CONCEPTS.map((c) => c.name)).size).toBe(CONCEPTS.length);
    expect(CONCEPTS.filter((c) => c.broad).length).toBeGreaterThanOrEqual(15);
  });
});
