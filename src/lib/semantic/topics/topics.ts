/**
 * Provisional topic groups for the mind map (Mind Map MVP). Server-only.
 *
 * An exploratory aid, not a classification: groups and their names are computed on demand
 * from the vectors already stored for search by meaning, and nothing is stored.
 *
 * 1. **One vector per indexed conversation:** the mean of its chunk vectors, leaving out
 *    very short chunks ("ok", "thanks!", see `vector-cache.ts`) when it has longer ones.
 * 2. **Centred, then normalised.** e5 vectors share a large common direction (cosine
 *    similarities sit around 0.8), which hides the differences that separate topics.
 * 3. **Spherical k-means** with a seeded k-means++ start, over the conversations in order
 *    of their ChatGPT id: the same export always gives the same groups, whatever the order
 *    or number of imports. About √n groups, between 2 and 12.
 * 4. **Names from titles:** up to three words that are frequent in a group's titles and rare
 *    in the other groups' titles (filler words in English, Norwegian and Russian removed,
 *    `naming.ts`); otherwise the title of the group's most typical conversation.
 *
 * Since the atlas (`atlas.ts`), this is the **k-means baseline** (`/map?method=kmeans`), kept
 * for comparison; the map's default grouping is the language-corrected hierarchy.
 *
 * Conversations that are not indexed are returned separately ("not grouped yet").
 * No model runs here (only stored vectors are read), nothing is logged, and only titles,
 * ids and dates leave this module.
 */
import type { DbClient } from "../../db/client";
import { CODE_INDEX_CONFIG } from "../index/config.ts";
import { currentVectors, type VectorCache } from "../search/vector-cache.ts";
import { words } from "./naming.ts";

export const MAX_TOPICS = 12;

export type TopicConversation = { id: string; title: string | null; updatedAtSec: number | null };
export type Topic = {
  id: string;
  /** Up to three distinctive title words; empty when the label is a typical title instead. */
  words: string[];
  /** Display name: the words joined, or the most typical conversation's title. */
  label: string;
  conversations: TopicConversation[];
  /** The same conversations, most typical first (closest to the group's centroid). */
  typical: TopicConversation[];
};
export type TopicMap = {
  total: number;
  /** False when there is no usable semantic index: everything is "not grouped yet". */
  indexed: boolean;
  topics: Topic[];
  ungrouped: TopicConversation[];
};

/** About √n groups, between 2 and 12 (1 when there are fewer than 3 conversations). */
export function topicCount(n: number): number {
  if (n < 3) return Math.min(n, 1);
  return Math.max(2, Math.min(MAX_TOPICS, Math.round(Math.sqrt(n))));
}

function normalise(v: Float64Array): Float64Array {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i++) v[i]! /= n;
  return v;
}

const dot = (a: Float64Array, b: Float64Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};

/** Deterministic pseudo-random numbers (mulberry32). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Spherical k-means on unit vectors: assignment by highest dot product, centroids
 * renormalised. Seeded k-means++ start; an emptied group is reseeded with the vector least
 * like its own centroid. Returns each vector's group and the centroids.
 */
export function cluster(vectors: readonly Float64Array[], k: number, seed = 1): { assignment: number[]; centroids: Float64Array[] } {
  const n = vectors.length;
  k = Math.max(1, Math.min(k, n));
  if (n === 0) return { assignment: [], centroids: [] };
  const rnd = random(seed);
  const centroids: Float64Array[] = [Float64Array.from(vectors[Math.floor(rnd() * n)]!)];
  while (centroids.length < k) {
    const d = vectors.map((v) => Math.max(0, 1 - Math.max(...centroids.map((c) => dot(v, c)))) ** 2);
    const total = d.reduce((a, b) => a + b, 0);
    let pick = d.findIndex((x) => x > 0);
    if (total > 0) {
      let r = rnd() * total;
      pick = d.findIndex((x) => (r -= x) <= 0);
      if (pick < 0) pick = n - 1;
    }
    if (pick < 0) break; // all vectors identical: fewer groups
    centroids.push(Float64Array.from(vectors[pick]!));
  }
  const assignment = new Array<number>(n).fill(-1);
  for (let iter = 0; iter < 50; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestDot = -Infinity;
      centroids.forEach((c, j) => {
        const s = dot(vectors[i]!, c);
        if (s > bestDot) {
          bestDot = s;
          best = j;
        }
      });
      if (assignment[i] !== best) {
        assignment[i] = best;
        changed = true;
      }
    }
    const dims = vectors[0]!.length;
    const sums = centroids.map(() => new Float64Array(dims));
    const counts = new Array<number>(centroids.length).fill(0);
    for (let i = 0; i < n; i++) {
      const s = sums[assignment[i]!]!;
      for (let d = 0; d < dims; d++) s[d]! += vectors[i]![d]!;
      counts[assignment[i]!]!++;
    }
    for (let j = 0; j < centroids.length; j++) {
      if (counts[j] === 0) {
        // Reseed with the vector least like its current centroid.
        let worst = 0;
        let worstDot = Infinity;
        for (let i = 0; i < n; i++) {
          const s = dot(vectors[i]!, centroids[assignment[i]!]!);
          if (s < worstDot) {
            worstDot = s;
            worst = i;
          }
        }
        centroids[j] = Float64Array.from(vectors[worst]!);
        assignment[worst] = j;
        changed = true;
      } else {
        centroids[j] = normalise(sums[j]!);
      }
    }
    if (!changed) break;
  }
  return { assignment, centroids };
}

/** A title's naming words: no filler words in English, Norwegian or Russian, no numbers (`naming.ts`). */
function titleWords(title: string | null): Set<string> {
  return new Set(words(title ?? ""));
}

/**
 * Up to three words frequent in each group's titles and rare in the others'. A word must
 * appear in at least two titles of a group of four or more.
 */
export function topicWords(groups: readonly (string | null)[][]): string[][] {
  const sets = groups.map((titles) => titles.map(titleWords));
  const spread = new Map<string, number>();
  for (const g of sets) for (const w of new Set(g.flatMap((s) => [...s]))) spread.set(w, (spread.get(w) ?? 0) + 1);
  return sets.map((g) => {
    const df = new Map<string, number>();
    for (const s of g) for (const w of s) df.set(w, (df.get(w) ?? 0) + 1);
    const min = g.length >= 4 ? 2 : 1;
    return [...df]
      .filter(([, c]) => c >= min)
      .map(([w, c]) => ({ w, s: (c / g.length) * Math.log(1 + groups.length / spread.get(w)!) }))
      .sort((a, b) => b.s - a.s || (a.w < b.w ? -1 : 1))
      .slice(0, 3)
      .map((x) => x.w);
  });
}

/** Mean of each conversation's chunk vectors (long chunks preferred), dequantised. */
function conversationVectors(cache: VectorCache): Map<string, Float64Array> {
  const dims = cache.dims;
  const sums = new Map<number, { long: Float64Array; nLong: number; all: Float64Array; nAll: number }>();
  for (let i = 0; i < cache.chunks; i++) {
    const c = cache.conversation[i]!;
    let acc = sums.get(c);
    if (!acc) {
      acc = { long: new Float64Array(dims), nLong: 0, all: new Float64Array(dims), nAll: 0 };
      sums.set(c, acc);
    }
    const scale = cache.scales[i]!;
    const isLong = cache.short[i] === 0;
    for (let d = 0; d < dims; d++) {
      const x = cache.values[i * dims + d]! * scale;
      acc.all[d]! += x;
      if (isLong) acc.long[d]! += x;
    }
    acc.nAll++;
    if (isLong) acc.nLong++;
  }
  const out = new Map<string, Float64Array>();
  for (const [c, acc] of sums) out.set(cache.conversationIds[c]!, normalise(acc.nLong > 0 ? acc.long : acc.all));
  return out;
}

/** Most recently updated first; missing dates last; then by id. */
export const byRecency = (a: TopicConversation, b: TopicConversation) =>
  (b.updatedAtSec ?? -Infinity) - (a.updatedAtSec ?? -Infinity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/**
 * Groups the conversations. They are clustered in the given order (the caller passes a stable
 * one); within each group they are listed most recently updated first.
 */
export function groupConversations(conversations: readonly TopicConversation[], vectors: ReadonlyMap<string, Float64Array>): Pick<TopicMap, "topics" | "ungrouped"> {
  const items = conversations.filter((c) => vectors.has(c.id));
  const ungrouped = conversations.filter((c) => !vectors.has(c.id));
  if (items.length === 0) return { topics: [], ungrouped };
  const dims = vectors.get(items[0]!.id)!.length;
  const mean = new Float64Array(dims);
  for (const c of items) {
    const v = vectors.get(c.id)!;
    for (let d = 0; d < dims; d++) mean[d]! += v[d]! / items.length;
  }
  const centred = items.map((c) => {
    const v = vectors.get(c.id)!;
    return normalise(Float64Array.from(v, (x, d) => x - mean[d]!));
  });
  const { assignment, centroids } = cluster(centred, topicCount(items.length));
  const groups = centroids.map(() => [] as number[]);
  assignment.forEach((g, i) => groups[g]!.push(i));
  const order = groups.map((g, j) => ({ g, j })).filter((x) => x.g.length > 0).sort((a, b) => b.g.length - a.g.length || a.j - b.j);
  const labelWords = topicWords(order.map(({ g }) => g.map((i) => items[i]!.title)));
  const topics = order.map(({ g, j }, t) => {
    const order = [...g].sort((a, b) => dot(centred[b]!, centroids[j]!) - dot(centred[a]!, centroids[j]!) || a - b);
    const w = labelWords[t]!;
    return {
      id: `t${t + 1}`,
      words: w,
      label: w.length > 0 ? w.join(" · ") : `“${truncate(items[order[0]!]!.title ?? "Untitled", 40)}”`,
      conversations: g.map((i) => items[i]!).sort(byRecency),
      typical: order.map((i) => items[i]!),
    };
  });
  return { topics, ungrouped };
}

/** The k-means groups of indexed conversations (the atlas's baseline), largest first. */
export function buildTopicGroups(conversations: readonly TopicConversation[], cache: VectorCache): { label: string; words: string[]; typical: TopicConversation[]; typicalId: string }[] {
  return groupConversations(conversations, conversationVectors(cache)).topics.map((t) => ({ label: t.label, words: t.words, typical: t.typical, typicalId: t.typical[0]!.id }));
}

/** The topic map of all imported conversations. */
export async function buildTopicMap(db: DbClient): Promise<TopicMap> {
  // Ordered by the ChatGPT id (stable across imports of the same export), so the groups are too.
  const rows = await db.conversation.findMany({
    select: { id: true, title: true, updatedAtSec: true, source: true, sourceId: true },
    orderBy: [{ source: "asc" }, { sourceId: "asc" }],
  });
  const conversations: TopicConversation[] = rows.map(({ id, title, updatedAtSec }) => ({ id, title, updatedAtSec }));
  if (conversations.length === 0) return { total: 0, indexed: false, topics: [], ungrouped: [] };
  const v = await currentVectors(db, { embeddingVersion: CODE_INDEX_CONFIG.embeddingVersion, chunkerVersion: CODE_INDEX_CONFIG.chunkerVersion });
  if (!v.ok) return { total: conversations.length, indexed: false, topics: [], ungrouped: [...conversations].sort(byRecency) };
  const grouped = groupConversations(conversations, conversationVectors(v.cache));
  return { total: conversations.length, indexed: true, topics: grouped.topics, ungrouped: [...grouped.ungrouped].sort(byRecency) };
}
