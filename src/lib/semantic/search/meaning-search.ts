/**
 * Search by meaning (M5.2; ADR 0002 decision 7, approved 2026-11-12). Server-only.
 *
 * 1. The query is embedded by the query inference process (`query-host.ts`).
 * 2. Every stored chunk is scored against it (`vector-cache.ts`); a conversation scores its
 *    best chunk; the 50 best conversations are kept.
 * 3. **Gated fusion:** when the exact-word search (today's keyword search: every word must
 *    match) returns anything, both lists are fused by reciprocal rank fusion (k = 60), and
 *    the 50 best are kept; otherwise the results are by meaning only. Ties keep the meaning
 *    order first.
 * 4. All of them in one response, each marked as a close match or not (`closeMatches`), so
 *    the page can show "Other results" without searching again. Each result shows the
 *    passage that matched by meaning (the best chunk, read from its message by offsets, as
 *    plain text) or, when the words matched too, the keyword snippet with its highlights; a
 *    link to that message; and why it matched.
 *
 * When search by meaning can't run (model not installed or invalid, index empty or built
 * with another model, the query process unavailable), it runs the exact-word search and
 * says why. When some conversations are not indexed yet, it says how many.
 *
 * Read-only, on the reader connection. The query text is never logged; errors become codes.
 */
import type { DbClient } from "../../db/client";
import { sanitizeDbError } from "../../db/errors";
import { linkFor } from "../../search/link";
import { parseMeaningQuery, parseSearchQuery } from "../../search/query";
import {
  pageDetails,
  rankedMatches,
  searchConversations,
  type MatchedBy,
  type Ranked,
  type SearchNotice,
  type SearchOutcome,
  type SearchResultItem,
} from "../../search/search";
import { EmbeddingError } from "../errors.ts";
import { CODE_INDEX_CONFIG, sameIndexConfig } from "../index/config.ts";
import { inferenceTarget, modelState } from "../index/service.ts";
import { productionChildEntry } from "../inference-process.ts";
import { readIndexRow } from "../index/store.ts";
import { embedQueryText } from "./query-host.ts";
import { currentVectors, topConversations, type ConversationHit } from "./vector-cache.ts";

/** Distinct conversations returned by a search by meaning (plan decision 3). */
export const MEANING_RESULTS = 50;
/** Reciprocal rank fusion constant (ADR 0002 decision 7). */
export const RRF_K = 60;
/**
 * Relevance cutoff (2026-11-13): a conversation found by meaning only is a close match when
 * its score is within this margin of the search's best score; exact-word matches always
 * are. The rest (up to the 50) is returned too and shown under "Other results". Measured with
 * the real model: research sets keep 80% / 91% of relevant conversations among about 6 / 3
 * close matches (instead of 50); every expected answer in the synthetic chat archive is kept.
 * Re-measure if the model changes.
 */
export const CLOSE_MATCH_MARGIN = 0.03;

/**
 * Which fused results are close matches: exact-word matches, and meaning matches near the best
 * one. "Near" compares like with like: a conversation scored only by very short chunks (ranked
 * after all others, see `vector-cache.ts`) is never close to a best match that has a longer one.
 */
export function closeMatches(fused: readonly { id: string; matchedBy: MatchedBy }[], hits: readonly ConversationHit[], margin = CLOSE_MATCH_MARGIN): Set<string> {
  const hit = new Map(hits.map((h) => [h.conversationId, h]));
  const best = hits[0];
  const near = (id: string) => {
    const h = hit.get(id);
    return best !== undefined && h !== undefined && h.short === best.short && h.score >= best.score - margin;
  };
  return new Set(fused.filter((x) => x.matchedBy !== "meaning" || near(x.id)).map((x) => x.id));
}

type Where = { env?: Record<string, string | undefined>; root?: string; idleMs?: number };

/**
 * Whether search runs the production inference child, whose model made the vocabulary's vectors
 * (`hub.ts`): a deterministic check of the configured pipeline. The only alternative is the
 * test suite's fake model (`inferenceTarget`'s test override, honoured only under a test runner),
 * which declares the production embedding version on purpose; it gets no genericness correction.
 */
export function usesProductionModel(where: Where = {}): boolean {
  const env = where.env ?? process.env;
  const root = where.root ?? process.cwd();
  try {
    return inferenceTarget(env, root).entry === productionChildEntry(root);
  } catch {
    return false;
  }
}
type Fallback = Extract<SearchNotice, { kind: "fallback" }>["reason"];

/** Gated reciprocal rank fusion of two ranked id lists; the first list leads. */
export function fuse(meaning: readonly string[], words: readonly string[], limit = MEANING_RESULTS): { id: string; matchedBy: MatchedBy }[] {
  const wordRank = new Map(words.map((id, i) => [id, i + 1]));
  if (words.length === 0) return meaning.slice(0, limit).map((id) => ({ id, matchedBy: "meaning" as const }));
  const meaningRank = new Map(meaning.map((id, i) => [id, i + 1]));
  const ids = [...new Set([...meaning, ...words])];
  const score = (id: string) => (meaningRank.has(id) ? 1 / (RRF_K + meaningRank.get(id)!) : 0) + (wordRank.has(id) ? 1 / (RRF_K + wordRank.get(id)!) : 0);
  const order = (id: string) => meaningRank.get(id) ?? Number.MAX_SAFE_INTEGER;
  return ids
    .map((id) => ({ id, s: score(id) }))
    .sort((a, b) => b.s - a.s || order(a.id) - order(b.id) || (wordRank.get(a.id) ?? 0) - (wordRank.get(b.id) ?? 0))
    .slice(0, limit)
    .map(({ id }) => ({ id, matchedBy: meaningRank.has(id) ? (wordRank.has(id) ? "both" : "meaning") : "words" }));
}

const VISIBLE = (a: string) => `${a}."pathIndex" IS NOT NULL AND ${a}."isStructural" = 0 AND ${a}."isHidden" = 0`;

/** Each hit's message text and its position among the displayed messages. */
const passageSql = (n: number) => `
WITH target(cid, node) AS (VALUES ${Array.from({ length: n }, () => "(?, ?)").join(", ")})
SELECT t.cid AS cid, m."contentText" AS text,
  (SELECT COUNT(*) FROM "Message" x WHERE x."conversationId" = t.cid AND x."pathIndex" <= m."pathIndex" AND ${VISIBLE("x")}) AS messageNumber
FROM target t JOIN "Message" m ON m."conversationId" = t.cid AND m."sourceNodeId" = t.node AND ${VISIBLE("m")}`;

/** Results for conversations found by meaning only: the matched passage and a link to its message. */
async function meaningDetails(db: DbClient, hits: readonly ConversationHit[]): Promise<Map<string, SearchResultItem>> {
  const out = new Map<string, SearchResultItem>();
  if (hits.length === 0) return out;
  const conversations = await db.conversation.findMany({
    where: { id: { in: hits.map((h) => h.conversationId) } },
    select: { id: true, title: true, updatedAtSec: true },
  });
  const byId = new Map(conversations.map((c) => [c.id, c]));
  const rows = await db.$queryRawUnsafe<{ cid: string; text: string; messageNumber: number | bigint }[]>(
    passageSql(hits.length),
    ...hits.flatMap((h) => [h.conversationId, h.sourceNodeId]),
  );
  const message = new Map(rows.map((r) => [r.cid, r]));
  for (const h of hits) {
    const c = byId.get(h.conversationId);
    if (!c) continue; // deleted between the statements
    const m = message.get(h.conversationId);
    const fits = m !== undefined && h.end <= m.text.length && h.start < h.end;
    const passage = fits ? m.text.slice(h.start, h.end).trim() : "";
    const snippet =
      passage === ""
        ? null
        : [{ text: `${h.start > 0 ? "… " : ""}${passage}${h.end < m!.text.length ? " …" : ""}`, match: false }];
    const messageNumber = fits && Number(m!.messageNumber) > 0 ? Number(m!.messageNumber) : null;
    out.set(c.id, {
      conversationId: c.id,
      title: c.title,
      titleSegments: c.title === null ? null : [{ text: c.title, match: false }],
      titleMatch: false,
      matchingMessages: 0,
      updatedAtSec: c.updatedAtSec,
      score: h.score,
      snippet,
      link: linkFor(c.id, messageNumber),
      matchedBy: "meaning",
    });
  }
  return out;
}

async function notIndexed(db: DbClient): Promise<number> {
  const [r] = await db.$queryRawUnsafe<{ total: number | bigint; indexed: number | bigint }[]>(
    `SELECT (SELECT COUNT(*) FROM "Conversation") AS total,
            (SELECT COUNT(*) FROM "EmbeddingStatus" WHERE "state" = 'indexed') AS indexed`,
  );
  return Math.max(0, Number(r?.total ?? 0) - Number(r?.indexed ?? 0));
}

export async function searchByMeaning(db: DbClient, rawQuery: unknown, rawPage: string | string[] | undefined, where: Where = {}): Promise<SearchOutcome> {
  const q = parseMeaningQuery(rawQuery);
  if (!q.ok) return { status: "invalid", rejection: q.rejection };

  const fallback = async (reason: Fallback): Promise<SearchOutcome> => {
    const o = await searchConversations(db, q.text, rawPage);
    return o.status === "ok" ? { ...o, notice: { kind: "fallback", reason } } : o;
  };

  try {
    const model = await modelState(where.env ?? process.env, where.root ?? process.cwd());
    if (model.state === "missing") return fallback("MODEL_MISSING");
    if (model.state !== "ok") return fallback("MODEL_INVALID");
    const { row } = await readIndexRow(db);
    if (!row) return fallback("INDEX_EMPTY");
    if (!sameIndexConfig(row, CODE_INDEX_CONFIG)) return fallback("INDEX_INCOMPATIBLE");

    let embedded: Awaited<ReturnType<typeof embedQueryText>>;
    try {
      embedded = await embedQueryText(q.text, where);
    } catch (e) {
      const code = e instanceof EmbeddingError ? e.code : null;
      return fallback(code === "MODEL_MISSING" ? "MODEL_MISSING" : code === "MODEL_INVALID" ? "MODEL_INVALID" : "UNAVAILABLE");
    }
    const vectors = await currentVectors(db, embedded.info);
    if (!vectors.ok) return fallback(vectors.code);

    const hits = topConversations(vectors.cache, embedded.vector, MEANING_RESULTS, { correctGeneric: usesProductionModel(where) });
    const parsed = parseSearchQuery(q.text);
    const words: Ranked[] = parsed.ok ? await rankedMatches(db, parsed.fts) : [];
    const fused = fuse(
      hits.map((h) => h.conversationId),
      words.map((w) => w.id),
    );

    // One response for everything (at most 50): expanding "Other results" never searches again.
    const slice = fused;
    const close = closeMatches(fused, hits);

    const wordById = new Map(words.map((w) => [w.id, w]));
    const hitById = new Map(hits.map((h) => [h.conversationId, h]));
    const wordItems =
      parsed.ok && slice.some((x) => wordById.has(x.id))
        ? await pageDetails(db, parsed.fts, parsed.terms.some((t) => t.prefix), slice.filter((x) => wordById.has(x.id)).map((x) => wordById.get(x.id)!))
        : [];
    const wordItemById = new Map(wordItems.map((r) => [r.conversationId, r]));
    const meaningItems = await meaningDetails(db, slice.filter((x) => !wordById.has(x.id)).map((x) => hitById.get(x.id)!));

    const results: SearchResultItem[] = [];
    for (const x of slice) {
      const item = wordItemById.get(x.id) ?? meaningItems.get(x.id);
      if (item) results.push({ ...item, matchedBy: x.matchedBy, close: close.has(x.id) });
    }
    const missing = await notIndexed(db);
    return { status: "ok", results, total: results.length, page: 1, totalPages: 1, notice: missing > 0 ? { kind: "partial", notIndexed: missing } : null };
  } catch (e) {
    return { status: "error", code: sanitizeDbError(e) };
  }
}

/** "meaning" when search by meaning can run and something is indexed, else "words" (the page's default mode). */
export async function defaultSearchMode(db: DbClient, where: Where = {}): Promise<"meaning" | "words"> {
  try {
    const model = await modelState(where.env ?? process.env, where.root ?? process.cwd());
    if (model.state !== "ok") return "words";
    const { row } = await readIndexRow(db);
    if (!row || !sameIndexConfig(row, CODE_INDEX_CONFIG)) return "words";
    const [r] = await db.$queryRawUnsafe<{ n: number | bigint }[]>(`SELECT COUNT(*) AS n FROM "EmbeddingStatus" WHERE "state" = 'indexed' AND "chunkCount" > 0`);
    return Number(r?.n ?? 0) > 0 ? "meaning" : "words";
  } catch {
    return "words";
  }
}
