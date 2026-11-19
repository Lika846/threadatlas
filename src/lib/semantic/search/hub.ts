/**
 * Generic-passage correction for search by meaning (2026-11-19). Server-only.
 *
 * Some passages are close to almost any query: generic advice, a paragraph of an essay, a
 * riddle, a short line that shares common words ("works. can i run this automatically every
 * night"). With e5 the scores of a query's best 25 conversations sit within about 0.04 of each
 * other, so such passages pushed relevant conversations down (search spike,
 * `docs/spikes/search-v3/README.md`).
 *
 * A passage's **genericness** is its mean similarity to the general subjects of the theme
 * vocabulary (`../topics/concepts.ts`: about 150 everyday subjects, embedded as queries,
 * `concept-vectors.generated.ts`). That mean is a single dot product with the vocabulary's mean
 * vector. Ranking subtracts `HUB_WEIGHT` × genericness from each passage's score: a passage must
 * match *this* query better than it matches subjects in general. A passage strongly about one
 * subject is not penalised for it (an earlier version used the 10 nearest subjects instead, and
 * penalised on-topic passages; the spike shows why it was dropped).
 *
 * - **Chosen** on the v0 research set (weights 0.5 to 2; 0.5 best), then checked on the long
 *   research set, natural-language queries over the mind-map v2 set and the chatter-heavy
 *   archive of the model test. nDCG@10, meaning only: v0 0.840 → 0.852, long 0.828 → 0.866,
 *   v2 0.556 → 0.596, chatter archive unchanged (every target still first).
 * - **Cost:** one dot product per passage, once per index state (at the first search).
 * - **Without matching vectors** (another vocabulary or model, or other dimensions), the
 *   correction is 0: the old ranking, never a wrong correction.
 * - **Only for the production model:** the vocabulary's vectors were made by the pinned model, so
 *   the correction is applied only when search runs the production inference child (never the
 *   test suite's fake model, which declares the same embedding version on purpose). The caller
 *   decides (`meaning-search.ts`, `topConversations`'s `correctGeneric`).
 */
import { conceptVectors, type ConceptVector } from "../topics/concept-names.ts";

/** Weight of the genericness subtracted from each passage's score. */
export const HUB_WEIGHT = 0.5;

type Packed = { dims: number; chunks: number; values: Int8Array; scales: Float32Array };

/** The vocabulary's mean vector (not normalised), or null without a usable vocabulary. */
export function vocabularyMean(vocabulary: readonly ConceptVector[] | null, dims: number): Float32Array | null {
  if (vocabulary === null || vocabulary.length === 0 || vocabulary[0]!.vector.length !== dims) return null;
  const mean = new Float32Array(dims);
  for (const c of vocabulary) for (let d = 0; d < dims; d++) mean[d]! += c.vector[d]! / vocabulary.length;
  return mean;
}

/**
 * The penalty of every passage (`HUB_WEIGHT` × its mean similarity to the vocabulary), or zeros
 * without a usable vocabulary. `values` and `scales` are the vector cache's int8 vectors.
 */
export function hubPenalties(packed: Packed, vocabulary: readonly ConceptVector[] | null = conceptVectors()): Float32Array {
  const out = new Float32Array(packed.chunks);
  const mean = vocabularyMean(vocabulary, packed.dims);
  if (mean === null) return out;
  const { dims, values, scales } = packed;
  for (let i = 0, o = 0; i < packed.chunks; i++, o += dims) {
    let s = 0;
    for (let d = 0; d < dims; d++) s += mean[d]! * values[o + d]!;
    out[i] = HUB_WEIGHT * s * scales[i]!;
  }
  return out;
}
