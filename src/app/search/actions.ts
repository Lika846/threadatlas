"use server";

import { headers } from "next/headers";
import { getDb } from "@/lib/db/client";
import { checkServerActionRequest } from "@/lib/request-guards";
import { searchConversations } from "@/lib/search/search";
import { searchByMeaning } from "@/lib/semantic/search/meaning-search";
import { pageArgument, toSearchView, type SearchView } from "@/lib/search/view";

/**
 * The search Server Action (M2.3; A101–A103).
 *
 * - Called by the search form with two plain values, never through
 *   `useActionState`, so no previous results are ever sent back.
 * - Checks the request first (loopback Host, exact Origin, Sec-Fetch-Site,
 *   then Next-Action), like the Settings actions: an action can be called
 *   directly, with any arguments.
 * - Arguments are untrusted: a non-string query is treated as empty by the
 *   parser; the page must be a whole number (`pageArgument`).
 * - Read-only, on the reader connection; nothing is revalidated or cached.
 * - Nothing is logged. Database errors arrive as fixed codes from the query
 *   layer; anything unexpected becomes INTERNAL_ERROR.
 * - `mode` (M5.2): exactly "meaning" searches by meaning (`searchByMeaning`, which
 *   falls back to exact words and says why); anything else is today's exact-word search.
 */
export async function searchAction(query: unknown, page: unknown, mode?: unknown): Promise<SearchView> {
  try {
    if (!checkServerActionRequest(await headers()).ok) return { kind: "error", code: "REQUEST_FORBIDDEN" };
  } catch {
    return { kind: "error", code: "REQUEST_FORBIDDEN" };
  }
  try {
    const db = getDb();
    const p = pageArgument(page);
    return toSearchView(mode === "meaning" ? await searchByMeaning(db, query, p) : await searchConversations(db, query, p));
  } catch {
    return { kind: "error", code: "INTERNAL_ERROR" };
  }
}
