/**
 * Theme names from the vocabulary (`concepts.ts`). Server-only, pure.
 *
 * Each theme is compared with the vocabulary's broad names in the model's own space: cosine
 * of the name's query vector (precomputed, `concept-vectors.generated.ts`) with the theme's
 * mean chunk vector. Each name is used by at most one theme: the (theme, name) pairs among each
 * theme's `CANDIDATES` nearest names are taken in order of similarity, so the theme a name fits
 * best gets it, and another theme takes its next nearest name. A theme left without one gets
 * no vocabulary name (the caller names it by its words). Spike v3 (`docs/spikes/mindmap/v3`):
 * on the held-out set every theme with a clear majority label got a name that matches it, against
 * a third with title or word names.
 *
 * The precomputed vectors are used only when they were made for the running vocabulary
 * (`CONCEPTS_VERSION` and a hash of the names) and model (`EMBEDDING_VERSION`); otherwise
 * there are no vocabulary names, never wrong ones.
 */
import { EMBEDDING_VERSION } from "../model-manifest.ts";
import { dequantizeInt8 } from "../quantize.ts";
import { CONCEPTS, CONCEPTS_VERSION, type Concept, type ConceptVectorFile } from "./concepts.ts";
import { CONCEPT_VECTORS } from "./concept-vectors.generated.ts";

/** Nearest names per theme considered for the unique assignment. */
export const CANDIDATES = 5;

/** A short hash of the vocabulary (names and levels), recorded with the precomputed vectors. */
export function conceptsHash(concepts: readonly Concept[]): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const text = concepts.map((c) => `${c.broad ? "B" : "S"}:${c.name}`).join("\n");
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return `${(h1 >>> 0).toString(36)}.${(h2 >>> 0).toString(36)}.${concepts.length}`;
}

export type ConceptVector = { name: string; broad: boolean; vector: Float32Array };

/** The vocabulary with its vectors, or null when the precomputed vectors don't match the running code. */
export function conceptVectors(file: ConceptVectorFile = CONCEPT_VECTORS, concepts: readonly Concept[] = CONCEPTS, dims = 384): ConceptVector[] | null {
  if (file.conceptsVersion !== CONCEPTS_VERSION || file.embeddingVersion !== EMBEDDING_VERSION || file.namesHash !== conceptsHash(concepts)) return null;
  if (file.vectors.length !== concepts.length) return null;
  return concepts.map((c, i) => ({ ...c, vector: dequantizeInt8(new Uint8Array(Buffer.from(file.vectors[i]!, "base64")), dims) }));
}

function cosine(a: Float32Array, b: Float64Array): number {
  let s = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na > 0 && nb > 0 ? s / Math.sqrt(na * nb) : 0;
}

/**
 * One vocabulary name (broad) per theme, at most one theme per name; null for a theme left
 * without one. `centroids` are the themes' mean chunk vectors, in the model's space.
 */
export function nameThemes(centroids: readonly Float64Array[], vocabulary: readonly ConceptVector[] | null): (string | null)[] {
  if (vocabulary === null) return centroids.map(() => null);
  const broad = vocabulary.filter((c) => c.broad);
  const pairs = centroids.flatMap((v, theme) =>
    broad
      .map((c) => ({ theme, name: c.name, s: cosine(c.vector, v) }))
      .sort((a, b) => b.s - a.s || (a.name < b.name ? -1 : 1))
      .slice(0, CANDIDATES),
  );
  pairs.sort((a, b) => b.s - a.s || a.theme - b.theme || (a.name < b.name ? -1 : 1));
  const names: (string | null)[] = centroids.map(() => null);
  const used = new Set<string>();
  for (const p of pairs) {
    if (names[p.theme] !== null || used.has(p.name)) continue;
    names[p.theme] = p.name;
    used.add(p.name);
  }
  return names;
}
