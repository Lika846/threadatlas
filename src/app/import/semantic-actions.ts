"use server";

import { headers } from "next/headers";
import { checkServerActionRequest } from "@/lib/request-guards";
import { codeMessage, viewOf, type IndexView, type Tone } from "@/lib/semantic/index/messages";
import { getIndexingStatus, pauseIndexing, retryFailedConversations, startIndexing } from "@/lib/semantic/index/service";

/**
 * Semantic-index Server Actions (M5.1b-2). Same request checks as the Settings
 * actions (loopback Host, exact Origin, Sec-Fetch-Site, Next-Action), run first. None
 * takes input; each returns the current view (static text, counts, button states) and a
 * static notice. Nothing is logged. Indexing starts only from `startIndexingAction`.
 */

export type SemanticActionResult = {
  view: IndexView | null;
  notice: { tone: Tone; text: string } | null;
};

const REJECTED: SemanticActionResult = { view: null, notice: { tone: "error", text: "The request was rejected." } };
const UNAVAILABLE = "The semantic index status could not be read.";

async function allowed(): Promise<boolean> {
  try {
    return checkServerActionRequest(await headers()).ok;
  } catch {
    return false;
  }
}

async function currentView(): Promise<IndexView | null> {
  try {
    return viewOf(await getIndexingStatus());
  } catch {
    return null;
  }
}

async function result(notice: SemanticActionResult["notice"]): Promise<SemanticActionResult> {
  const view = await currentView();
  return { view, notice: view ? notice : { tone: "error", text: UNAVAILABLE } };
}

/** Polled every 2 s by the semantic index panel on the Import page. */
export async function semanticIndexStatusAction(): Promise<SemanticActionResult> {
  if (!(await allowed())) return REJECTED;
  return result(null);
}

export async function startIndexingAction(): Promise<SemanticActionResult> {
  if (!(await allowed())) return REJECTED;
  try {
    const r = await startIndexing();
    if (r.outcome === "not-started") return result({ tone: "error", text: codeMessage(r.code) });
    return result({ tone: "neutral", text: r.outcome === "started" ? "Indexing started." : "Indexing is already running." });
  } catch {
    return result({ tone: "error", text: codeMessage("") });
  }
}

export async function pauseIndexingAction(): Promise<SemanticActionResult> {
  if (!(await allowed())) return REJECTED;
  const r = pauseIndexing();
  return result(r === "pausing" ? { tone: "neutral", text: "Pausing after the current batch…" } : { tone: "neutral", text: "Indexing is not running." });
}

export async function retryFailedAction(): Promise<SemanticActionResult> {
  if (!(await allowed())) return REJECTED;
  try {
    const r = await retryFailedConversations();
    if (!r.ok) return result({ tone: "error", text: codeMessage(r.code) });
    const text =
      r.count === 0
        ? "There are no failed conversations to retry."
        : `${r.count.toLocaleString("en-US")} failed ${r.count === 1 ? "conversation" : "conversations"} will be indexed again at the next Start.`;
    return result({ tone: "neutral", text });
  } catch {
    return result({ tone: "error", text: codeMessage("") });
  }
}
