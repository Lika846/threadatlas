/**
 * Language-corrected conversation vectors, shared by the experimental topics
 * (`topics/tree-map.ts`) and related conversations (`related/related.ts`). Server-only.
 *
 * e5 vectors carry a strong language signal: conversations in one language are closer to
 * each other than conversations on one subject in different languages (mind-map spikes v1
 * and v2, graph spike; `docs/spikes/`). So, per indexed chunk:
 * 1. **Its message's language** (`topics/lang.ts`).
 * 2. **That language's average chunk vector is subtracted**, then the chunk is normalised. A
 *    language found in fewer than 2 conversations, and "other", use the average of all
 *    chunks instead. *Known limitation:* when every conversation in a small language is on
 *    one subject, that subject is the language's average and is removed with it.
 * 3. **One vector per conversation:** the normalised mean of its corrected chunks, leaving out
 *    very short chunks (as `vector-cache.ts` scores them) and text repeated word for word in
 *    `REPEATED_IN` or more conversations (templates, boilerplate, a standard pasted prompt),
 *    unless that is all the conversation has (`chunkSelection`). Without this, a conversation
 *    that ends with the same boilerplate as many template conversations gets related to them.
 * 4. **Centred** across the archive and normalised, for similarity (`centred`).
 *
 * Both averages count each *distinct* text once (a chunk by its text, a conversation by its
 * chunks' texts). Otherwise many copies of one text (templates, regenerated prompts,
 * boilerplate) would define them, and after subtracting such an average every conversation
 * unlike those copies would point the same way and look related to every other one (seen in
 * the end-to-end archive, where hundreds of fixture conversations share the same messages).
 * Repeats are found by text, not by vector: the model gives the same text slightly different
 * vectors in different batches (up to 0.02 per dimension measured), so exact vectors only
 * match with the test suite's fake model.
 *
 * Computed from the vector cache and the messages' text (read only to detect languages,
 * never logged or kept), and cached in memory for one vector cache: `currentVectors` replaces
 * that whenever the semantic index changes (every commit, invalidation, delete-all and rebuild).
 */
import type { DbClient } from "../db/client";
import type { VectorCache } from "./search/vector-cache.ts";
import { detectLanguage, resolveLanguages, type Lang } from "./topics/lang.ts";

export type ChunkInput = {
  conversation: number;
  lang: Lang;
  short: boolean;
  vector: Float64Array;
  /** Identity of the chunk's text (`textKey`); repeats are found by it. Without it, by exact vector. */
  key?: string;
};

export type CorrectedVectors = {
  /** The vector cache these were computed from (replaced whenever the index changes). */
  source: VectorCache;
  /** Indexed conversations, in a stable order (by source and ChatGPT id). */
  ids: readonly string[];
  position: ReadonlyMap<string, number>;
  /** Per conversation: the normalised mean of its corrected chunks (step 3). */
  vectors: readonly Float64Array[];
  /** The same, centred across the archive and normalised (step 4). */
  centred: readonly Float64Array[];
  /** Per conversation: its chunks' indices in the vector cache, and whether each counts (step 3). */
  chunks: readonly { index: number; used: boolean }[][];
  /** Per vector-cache chunk: the language whose mean is subtracted. */
  chunkLang: readonly Lang[];
  means: ReadonlyMap<Lang, Float64Array>;
  /** Per vector-cache chunk: the length of the dequantised vector minus its language's mean. */
  norms: Float32Array;
  /** Per vector-cache conversation number: its index in `ids`, or −1. */
  cachePosition: Int32Array;
  /** Remembered answers of `hasNearCopies`, by vector-cache chunk and thresholds. */
  nearCopies: Map<string, boolean>;
};

function normalise(v: Float64Array): Float64Array {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i]! /= n;
  return v;
}

/**
 * Text repeated word for word in this many conversations doesn't count toward their meaning.
 * A heuristic, not a measured optimum: high enough that a prompt reused within a small group
 * of related conversations still counts, low enough to catch templates and boilerplate. Only
 * checked on synthetic conversations (graph spike set, with the real model); revisit on a
 * real archive.
 */
export const REPEATED_IN = 10;

/** Two 32-bit FNV-1a style hashes of a string, as one key. */
function stringHash(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return `t${(h1 >>> 0).toString(36)}.${(h2 >>> 0).toString(36)}.${text.length}`;
}

/** The identity of a passage's text: whitespace collapsed, case ignored. */
export function textKey(text: string): string {
  return stringHash(text.replace(/\s+/g, " ").trim().toLowerCase());
}

/** A hash of a vector's exact values (FNV-1a over its bytes): the fallback identity without a text key. */
function vectorHash(v: Float64Array): string {
  const words = new Uint32Array(v.buffer, v.byteOffset, v.length * 2);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < words.length; i++) {
    h1 = Math.imul(h1 ^ words[i]!, 0x01000193);
    h2 = Math.imul(h2 ^ words[i]!, 0x5bd1e995);
  }
  return `${(h1 >>> 0).toString(36)}.${(h2 >>> 0).toString(36)}`;
}

/** The mean subtracted from each language's chunks (step 2), over distinct chunk vectors. */
export function languageMeans(dims: number, chunks: readonly ChunkInput[]): Map<Lang, Float64Array> {
  const all = new Float64Array(dims);
  let allCount = 0;
  const seenAll = new Set<string>();
  const byLang = new Map<Lang, { sum: Float64Array; count: number; conversations: Set<number>; seen: Set<string> }>();
  for (const c of chunks) {
    let acc = byLang.get(c.lang);
    if (!acc) byLang.set(c.lang, (acc = { sum: new Float64Array(dims), count: 0, conversations: new Set(), seen: new Set() }));
    acc.conversations.add(c.conversation);
    const h = c.key ?? vectorHash(c.vector);
    if (!acc.seen.has(h)) {
      acc.seen.add(h);
      for (let d = 0; d < dims; d++) acc.sum[d]! += c.vector[d]!;
      acc.count++;
    }
    if (!seenAll.has(h)) {
      seenAll.add(h);
      for (let d = 0; d < dims; d++) all[d]! += c.vector[d]!;
      allCount++;
    }
  }
  const global = all.map((x) => x / Math.max(1, allCount));
  const mean = new Map<Lang, Float64Array>();
  for (const [lang, acc] of byLang) mean.set(lang, lang !== "other" && acc.conversations.size >= 2 ? acc.sum.map((x) => x / acc.count) : global);
  return mean;
}

/** A chunk with its language's mean removed, normalised. */
export function correctChunk(vector: Float64Array, mean: Float64Array): Float64Array {
  return normalise(Float64Array.from(vector, (x, d) => x - mean[d]!));
}

/**
 * Which chunks count toward their conversation's vector (step 3): long chunks that aren't
 * repeated in `repeatedIn` or more conversations; failing that, short ones that aren't; then
 * long repeated ones; then all.
 */
export function chunkSelection(chunks: readonly ChunkInput[], repeatedIn = REPEATED_IN): boolean[] {
  const hashes = chunks.map((c) => c.key ?? vectorHash(c.vector));
  const spread = new Map<string, Set<number>>();
  chunks.forEach((c, i) => {
    let set = spread.get(hashes[i]!);
    if (!set) spread.set(hashes[i]!, (set = new Set()));
    set.add(c.conversation);
  });
  const repeated = hashes.map((h) => spread.get(h)!.size >= repeatedIn);
  const byConversation = new Map<number, number[]>();
  chunks.forEach((c, i) => byConversation.set(c.conversation, [...(byConversation.get(c.conversation) ?? []), i]));
  const used = new Array<boolean>(chunks.length).fill(false);
  for (const idx of byConversation.values()) {
    const tiers = [(i: number) => !chunks[i]!.short && !repeated[i], (i: number) => !repeated[i], (i: number) => !chunks[i]!.short, () => true];
    const tier = tiers.find((f) => idx.some(f))!;
    for (const i of idx) used[i] = tier(i);
  }
  return used;
}

/**
 * One vector per conversation (0..n−1) with each language's average removed (steps 2–3).
 * Callers pass only conversations that have chunks (a conversation without any would get a
 * zero vector). Zero vectors are left as they are by `normalise`, never divided by zero.
 */
export function languageCorrectedVectors(
  n: number,
  dims: number,
  chunks: readonly ChunkInput[],
  means = languageMeans(dims, chunks),
  used = chunkSelection(chunks),
): Float64Array[] {
  const sums = Array.from({ length: n }, () => new Float64Array(dims));
  chunks.forEach((c, i) => {
    if (!used[i]) return;
    const v = correctChunk(c.vector, means.get(c.lang)!);
    const s = sums[c.conversation]!;
    for (let d = 0; d < dims; d++) s[d]! += v[d]!;
  });
  return sums.map(normalise);
}

/**
 * Subtracts the mean of the distinct vectors, then normalises each (step 4). `keys` say which
 * vectors are the same conversation (by text); without them, exact vectors are compared.
 */
export function centre(vectors: readonly Float64Array[], keys?: readonly string[]): Float64Array[] {
  if (vectors.length === 0) return [];
  const dims = vectors[0]!.length;
  const distinct = new Map<string, Float64Array>();
  vectors.forEach((v, i) => distinct.set(keys?.[i] ?? vectorHash(v), v));
  const mean = new Float64Array(dims);
  for (const v of distinct.values()) for (let d = 0; d < dims; d++) mean[d]! += v[d]! / distinct.size;
  return vectors.map((v) => normalise(Float64Array.from(v, (x, d) => x - mean[d]!)));
}

/** A vector-cache chunk, dequantised. */
export function chunkVector(cache: VectorCache, i: number): Float64Array {
  const { dims, values, scales } = cache;
  const scale = scales[i]!;
  const v = new Float64Array(dims);
  for (let d = 0; d < dims; d++) v[d] = values[i * dims + d]! * scale;
  return v;
}

// ---------------------------------------------------------------------------- database

const holder = globalThis as unknown as { __threadatlasCorrectedVectors?: CorrectedVectors | null };

/** Drops the cached vectors (tests; never needed for correctness). */
export function dropCorrectedVectors(): void {
  holder.__threadatlasCorrectedVectors = null;
}

const KEY_SEP = "\u0000";
const MESSAGE_BATCH = 200;

/**
 * For every chunk of the given conversations: its message's language and its text's key
 * (`textKey` of the message text between the chunk's offsets). Message text is not kept.
 */
async function chunkTexts(db: DbClient, cache: VectorCache, conversationIds: readonly string[]): Promise<{ lang: Map<number, Lang>; key: Map<number, string> }> {
  const byMessage = new Map<string, number[]>();
  for (let i = 0; i < cache.chunks; i++) {
    const k = cache.conversationIds[cache.conversation[i]!]! + KEY_SEP + cache.sourceNodeIds[i]!;
    byMessage.set(k, [...(byMessage.get(k) ?? []), i]);
  }
  const lang = new Map<number, Lang>();
  const key = new Map<number, string>();
  for (let b = 0; b < conversationIds.length; b += MESSAGE_BATCH) {
    const rows = await db.message.findMany({
      where: { conversationId: { in: conversationIds.slice(b, b + MESSAGE_BATCH) } },
      select: { conversationId: true, sourceNodeId: true, contentText: true },
      orderBy: [{ conversationId: "asc" }, { sourceNodeId: "asc" }],
    });
    const perConversation = new Map<string, { chunks: number[][]; langs: (Lang | null)[] }>();
    for (const r of rows) {
      const chunks = byMessage.get(r.conversationId + KEY_SEP + r.sourceNodeId);
      if (!chunks) continue;
      let acc = perConversation.get(r.conversationId);
      if (!acc) perConversation.set(r.conversationId, (acc = { chunks: [], langs: [] }));
      acc.chunks.push(chunks);
      acc.langs.push(detectLanguage(r.contentText));
      for (const i of chunks) key.set(i, textKey(r.contentText.slice(cache.starts[i]!, cache.ends[i]!)));
    }
    for (const { chunks, langs } of perConversation.values()) resolveLanguages(langs).forEach((l, m) => chunks[m]!.forEach((i) => lang.set(i, l)));
  }
  return { lang, key };
}

async function compute(db: DbClient, cache: VectorCache): Promise<CorrectedVectors> {
  const inIndex = new Set(cache.conversationIds);
  const rows = await db.conversation.findMany({ select: { id: true }, orderBy: [{ source: "asc" }, { sourceId: "asc" }] });
  const ids = rows.map((r) => r.id).filter((id) => inIndex.has(id));
  const position = new Map(ids.map((id, i) => [id, i]));
  const texts = await chunkTexts(db, cache, ids);
  const chunkLang: Lang[] = new Array(cache.chunks);
  const inputs: ChunkInput[] = [];
  const perConversation: { index: number; input: number }[][] = ids.map(() => []);
  for (let i = 0; i < cache.chunks; i++) {
    const id = cache.conversationIds[cache.conversation[i]!]!;
    chunkLang[i] = texts.lang.get(i) ?? "other";
    const conversation = position.get(id);
    if (conversation === undefined) continue; // deleted since the cache was loaded
    const short = cache.short[i] === 1;
    perConversation[conversation]!.push({ index: i, input: inputs.length });
    inputs.push({ conversation, lang: chunkLang[i]!, short, vector: chunkVector(cache, i), key: texts.key.get(i) });
  }
  const means = languageMeans(cache.dims, inputs);
  const used = chunkSelection(inputs);
  const vectors = languageCorrectedVectors(ids.length, cache.dims, inputs, means, used);
  const chunks = perConversation.map((cs) => cs.map((c) => ({ index: c.index, used: used[c.input]! })));
  // A conversation's identity for centring: the texts of the chunks that make its vector.
  const conversationKeys = perConversation.map((cs) => stringHash(cs.filter((c) => used[c.input]).map((c) => inputs[c.input]!.key ?? vectorHash(inputs[c.input]!.vector)).sort().join(" ")));
  const norms = new Float32Array(cache.chunks);
  for (let i = 0; i < cache.chunks; i++) {
    const v = chunkVector(cache, i);
    const m = means.get(chunkLang[i]!) ?? means.get("other") ?? new Float64Array(cache.dims);
    let s = 0;
    for (let d = 0; d < cache.dims; d++) s += (v[d]! - m[d]!) ** 2;
    norms[i] = Math.sqrt(s);
  }
  const cachePosition = Int32Array.from(cache.conversationIds, (id) => position.get(id) ?? -1);
  return { source: cache, ids, position, vectors, centred: centre(vectors, conversationKeys), chunks, chunkLang, means, norms, cachePosition, nearCopies: new Map() };
}

/**
 * Whether a chunk has a near-copy (corrected cosine ≥ `similarity`) in at least `conversations`
 * other conversations that are *unrelated* to its own (centred similarity below `relatedFrom`):
 * boilerplate such as "I hope this helps! Let me know if…". A passage repeated only within a
 * group of related conversations (a reused prompt) is not boilerplate. One pass over
 * the int8 vectors (measured 1.2 ms at 2,300 chunks, so about 8 ms at 15,000), remembered
 * per chunk until the index changes. Agrees exactly with comparing fully corrected vectors.
 */
export function hasNearCopies(cache: VectorCache, cv: CorrectedVectors, chunk: number, similarity: number, conversations: number, relatedFrom: number): boolean {
  const memo = `${chunk}:${similarity}:${conversations}:${relatedFrom}`;
  const known = cv.nearCopies.get(memo);
  if (known !== undefined) return known;
  const { dims, values, scales } = cache;
  const c = correctChunk(chunkVector(cache, chunk), cv.means.get(cv.chunkLang[chunk]!)!);
  // corrected(k)·c = (scale_k · q_k·c − μ_k·c) / ‖k − μ_k‖, with μ_k·c per language.
  const muDot = new Map<Lang, number>();
  for (const [lang, m] of cv.means) {
    let s = 0;
    for (let d = 0; d < dims; d++) s += m[d]! * c[d]!;
    muDot.set(lang, s);
  }
  const own = cache.conversation[chunk]!;
  const ownVector = cv.centred[cv.cachePosition[own]!];
  const related = new Map<number, boolean>();
  const isRelated = (conv: number) => {
    let r = related.get(conv);
    if (r === undefined) {
      const p = cv.cachePosition[conv]!;
      let s = -Infinity;
      if (ownVector && p >= 0) {
        s = 0;
        for (let d = 0; d < dims; d++) s += ownVector[d]! * cv.centred[p]![d]!;
      }
      related.set(conv, (r = s >= relatedFrom));
    }
    return r;
  };
  const found = new Set<number>();
  for (let k = 0; k < cache.chunks && found.size < conversations; k++) {
    const conv = cache.conversation[k]!;
    if (conv === own || found.has(conv) || cv.norms[k]! === 0) continue;
    let s = 0;
    for (let d = 0, o = k * dims; d < dims; d++) s += values[o + d]! * c[d]!;
    if ((scales[k]! * s - muDot.get(cv.chunkLang[k]!)!) / cv.norms[k]! >= similarity && !isRelated(conv)) found.add(conv);
  }
  const result = found.size >= conversations;
  cv.nearCopies.set(memo, result);
  return result;
}

/** The corrected vectors for the current vector cache, computed once per index state. */
export async function correctedVectors(db: DbClient, cache: VectorCache): Promise<CorrectedVectors> {
  const cached = holder.__threadatlasCorrectedVectors ?? null;
  if (cached?.source === cache) return cached;
  const fresh = await compute(db, cache);
  holder.__threadatlasCorrectedVectors = fresh;
  return fresh;
}
