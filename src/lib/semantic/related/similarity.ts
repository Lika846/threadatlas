/**
 * Related conversations: the pure parts (see `related.ts`). Server-only, no dependencies.
 */

/** At most this many related conversations. */
export const RELATED_LIMIT = 5;
/** Experimental: the lowest similarity that counts as related (graph spike: 8% false links among labelled synthetic conversations). */
export const RELATED_FLOOR = 0.35;
/** A passage explains a link only when it is at least this close to both conversations' averages. */
export const EVIDENCE_MIN = 0.3;
/** A passage with a near-copy (corrected similarity ≥ `BOILERPLATE_SIMILARITY`) in this many unrelated conversations is boilerplate. */
export const BOILERPLATE_CONVERSATIONS = 3;
export const BOILERPLATE_SIMILARITY = 0.9;
/** Longest passage shown, in characters. */
export const PASSAGE_CHARS = 280;

const dot = (a: Float64Array, b: Float64Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};

/** The `limit` conversations most similar to `focus` at or above `floor`, most similar first (ties: lower index). */
export function nearestConversations(vectors: readonly Float64Array[], focus: number, limit = RELATED_LIMIT, floor = RELATED_FLOOR): { index: number; similarity: number }[] {
  const f = vectors[focus]!;
  const out: { index: number; similarity: number }[] = [];
  for (let i = 0; i < vectors.length; i++) {
    if (i === focus) continue;
    const similarity = dot(f, vectors[i]!);
    if (similarity >= floor) out.push({ index: i, similarity });
  }
  return out.sort((a, b) => b.similarity - a.similarity || a.index - b.index).slice(0, limit);
}

/**
 * The passage (index into `chunks`) closest to both averages: the smaller of its similarity
 * to the other conversation's average and to its own. Passages for which `excluded` is true
 * (boilerplate) are skipped; null when no remaining passage reaches `min`.
 */
export function evidencePassage(
  chunks: readonly Float64Array[],
  own: Float64Array,
  other: Float64Array,
  excluded: (index: number) => boolean = () => false,
  min = EVIDENCE_MIN,
): { index: number; score: number } | null {
  const ranked = chunks.map((c, index) => ({ index, score: Math.min(dot(c, other), dot(c, own)) })).sort((a, b) => b.score - a.score || a.index - b.index);
  for (const r of ranked) {
    if (r.score < min) return null;
    if (!excluded(r.index)) return r;
  }
  return null;
}
