/**
 * The in-memory vector cache for search by meaning (M5.2; ADR 0002 decision 5).
 *
 * Filled only through `openVectorReader`, so it holds exactly the vectors of current
 * conversation versions in the current epoch (I6). Reloaded when the index's epoch or
 * change counter differs from the cached one: every commit, invalidation, delete-all and
 * rebuild changes one of them, so no deleted or replaced vector is ever scored.
 *
 * Packed: one Int8Array of all vectors, one Float32Array of their scales, offsets and a
 * conversation number per chunk (about 0.4 KB per chunk). Scoring is a brute-force dot
 * product (Experiment 2: 37 ms p50 at 50,000 chunks). Nothing here logs.
 *
 * **Very short chunks are demoted** (M5.2 quality fix, 2026-11-13). Real conversations are
 * full of acknowledgements ("ok", "thanks!", "works, thanks"); their embeddings sit near
 * the centre of the space and score about as high as a real answer for any short query
 * (measured: "thank you" 0.854 against the right passage's 0.854 for "recipe"). With a
 * conversation scored by its best chunk, they pushed relevant conversations down: in a
 * synthetic 334-conversation archive, "recipe" found its conversation at rank 8 and
 * "debugging" at rank 11. A chunk under `MIN_SEARCH_TOKENS` model tokens now counts only
 * when its conversation has no longer chunk; such conversations rank after every
 * conversation with a longer match. Measured: both at rank 1, and research-set nDCG@10
 * v0 0.817 → 0.840, long 0.828 unchanged. Query time only: the index is unchanged.
 *
 * **Generic passages are corrected** (2026-11-19, `hub.ts`): each chunk's score is reduced by
 * half its mean similarity to everyday subjects (production model only), computed once per cache.
 * Measured: nDCG@10 v0 0.840 → 0.852, long 0.828 → 0.866 (meaning only).
 */
import type { DbClient } from "../../db/client";
import { openVectorReader, type QueryEmbedderInfo } from "../index/reader.ts";
import { readIndexRow } from "../index/store.ts";
import { hubPenalties } from "./hub.ts";

/** Chunks shorter than this (model tokens) count only when nothing longer matches in their conversation. */
export const MIN_SEARCH_TOKENS = 8;

export type VectorCache = {
  readonly key: string;
  readonly dims: number;
  readonly conversationIds: readonly string[];
  /** Per chunk: index into `conversationIds`. */
  readonly conversation: Int32Array;
  readonly sourceNodeIds: readonly string[];
  readonly starts: Int32Array;
  readonly ends: Int32Array;
  /** 1 when the chunk has fewer than `MIN_SEARCH_TOKENS` tokens. */
  readonly short: Uint8Array;
  readonly scales: Float32Array;
  /** `chunks × dims` quantised values. */
  readonly values: Int8Array;
  readonly chunks: number;
  /** Per chunk: the genericness penalty subtracted from its score (`hub.ts`), computed at the first search. */
  readonly hub: { penalties: Float32Array | null };
};

export type CacheResult = { ok: true; cache: VectorCache } | { ok: false; code: "INDEX_EMPTY" | "INDEX_INCOMPATIBLE" };

const holder = globalThis as unknown as { __threadatlasVectorCache?: VectorCache | null };

/** The cache for the current index, reloaded only after a change. */
export async function currentVectors(db: DbClient, query: QueryEmbedderInfo): Promise<CacheResult> {
  const cached = holder.__threadatlasVectorCache ?? null;
  const { row } = await readIndexRow(db);
  if (cached && row && cached.key === `${row.epoch}:${row.changeCounter}:${row.dimensions}`) return { ok: true, cache: cached };
  const r = await openVectorReader(db, query);
  if (!r.ok) {
    holder.__threadatlasVectorCache = null;
    return { ok: false, code: r.code };
  }
  const cache = pack(`${r.epoch}:${r.changeCounter}:${r.dimensions}`, r.dimensions, r.rows);
  holder.__threadatlasVectorCache = cache;
  return { ok: true, cache };
}

/** Drops the cache (tests; never needed for correctness). */
export function dropVectorCache(): void {
  holder.__threadatlasVectorCache = null;
}

type Row = { conversationId: string; sourceNodeId: string; start: number; end: number; tokenCount: number; vector: Uint8Array };

export function pack(key: string, dims: number, rows: readonly Row[]): VectorCache {
  const n = rows.length;
  const values = new Int8Array(n * dims);
  const scales = new Float32Array(n);
  const conversation = new Int32Array(n);
  const starts = new Int32Array(n);
  const ends = new Int32Array(n);
  const short = new Uint8Array(n);
  const sourceNodeIds: string[] = new Array(n);
  const conversationIds: string[] = [];
  const index = new Map<string, number>();
  rows.forEach((r, i) => {
    let c = index.get(r.conversationId);
    if (c === undefined) {
      c = conversationIds.length;
      index.set(r.conversationId, c);
      conversationIds.push(r.conversationId);
    }
    conversation[i] = c;
    sourceNodeIds[i] = r.sourceNodeId;
    starts[i] = r.start;
    ends[i] = r.end;
    short[i] = r.tokenCount < MIN_SEARCH_TOKENS ? 1 : 0;
    scales[i] = new DataView(r.vector.buffer, r.vector.byteOffset, 4).getFloat32(0, true);
    values.set(new Int8Array(r.vector.buffer, r.vector.byteOffset + 4, dims), i * dims);
  });
  return { key, dims, conversationIds, conversation, sourceNodeIds, starts, ends, short, scales, values, chunks: n, hub: { penalties: null } };
}

export type ConversationHit = {
  conversationId: string;
  /** The best chunk's cosine similarity (int8 approximates it), minus its genericness penalty if corrected. */
  score: number;
  sourceNodeId: string;
  start: number;
  end: number;
  /** Scored by a short chunk: the conversation has no chunk of `MIN_SEARCH_TOKENS` or more. */
  short: boolean;
};

/** The cache's hub penalties, computed on first use. */
export function hubOf(cache: VectorCache): Float32Array {
  cache.hub.penalties ??= hubPenalties(cache);
  return cache.hub.penalties;
}

/**
 * The `k` best conversations, each with its best-matching chunk. A chunk scores its cosine
 * with the query, minus its genericness penalty when `correctGeneric` is set (search by
 * meaning sets it only with the production model, `meaning-search.ts`). A conversation's chunks of at least
 * `MIN_SEARCH_TOKENS` tokens are preferred; only a conversation with none of them is scored
 * by its short chunks, and it ranks after all others. Ties: lower conversation id first.
 */
export function topConversations(cache: VectorCache, query: Float32Array, k: number, opts: { correctGeneric?: boolean } = {}): ConversationHit[] {
  const { dims, values, scales, conversation, short } = cache;
  if (query.length !== dims) return [];
  const hub = opts.correctGeneric ? hubOf(cache) : new Float32Array(cache.chunks);
  const n = cache.conversationIds.length;
  const best = new Float64Array(n).fill(-Infinity);
  const bestChunk = new Int32Array(n).fill(-1);
  /** 1 while the conversation's best chunk is short (no longer chunk seen yet). */
  const tier = new Uint8Array(n).fill(1);
  for (let i = 0, o = 0; i < cache.chunks; i++, o += dims) {
    let s = 0;
    for (let d = 0; d < dims; d++) s += query[d]! * values[o + d]!;
    s = s * scales[i]! - hub[i]!;
    const c = conversation[i]!;
    const t = short[i]!;
    if (t < tier[c]! || (t === tier[c]! && s > best[c]!)) {
      tier[c] = t;
      best[c] = s;
      bestChunk[c] = i;
    }
  }
  const order = Array.from(best.keys())
    .filter((c) => bestChunk[c]! >= 0)
    .sort((a, b) => tier[a]! - tier[b]! || best[b]! - best[a]! || (cache.conversationIds[a]! < cache.conversationIds[b]! ? -1 : 1));
  return order.slice(0, k).map((c) => {
    const i = bestChunk[c]!;
    return { conversationId: cache.conversationIds[c]!, score: best[c]!, sourceNodeId: cache.sourceNodeIds[i]!, start: cache.starts[i]!, end: cache.ends[i]!, short: tier[c] === 1 };
  });
}
