import type { DbErrorCode } from "../db/errors";
import { formatEpochSeconds, isoFromEpochSeconds } from "../conversations/display";
import { searchLinkHref } from "./link";
import type { QueryRejection } from "./query";
import { SEARCH_RESULTS_PER_PAGE, type MatchedBy, type SearchNotice, type SearchOutcome } from "./search";
import type { SnippetSegment } from "./snippet";

/**
 * What the search Server Action returns to the page (M2.3; A102). Pure, so the
 * client can import the types and the server maps outcomes with it.
 *
 * Only what the page displays: no scores, no raw titles beyond their segments,
 * no internal row ids. Titles and snippets stay structured `{ text, match }`
 * segments; the page renders them as React text and `<mark>`, never as HTML.
 */

export type SearchErrorCode = DbErrorCode | "REQUEST_FORBIDDEN" | "INTERNAL_ERROR";

export type SearchResultView = {
  conversationId: string;
  /** Link to the best visible message (or the conversation's top for a title-only match). */
  href: string;
  /** Null when the conversation is untitled. */
  title: SnippetSegment[] | null;
  titleMatch: boolean;
  matchingMessages: number;
  /** Position of the best visible matching message on the conversation page (null for a title-only match). */
  messageNumber: number | null;
  updated: string | null;
  updatedIso: string | null;
  snippet: SnippetSegment[] | null;
  /** Search by meaning only: why it matched. */
  matchedBy: MatchedBy | null;
  /** Search by meaning only: a close match, or one of the "Other results". */
  close: boolean | null;
};

export type SearchView =
  | {
      kind: "results";
      results: SearchResultView[];
      total: number;
      page: number;
      totalPages: number;
      /** 1-based positions of the first and last result on this page (0 when there are none). */
      first: number;
      last: number;
      /** Search by meaning only: exact words were used instead, or some conversations are not indexed. */
      notice: SearchNotice | null;
    }
  | { kind: "invalid"; rejection: QueryRejection }
  | { kind: "error"; code: SearchErrorCode };

export function toSearchView(outcome: SearchOutcome): SearchView {
  if (outcome.status === "invalid") return { kind: "invalid", rejection: outcome.rejection };
  if (outcome.status === "error") return { kind: "error", code: outcome.code };
  const offset = (outcome.page - 1) * SEARCH_RESULTS_PER_PAGE;
  const results = outcome.results.map((r) => ({
    conversationId: r.conversationId,
    href: searchLinkHref(r.link),
    title: r.title === null || r.title.trim() === "" ? null : r.titleSegments,
    titleMatch: r.titleMatch,
    matchingMessages: r.matchingMessages,
    messageNumber: r.link.messageNumber,
    updated: formatEpochSeconds(r.updatedAtSec),
    updatedIso: isoFromEpochSeconds(r.updatedAtSec) ?? null,
    snippet: r.snippet,
    matchedBy: r.matchedBy ?? null,
    close: r.close ?? null,
  }));
  return {
    kind: "results",
    results,
    total: outcome.total,
    page: outcome.page,
    totalPages: outcome.totalPages,
    first: results.length === 0 ? 0 : offset + 1,
    last: offset + results.length,
    notice: outcome.notice ?? null,
  };
}

/**
 * Page numbers accepted from the client: a whole number from 1 to 1,000,000,000
 * (as a number or digit string). Anything else asks for page 1; past the end
 * gives the last page (`parsePage` in the query layer).
 */
export function pageArgument(raw: unknown): string {
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 1 && raw <= 1_000_000_000) return String(raw);
  if (typeof raw === "string" && /^[0-9]{1,9}$/.test(raw)) return raw;
  return "1";
}
