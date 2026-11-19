import type { QueryRejection } from "./query";
import type { MatchedBy, SearchNotice } from "./search";
import type { SearchErrorCode } from "./view";

/**
 * Fixed text for the search page (M2.3). Pure and content-free: no message
 * quotes the query, a title or a snippet, so these strings are safe for live
 * regions and alerts. (The page shows the query itself only as plain text in
 * the no-results message.)
 */

export function rejectionMessage(r: QueryRejection): string {
  switch (r.reason) {
    case "empty":
      return "Enter a word or phrase to search for.";
    case "no_terms":
      return "Your search has no words to look for. Use at least one letter or digit.";
    case "too_long":
      return `Your search is ${r.length.toLocaleString("en-US")} characters long. The limit is ${r.limit}. Shorten it and try again.`;
    case "too_many_terms":
      return `Your search has ${r.terms} words or phrases. The limit is ${r.limit}. Remove some and try again.`;
    case "prefix_too_short":
      return `Type at least ${r.minimum} letters or digits before * to search for words that start with them.`;
  }
}

export function searchErrorMessage(code: SearchErrorCode): string {
  switch (code) {
    case "DB_NOT_MIGRATED":
      return "Search is not set up in this database yet. Stop ThreadAtlas, run `npm run db:deploy`, start it again and retry.";
    case "DB_NOT_INITIALIZED":
      return "The database file does not exist. Run `npm run db:deploy` first.";
    case "DB_BUSY":
    case "DB_TIMEOUT":
      return "The database is busy. Try again in a moment.";
    case "REQUEST_FORBIDDEN":
      return "This search request was refused. Reload the page and try again.";
    case "INTERNAL_ERROR":
      return "Search failed unexpectedly. Try again.";
    default:
      return "Search failed because the database could not be read. Try again.";
  }
}

/** Announced in the live region after a search: counts and position only, never titles or snippets. */
export function resultAnnouncement(v: { total: number; page: number; totalPages: number; first: number; last: number }): string {
  if (v.total === 0) return "No conversations match.";
  const count = `${v.total.toLocaleString("en-US")} ${v.total === 1 ? "conversation matches" : "conversations match"}.`;
  if (v.totalPages === 1) return count;
  return `${count} Page ${v.page} of ${v.totalPages}, results ${v.first}–${v.last}.`;
}

export const SEARCHING = "Searching…";

/** Why a result is there (search by meaning, M5.2). */
export function matchedByLabel(m: MatchedBy): string {
  return m === "both" ? "Similar meaning · matches your words" : m === "meaning" ? "Similar meaning" : "Matches your words";
}

/** Search by meaning's one-line notice (static text and a count only). */
export function noticeMessage(n: SearchNotice): string {
  if (n.kind === "partial") {
    const c = n.notIndexed.toLocaleString("en-US");
    return `${c} ${n.notIndexed === 1 ? "conversation isn't" : "conversations aren't"} indexed yet; ${n.notIndexed === 1 ? "it appears" : "they appear"} only when the exact words match.`;
  }
  switch (n.reason) {
    case "MODEL_MISSING":
      return "Search by meaning needs the semantic model (run `npm run model:fetch`). Showing exact-word results.";
    case "MODEL_INVALID":
      return "The semantic model files don't match the approved version (run `npm run model:fetch`). Showing exact-word results.";
    case "INDEX_EMPTY":
      return "Your conversations haven't been indexed for search by meaning yet. Showing exact-word results.";
    case "INDEX_INCOMPATIBLE":
      return "The search index was built with a different model and needs rebuilding. Showing exact-word results.";
    case "UNAVAILABLE":
      return "Search by meaning is unavailable right now. Showing exact-word results.";
  }
}

export const LOADING_MODEL = "Loading the search model… The first search after a pause takes a few seconds.";
