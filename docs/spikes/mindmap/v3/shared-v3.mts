// Mind-map spike v3 (themes → topics): shared loading through the PRODUCTION vector pipeline.
// Synthetic data only; no database is opened. Embeddings come from the v1 and v2 embed scripts.
import { centre, languageCorrectedVectors, textKey, type ChunkInput } from "../../../../src/lib/semantic/conversation-vectors.ts";
import { MIN_SEARCH_TOKENS } from "../../../../src/lib/semantic/search/vector-cache.ts";
import { detectLanguage, resolveLanguages } from "../../../../src/lib/semantic/topics/lang.ts";
import { loadDev, loadTest, type Item } from "../v2/shared.mts";

export type { Item };

/** Items of a set, as production would see them. */
export function load(set: "dev" | "test", file: string, root: string): Item[] {
  return set === "dev" ? loadDev(file, root) : loadTest(file, root);
}

/**
 * Conversation vectors exactly as production computes them (`conversation-vectors.ts`):
 * per-message language (production detector), language means, chunk selection, centring.
 */
export function productionVectors(items: readonly Item[]): { vectors: Float64Array[]; centred: Float64Array[] } {
  const inputs: ChunkInput[] = [];
  items.forEach((c, ci) => {
    const langs = resolveLanguages(c.messages.map((m) => detectLanguage(m)));
    for (const k of c.chunks) {
      const key = k.text !== undefined ? textKey(k.text) : undefined;
      inputs.push({ conversation: ci, lang: langs[k.msg]!, short: k.tokenCount < MIN_SEARCH_TOKENS, vector: k.v, key });
    }
  });
  const dims = items[0]!.chunks[0]!.v.length;
  const vectors = languageCorrectedVectors(items.length, dims, inputs);
  return { vectors, centred: centre(vectors) };
}

/** Deterministic pseudo-random numbers (mulberry32), for subsamples. */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sample<T>(xs: readonly T[], k: number, seed: number): T[] {
  const r = random(seed);
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, k);
}
