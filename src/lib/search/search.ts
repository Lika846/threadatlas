import type { DbClient } from "../db/client";
import { sanitizeDbError, type DbErrorCode } from "../db/errors";
import { parsePage } from "../conversations/queries";
import { linkFor, type SearchLink } from "./link";
import { parseSearchQuery, type QueryRejection } from "./query";
import { createMarkers, parseMarkedText, type SnippetSegment } from "./snippet";

/**
 * Keyword search over the M2.1 index (M2.2; A93–A100; design in
 * `docs/import-format.md`, *Search queries*). Runs on the reader connection
 * (`getDb()`), one statement at a time and without a transaction, like the
 * other page reads.
 *
 * - **What is searched:** conversation titles and the messages the detail
 *   page shows by default: on the stored path, not structural, not hidden.
 *   The index also holds hidden and branch messages; matches found only
 *   there are neither returned nor counted.
 * - **Ranking:** FTS5's bm25, where LOWER is better (more negative). A
 *   conversation scores its best visible-message match, or its title match
 *   times 2 (A95), whichever is lower. Ties: most recently updated first
 *   (missing update times last), then internal id descending.
 * - **Pages:** 20 conversations; `parsePage` rules (invalid → 1, past the
 *   end → last page).
 * - **Per result:** the best visible message (score, then path position)
 *   gives the snippet and the link (`link.ts`); a title-only match links to
 *   the top of the conversation.
 *
 * The query text is passed only as a bound parameter. Nothing is logged;
 * `rawContentJson` is never selected; errors become `sanitizeDbError` codes.
 */

export const SEARCH_RESULTS_PER_PAGE = 20;
/** Title matches count double (bm25 is negative, so doubling ranks them higher). */
export const TITLE_WEIGHT = 2;
/** Maximum tokens in a message snippet (FTS5 `snippet()` allows 1–64). */
export const SNIPPET_TOKENS = 16;

export type SearchResultItem = {
  conversationId: string;
  /** As stored (null = untitled); `titleSegments` is the display form. */
  title: string | null;
  /** The title as segments, matches marked when the title matched; null when untitled. */
  titleSegments: SnippetSegment[] | null;
  titleMatch: boolean;
  /** Visible messages in this conversation that match. */
  matchingMessages: number;
  updatedAtSec: number | null;
  /** bm25-based rank score: lower is better. */
  score: number;
  /** Around the best visible matching message; null for a title-only match. */
  snippet: SnippetSegment[] | null;
  link: SearchLink;
  /** Search by meaning only (M5.2): why the conversation is in the results. */
  matchedBy?: MatchedBy;
  /** Search by meaning only: a close match (shown first) or one of the "Other results". */
  close?: boolean;
};

export type MatchedBy = "meaning" | "words" | "both";

/** Search by meaning only (M5.2): why exact words were used instead, or what is not covered. */
export type SearchNotice =
  | { kind: "fallback"; reason: "MODEL_MISSING" | "MODEL_INVALID" | "INDEX_EMPTY" | "INDEX_INCOMPATIBLE" | "UNAVAILABLE" }
  | { kind: "partial"; notIndexed: number };

export type SearchOutcome =
  | { status: "ok"; results: SearchResultItem[]; total: number; page: number; totalPages: number; notice?: SearchNotice | null }
  | { status: "invalid"; rejection: QueryRejection }
  | { status: "error"; code: DbErrorCode };

/** Displayed by default on the detail page (same rule as `getConversationDetail`). */
const VISIBLE = `m."pathIndex" IS NOT NULL AND m."isStructural" = 0 AND m."isHidden" = 0`;

/**
 * One pass over each index: every matching conversation with its score, its
 * number of visible matching messages, and its best visible message (score,
 * then path position, then rowid).
 */
const RANKED_SQL = `
WITH message_hits AS (
  SELECT m."conversationId" AS cid, m.rowid AS rid, m."pathIndex" AS pathIndex, bm25("message_fts") AS score
  FROM "message_fts" JOIN "Message" m ON m.rowid = "message_fts".rowid
  WHERE "message_fts" MATCH ? AND ${VISIBLE}
),
message_best AS MATERIALIZED (
  SELECT cid, rid, pathIndex, score, matches FROM (
    SELECT cid, rid, pathIndex, score,
      COUNT(*) OVER (PARTITION BY cid) AS matches,
      ROW_NUMBER() OVER (PARTITION BY cid ORDER BY score ASC, pathIndex ASC, rid ASC) AS rn
    FROM message_hits
  ) WHERE rn = 1
),
title_hits AS MATERIALIZED (
  SELECT c."id" AS cid, bm25("conversation_fts") * ${TITLE_WEIGHT}.0 AS score
  FROM "conversation_fts" JOIN "Conversation" c ON c.rowid = "conversation_fts".rowid
  WHERE "conversation_fts" MATCH ?
),
matched AS (
  SELECT cid FROM message_best UNION SELECT cid FROM title_hits
)
SELECT x.cid AS id,
  CASE WHEN mb.score IS NULL THEN th.score WHEN th.score IS NULL THEN mb.score ELSE min(mb.score, th.score) END AS score,
  th.cid IS NOT NULL AS titleMatch,
  COALESCE(mb.matches, 0) AS messageMatches,
  mb.rid AS bestRid,
  mb.pathIndex AS bestPathIndex
FROM matched x
JOIN "Conversation" c ON c."id" = x.cid
LEFT JOIN message_best mb ON mb.cid = x.cid
LEFT JOIN title_hits th ON th.cid = x.cid
ORDER BY score ASC, c."updatedAtSec" DESC NULLS LAST, c."id" DESC`;

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");
const pairs = (n: number) => Array.from({ length: n }, () => "(?, ?)").join(", ");

/** The best message's position among displayed messages: the `Message` index only, no FTS. */
const numberSql = (n: number) => `
WITH target(cid, pathIndex) AS (VALUES ${pairs(n)})
SELECT t.cid AS cid,
  (SELECT COUNT(*) FROM "Message" m
   WHERE m."conversationId" = t.cid AND m."pathIndex" <= t.pathIndex AND ${VISIBLE}) AS messageNumber
FROM target t`;

/**
 * Row restriction for the snippet query. FTS5 can seek a MATCH to given
 * rowids, which is fast for words but, for a prefix that expands to many
 * words, re-merges their lists for every rowid (measured: 815 ms for 9 rows
 * against 215 ms for scanning all 50,000 matches). `rowid + 0` hides the
 * restriction from FTS5, so it scans the matches and SQLite filters them;
 * `snippet()` is still computed only for the rows that pass.
 */
const ROWID_SEEK = `"message_fts".rowid`;
const ROWID_FILTER = `("message_fts".rowid + 0)`;

const snippetSql = (n: number, prefix: boolean) => `
SELECT "message_fts".rowid AS rid, snippet("message_fts", 0, ?, ?, ?, ${SNIPPET_TOKENS}) AS marked
FROM "message_fts" WHERE "message_fts" MATCH ? AND ${prefix ? ROWID_FILTER : ROWID_SEEK} IN (${placeholders(n)})`;

/** `+c."id"`: no index on the id, so the (small) title index drives the query instead of rowid seeks. */
const titleSql = (n: number) => `
SELECT c."id" AS id, highlight("conversation_fts", 0, ?, ?) AS marked
FROM "conversation_fts" JOIN "Conversation" c ON c.rowid = "conversation_fts".rowid
WHERE "conversation_fts" MATCH ? AND +c."id" IN (${placeholders(n)})`;

export type Ranked = {
  id: string;
  score: number;
  titleMatch: number | bigint;
  messageMatches: number | bigint;
  bestRid: number | bigint | null;
  bestPathIndex: number | bigint | null;
};
type MessageNumber = { cid: string; messageNumber: number | bigint };
type Marked = { rid?: number | bigint; id?: string; marked: string | null };

export async function searchConversations(db: DbClient, rawQuery: unknown, rawPage: string | string[] | undefined): Promise<SearchOutcome> {
  const parsed = parseSearchQuery(rawQuery);
  if (!parsed.ok) return { status: "invalid", rejection: parsed.rejection };
  try {
    const ranked = await rankedMatches(db, parsed.fts);
    const total = ranked.length;
    const totalPages = Math.max(1, Math.ceil(total / SEARCH_RESULTS_PER_PAGE));
    const page = parsePage(rawPage, totalPages);
    const slice = ranked.slice((page - 1) * SEARCH_RESULTS_PER_PAGE, page * SEARCH_RESULTS_PER_PAGE);
    const prefix = parsed.terms.some((term) => term.prefix);
    const results = slice.length === 0 ? [] : await pageDetails(db, parsed.fts, prefix, slice);
    return { status: "ok", results, total, page, totalPages };
  } catch (e) {
    return { status: "error", code: sanitizeDbError(e) };
  }
}

/** Every matching conversation, best first (the exact-word list that search by meaning fuses with). */
export function rankedMatches(db: DbClient, fts: string): Promise<Ranked[]> {
  return db.$queryRawUnsafe<Ranked[]>(RANKED_SQL, fts, fts);
}

/** Titles, snippets and links for ranked matches, in their order. */
export async function pageDetails(db: DbClient, fts: string, prefix: boolean, slice: Ranked[]): Promise<SearchResultItem[]> {
  const ids = slice.map((r) => r.id);
  const markers = createMarkers();

  const conversations = await db.conversation.findMany({
    where: { id: { in: ids } },
    select: { id: true, title: true, updatedAtSec: true },
  });
  const byId = new Map(conversations.map((c) => [c.id, c]));

  const withMessage = slice.filter((r) => r.bestRid !== null && r.bestPathIndex !== null);
  const numbers =
    withMessage.length === 0
      ? []
      : await db.$queryRawUnsafe<MessageNumber[]>(numberSql(withMessage.length), ...withMessage.flatMap((r) => [r.id, Number(r.bestPathIndex)]));
  const numberById = new Map(numbers.map((n) => [n.cid, Number(n.messageNumber)]));
  const bestById = new Map<string, { rid: number; messageNumber: number }>();
  for (const r of withMessage) {
    const messageNumber = numberById.get(r.id);
    // 0: the message left the displayed path between the statements (no transaction is held).
    if (messageNumber !== undefined && messageNumber > 0) bestById.set(r.id, { rid: Number(r.bestRid), messageNumber });
  }

  const rids = [...bestById.values()].map((b) => b.rid);
  const snippets =
    rids.length === 0
      ? []
      : await db.$queryRawUnsafe<Marked[]>(snippetSql(rids.length, prefix), markers.start, markers.end, markers.ellipsis, fts, ...rids);
  const snippetByRid = new Map(snippets.map((s) => [Number(s.rid), s.marked]));

  const titled = slice.filter((r) => Number(r.titleMatch) === 1).map((r) => r.id);
  const titles = titled.length === 0 ? [] : await db.$queryRawUnsafe<Marked[]>(titleSql(titled.length), markers.start, markers.end, fts, ...titled);
  const titleById = new Map(titles.map((t) => [t.id!, t.marked]));

  const out: SearchResultItem[] = [];
  for (const r of slice) {
    const c = byId.get(r.id);
    if (!c) continue; // deleted between the statements (no transaction is held)
    const b = bestById.get(r.id);
    const titleMatch = Number(r.titleMatch) === 1;
    if (!b && !titleMatch) continue; // its matching messages were replaced in between
    const markedTitle = titleById.get(r.id);
    const snippet = b ? snippetByRid.get(b.rid) : undefined;
    out.push({
      conversationId: c.id,
      title: c.title,
      titleSegments: c.title === null ? null : parseMarkedText(typeof markedTitle === "string" ? markedTitle : c.title, markers),
      titleMatch,
      matchingMessages: Number(r.messageMatches),
      updatedAtSec: c.updatedAtSec,
      score: Number(r.score),
      snippet: typeof snippet === "string" ? parseMarkedText(snippet, markers) : null,
      link: linkFor(c.id, b ? b.messageNumber : null),
    });
  }
  return out;
}
