/**
 * The atlas: the map's data, themes → topics → conversations. Server-only.
 *
 * One structure feeds both the map and the outline, so they can never disagree.
 *
 * - **`method: "topics"` (the default):** language-corrected conversation vectors
 *   (`../conversation-vectors.ts`) in one average-linkage tree, cut twice (`themes.ts`).
 *   - **Themes** are named from the vocabulary (`concept-names.ts`), each name used once.
 *   - **Topics** are named by their two most typical titles.
 *   - A theme without a vocabulary name is named by its title words (`naming.ts`), then by its
 *     most typical title.
 *   - Chosen in spike v3 (`docs/spikes/mindmap/v3/`).
 * - **`method: "kmeans"`:** the earlier k-means map (`topics.ts`), kept as a baseline for
 *   comparison. Its groups are themes without topics.
 *
 * **Off the request path (phase 2).** The O(n²) tree runs in a worker thread (`hierarchy-host.ts`);
 * concurrent requests share one computation; `warmAtlas` starts it when an indexing run ends.
 *
 * **Cache.** The result is kept in memory, one per method, under a key made of:
 * - the vector cache's key, which changes with every index commit, invalidation, delete-all
 *   and rebuild;
 * - `ATLAS_VERSION` and `CONCEPTS_VERSION`, the grouping and naming configuration;
 * - a fingerprint of every conversation's id, title and update time, read on each request.
 *
 * So a stale atlas is never shown: re-importing a changed title changes the key, and so does
 * indexing. Nothing is stored in the database. Message text is read only to detect languages
 * (`conversation-vectors.ts`), never logged or kept. Ids of themes and topics come from their
 * most typical conversation, so they stay the same while a group keeps its centre (URL state).
 */
import type { DbClient } from "../../db/client";
import { chunkVector, correctedVectors, type CorrectedVectors } from "../conversation-vectors.ts";
import { CODE_INDEX_CONFIG } from "../index/config.ts";
import { currentVectors, type VectorCache } from "../search/vector-cache.ts";
import { conceptVectors, nameThemes } from "./concept-names.ts";
import { CONCEPTS_VERSION } from "./concepts.ts";
import type { Lang } from "./lang.ts";
import { createNamer, displayName, typicalTitles } from "./naming.ts";
import { computeHierarchy } from "./hierarchy-host.ts";
import { THEME_CUT } from "./themes.ts";
import { TOPIC_CUT } from "./hierarchy.ts";
import { buildTopicGroups, byRecency, type TopicConversation } from "./topics.ts";

/** Bump with any change to grouping or naming that isn't in `CONCEPTS_VERSION`. */
export const ATLAS_VERSION = 1;

export type AtlasMethod = "topics" | "kmeans";

export type AtlasTopic = {
  id: string;
  /** Up to two distinct titles of its most typical conversations. */
  titles: string[];
  /** Most recently updated first. */
  conversations: TopicConversation[];
};

export type AtlasTheme = {
  id: string;
  name: string;
  /** Where the name comes from: the vocabulary, the theme's title words, or one title. */
  nameSource: "vocabulary" | "words" | "title";
  /** Every conversation of the theme, most typical first. */
  typical: TopicConversation[];
  /** Largest first. Empty for the k-means baseline. */
  topics: AtlasTopic[];
  /** In the theme but in no topic; most recently updated first. */
  loose: TopicConversation[];
};

export type Atlas = {
  method: AtlasMethod;
  total: number;
  /** False when there is no usable semantic index: everything is "not grouped yet". */
  indexed: boolean;
  /** Distances the tree was cut at (method "topics"); null otherwise or when nothing was grouped. */
  cuts: { topic: number; theme: number } | null;
  /** Largest first. */
  themes: AtlasTheme[];
  /** Indexed, but close to no other conversation. Most recently updated first. */
  other: TopicConversation[];
  /** Not indexed yet. Most recently updated first. */
  ungrouped: TopicConversation[];
};

type Row = TopicConversation & { source: string; sourceId: string };
type Cached = { key: string; atlas: Atlas };
const holder = globalThis as unknown as { __threadatlasAtlas?: Map<AtlasMethod, Cached>; __threadatlasAtlasPending?: Map<string, Promise<Atlas>> };

/** Drops the cached atlases (tests; never needed for correctness). */
export function dropAtlasCache(): void {
  holder.__threadatlasAtlas = new Map();
  holder.__threadatlasAtlasPending = new Map();
}

/** FNV-1a style hash of a string, two 32-bit halves in base 36. */
function hash(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}

/** The fingerprint of what the atlas shows besides the index: ids, titles and update times. */
export function rowsFingerprint(rows: readonly TopicConversation[]): string {
  return hash(rows.map((r) => `${r.id}\u0000${r.title ?? "\u0001"}\u0000${r.updatedAtSec ?? ""}`).join("\u0002"));
}

/** Stable, unique ids from each group's most typical conversation. */
function stableIds(prefix: string, typicalIds: readonly string[]): string[] {
  const seen = new Set<string>();
  return typicalIds.map((id) => {
    let out = `${prefix}${hash(id).slice(0, 8)}`;
    for (let k = 2; seen.has(out); k++) out = `${prefix}${hash(id).slice(0, 8)}-${k}`;
    seen.add(out);
    return out;
  });
}

/** Main language of each conversation (by chunk), for naming words. */
function conversationLangs(cv: CorrectedVectors): Lang[] {
  return cv.chunks.map((cs) => {
    const count = new Map<Lang, number>();
    for (const c of cs) count.set(cv.chunkLang[c.index]!, (count.get(cv.chunkLang[c.index]!) ?? 0) + 1);
    return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "other";
  });
}

/** The mean of the chunks that make each group's conversations (the model's own space). */
function groupCentroid(cache: VectorCache, cv: CorrectedVectors, members: readonly number[]): Float64Array {
  const sum = new Float64Array(cache.dims);
  for (const i of members)
    for (const c of cv.chunks[i]!) {
      if (!c.used) continue;
      const v = chunkVector(cache, c.index);
      for (let d = 0; d < cache.dims; d++) sum[d]! += v[d]!;
    }
  return sum;
}

async function topicsAtlas(rows: readonly TopicConversation[], cache: VectorCache, cv: CorrectedVectors): Promise<Pick<Atlas, "cuts" | "themes" | "other">> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const conv = (i: number) => byId.get(cv.ids[i]!);
  const present = (is: readonly number[]) => is.map(conv).filter((c): c is TopicConversation => c !== undefined);
  const h = await computeHierarchy(cv.centred); // in a worker thread: O(n²)
  const vocabulary = nameThemes(
    h.themes.map((t) => groupCentroid(cache, cv, t.members)),
    conceptVectors(),
  );
  const langs = conversationLangs(cv);
  let namer: ReturnType<typeof createNamer> | null = null;
  const themeIds = stableIds("th-", h.themes.map((t) => cv.ids[t.members[0]!]!));
  const themes: AtlasTheme[] = h.themes.map((t, ti) => {
    const typical = present(t.members);
    let name = vocabulary[ti] ?? null;
    let nameSource: AtlasTheme["nameSource"] = "vocabulary";
    if (name === null) {
      namer ??= createNamer(cv.ids.map((id, i) => ({ title: byId.get(id)?.title ?? null, text: "", lang: langs[i] })));
      const words = namer.name(t.members).words;
      const fallback = typicalTitles(typical.map((c) => c.title), 1);
      name = displayName(words, fallback);
      nameSource = words.length > 0 ? "words" : "title";
    }
    const topicIds = stableIds(`${themeIds[ti]}.tp-`, t.topics.map((m) => cv.ids[m[0]!]!));
    return {
      id: themeIds[ti]!,
      name,
      nameSource,
      typical,
      topics: t.topics.map((m, k) => {
        const members = present(m);
        return { id: topicIds[k]!, titles: typicalTitles(members.map((c) => c.title), 2), conversations: [...members].sort(byRecency) };
      }),
      loose: present(t.loose).sort(byRecency),
    };
  });
  return {
    cuts: h.topicCut !== null && h.themeCut !== null ? { topic: h.topicCut, theme: h.themeCut } : null,
    themes: themes.filter((t) => t.typical.length > 0),
    other: present(h.other).sort(byRecency),
  };
}

function kmeansAtlas(rows: readonly TopicConversation[], cache: VectorCache): Pick<Atlas, "cuts" | "themes" | "other"> {
  const groups = buildTopicGroups(rows, cache);
  const ids = stableIds("km-", groups.map((g) => g.typicalId));
  return {
    cuts: null,
    themes: groups.map((g, i) => ({
      id: ids[i]!,
      name: g.label,
      nameSource: g.words.length > 0 ? "words" : "title",
      typical: g.typical,
      topics: [],
      loose: [...g.typical].sort(byRecency),
    })),
    other: [],
  };
}

/** The atlas of all imported conversations. */
export async function buildAtlas(db: DbClient, opts: { method?: AtlasMethod } = {}): Promise<Atlas> {
  const method = opts.method ?? "topics";
  // Ordered by the ChatGPT id (stable across imports of the same export), so the groups are too.
  const rows: Row[] = await db.conversation.findMany({
    select: { id: true, title: true, updatedAtSec: true, source: true, sourceId: true },
    orderBy: [{ source: "asc" }, { sourceId: "asc" }],
  });
  const base = { method, total: rows.length, cuts: null, themes: [], other: [] };
  if (rows.length === 0) return { ...base, indexed: false, ungrouped: [] };
  const plain = (r: Row): TopicConversation => ({ id: r.id, title: r.title, updatedAtSec: r.updatedAtSec });
  const v = await currentVectors(db, { embeddingVersion: CODE_INDEX_CONFIG.embeddingVersion, chunkerVersion: CODE_INDEX_CONFIG.chunkerVersion });
  if (!v.ok) return { ...base, indexed: false, ungrouped: rows.map(plain).sort(byRecency) };

  const key = [v.cache.key, ATLAS_VERSION, CONCEPTS_VERSION, TOPIC_CUT.min, TOPIC_CUT.max, THEME_CUT.maxThemes, rowsFingerprint(rows)].join("|");
  holder.__threadatlasAtlas ??= new Map();
  const cached = holder.__threadatlasAtlas.get(method);
  if (cached?.key === key) return cached.atlas;

  // One computation per state: concurrent requests (and the warm-up after indexing) share it.
  holder.__threadatlasAtlasPending ??= new Map();
  const pendingKey = `${method}|${key}`;
  const pending = holder.__threadatlasAtlasPending.get(pendingKey);
  if (pending) return pending;
  const work = (async () => {
    const inIndex = new Set(v.cache.conversationIds);
    const conversations = rows.map(plain);
    const grouped = method === "kmeans" ? kmeansAtlas(conversations, v.cache) : await topicsAtlas(conversations, v.cache, await correctedVectors(db, v.cache));
    const atlas: Atlas = {
      method,
      total: rows.length,
      indexed: true,
      ...grouped,
      ungrouped: conversations.filter((c) => !inIndex.has(c.id)).sort(byRecency),
    };
    holder.__threadatlasAtlas!.set(method, { key, atlas });
    return atlas;
  })();
  holder.__threadatlasAtlasPending.set(pendingKey, work);
  try {
    return await work;
  } finally {
    holder.__threadatlasAtlasPending.delete(pendingKey);
  }
}

/**
 * Computes the default atlas in the background (after an indexing run), so the first visit to
 * the map finds it ready. Never throws; a failure only means the map computes it on demand.
 */
export function warmAtlas(db: DbClient): void {
  void buildAtlas(db).catch(() => undefined);
}
