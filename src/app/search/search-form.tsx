"use client";

import Link from "next/link";
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore, type FormEvent, type RefObject } from "react";
import { HighlightedText } from "@/components/highlighted-text";
import { UNTITLED } from "@/lib/conversations/display";
import { createLatestGate } from "@/lib/search/latest";
import { LOADING_MODEL, matchedByLabel, noticeMessage, rejectionMessage, resultAnnouncement, searchErrorMessage, SEARCHING } from "@/lib/search/messages";
import { parseMeaningQuery, parseSearchQuery } from "@/lib/search/query";
import type { SearchView } from "@/lib/search/view";
import { searchAction } from "./actions";
import { BUTTON_PRIMARY, BUTTON_SECONDARY, LINK, NOTE } from "@/components/styles";

/**
 * The search form and results (M2.3; A101–A104).
 *
 * - Queries go to the Server Action as two plain values (query, page). They
 *   are never put in the URL, cookies or browser storage: the form posts
 *   nothing natively (submission is handled here, and the submit button stays
 *   disabled until hydration), and pagination calls the action again.
 * - The last query and page are remembered in this module's memory only, so
 *   they survive client-side navigation to a conversation and Back. On return
 *   the search is run again (results themselves are never kept). A reload
 *   clears it.
 * - Only the latest request may update the page (`createLatestGate`).
 * - Live regions announce counts and page positions only, never titles or
 *   snippets. Titles and snippets are React text with `<mark>`.
 */

export type SearchMode = "meaning" | "words";

let remembered: { query: string; page: number; mode: SearchMode } | null = null;

const noopSubscribe = () => () => {};
/** False during server rendering and hydration, true afterwards. */
const useHydrated = () => useSyncExternalStore(noopSubscribe, () => true, () => false);

type Results = Extract<SearchView, { kind: "results" }>;
type Outcome = { kind: "results"; view: Results; query: string } | { kind: "invalid"; message: string } | { kind: "error"; message: string };


const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export function SearchForm({ defaultMode = "words" }: { defaultMode?: SearchMode }) {
  const hydrated = useHydrated();
  const [gate] = useState(createLatestGate);
  const [query, setQuery] = useState(() => remembered?.query ?? "");
  const [mode, setMode] = useState<SearchMode>(() => remembered?.mode ?? defaultMode);
  // Search by meaning: after a second, say that the model may be loading.
  const [slow, setSlow] = useState(false);
  // A remembered search (Back from a conversation) starts out pending; the effect below runs it.
  const [pending, setPending] = useState(() => remembered !== null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [announcement, setAnnouncement] = useState(() => (remembered !== null ? SEARCHING : ""));
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusResults = useRef(false);

  /** From an event handler: validate, then start a request. */
  function run(q: string, page: number, focus: boolean, m: SearchMode = mode) {
    const parsed = m === "meaning" ? parseMeaningQuery(q) : parseSearchQuery(q);
    if (!parsed.ok) {
      gate.invalidate(); // a pending response must not replace this message
      remembered = null;
      setPending(false);
      setAnnouncement("");
      setOutcome({ kind: "invalid", message: rejectionMessage(parsed.rejection) });
      return;
    }
    remembered = { query: q, page, mode: m };
    setPending(true);
    setAnnouncement(SEARCHING);
    void complete(gate.begin(), q, page, focus, m);
  }

  /** Sends the request; state changes only after the response, and only for the latest ticket. */
  async function complete(ticket: number, q: string, page: number, focus: boolean, m: SearchMode) {
    let view: SearchView;
    const slowTimer = m === "meaning" ? setTimeout(() => gate.isLatest(ticket) && setSlow(true), 1_000) : undefined;
    try {
      view = await searchAction(q, page, m);
    } catch {
      view = { kind: "error", code: "INTERNAL_ERROR" };
    } finally {
      clearTimeout(slowTimer);
    }
    if (!gate.isLatest(ticket)) return; // a newer search started meanwhile
    setPending(false);
    setSlow(false);
    if (view.kind === "results") {
      remembered = { query: q, page: view.page, mode: m };
      focusResults.current = focus;
      setOutcome({ kind: "results", view, query: q });
      setAnnouncement(meaningAnnouncement(view) ?? resultAnnouncement(view));
    } else if (view.kind === "invalid") {
      setOutcome({ kind: "invalid", message: rejectionMessage(view.rejection) });
      setAnnouncement("");
    } else {
      setOutcome({ kind: "error", message: searchErrorMessage(view.code) });
      setAnnouncement("");
    }
  }

  // Back from a conversation: run the remembered search again (fresh results, focus left alone).
  const restore = useEffectEvent(() => {
    if (remembered) void complete(gate.begin(), remembered.query, remembered.page, false, remembered.mode);
  });
  useEffect(() => {
    restore();
    return () => gate.invalidate();
  }, [gate]);

  useEffect(() => {
    if (outcome?.kind === "results" && focusResults.current) {
      focusResults.current = false;
      headingRef.current?.focus();
    }
  }, [outcome]);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!hydrated) return;
    void run(query, 1, true);
  }

  const invalid = outcome?.kind === "invalid";

  return (
    <div className="mt-6">
      <form role="search" aria-label="Search conversations" method="post" onSubmit={onSubmit} noValidate className="flex flex-col gap-2">
        <label htmlFor="search-query" className="font-medium">
          Search conversations
        </label>
        <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <legend className="sr-only">Search by</legend>
          {(
            [
              ["meaning", "By meaning"],
              ["words", "Exact words"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex items-center gap-1.5">
              <input
                type="radio"
                name="search-mode"
                value={value}
                checked={mode === value}
                onChange={() => {
                  setMode(value);
                  setOutcome(null);
                  gate.invalidate();
                  setPending(false);
                  setSlow(false);
                }}
                className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
              />
              {label}
            </label>
          ))}
        </fieldset>
        <div className="flex flex-wrap gap-2">
          <input
            id="search-query"
            name="q"
            type="search"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? "search-help search-error" : "search-help"}
            className="min-w-0 flex-1 basis-64 rounded-md border border-neutral-300 bg-white px-3 py-2 text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 aria-invalid:border-red-600 dark:border-neutral-700 dark:bg-neutral-900"
          />
          <button type="submit" disabled={!hydrated || pending} className={BUTTON_PRIMARY}>
            {pending ? SEARCHING : "Search"}
          </button>
        </div>
        <p id="search-help" className="text-sm text-neutral-600 dark:text-neutral-400">
          {mode === "meaning" ? (
            <>
              Finds conversations about what you describe, in any language, even without the same words. Conversations that also contain
              every word rank higher. Up to 50 conversations.
            </>
          ) : (
            <>
              Searches titles and the messages each conversation shows. Every word must match. Use &quot;quotes&quot; for an exact phrase, and *
              after the last word to find words that start with it.
            </>
          )}
        </p>
        {slow && pending && (
          <p className="text-sm text-neutral-600 dark:text-neutral-400" data-testid="search-loading-model">
            {LOADING_MODEL}
          </p>
        )}
        {invalid && (
          <p id="search-error" role="alert" className="text-sm font-medium text-red-700 dark:text-red-400">
            {outcome.message}
          </p>
        )}
      </form>

      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>

      {outcome?.kind === "error" && (
        <p role="alert" className={`mt-8 ${NOTE.error}`}>
          {outcome.message}
        </p>
      )}

      {outcome?.kind === "results" && (
        <ResultsSection outcome={outcome} pending={pending} headingRef={headingRef} onPage={(p) => void run(outcome.query, p, true)} />
      )}
    </div>
  );
}

function ResultsSection({
  outcome,
  pending,
  headingRef,
  onPage,
}: {
  outcome: Extract<Outcome, { kind: "results" }>;
  pending: boolean;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onPage: (page: number) => void;
}) {
  const v = outcome.view;
  // Search by meaning: close matches first; the rest is in the same response, under "Other results".
  const meaning = v.results.some((r) => r.close !== null);
  const shown = meaning ? v.results.filter((r) => r.close) : v.results;
  const others = meaning ? v.results.filter((r) => !r.close) : [];
  const count = meaning ? shown.length : v.total;
  // Tied to this result set: a new search starts collapsed.
  const [expandedFor, setExpandedFor] = useState<Results | null>(null);
  const expanded = expandedFor === v;
  return (
    <section aria-labelledby="search-results-heading" aria-busy={pending} className="mt-8">
      <h2 id="search-results-heading" ref={headingRef} tabIndex={-1} className="text-xl font-semibold focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600">
        {count === 0 ? "No matching conversations" : plural(count, "matching conversation", "matching conversations")}
      </h2>
      {v.total === 0 && <Notice notice={v.notice} />}
      {v.total === 0 ? (
        <p className="mt-2 max-w-prose text-neutral-600 dark:text-neutral-400">
          Nothing matches <q className="font-medium text-neutral-900 dark:text-neutral-100">{outcome.query}</q>. Search covers titles and the messages
          each conversation shows; hidden messages and other branches are not searched.
        </p>
      ) : (
        <>
          {v.totalPages > 1 && (
            <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
              Results {v.first}–{v.last} of {v.total.toLocaleString("en-US")}
            </p>
          )}
          <Notice notice={v.notice} />
          <ol className={`mt-4 space-y-6 ${pending ? "opacity-60" : ""}`}>
            {shown.map((r) => (
              <ResultItem key={r.conversationId} r={r} />
            ))}
          </ol>
          {others.length > 0 && (
            <div className="mt-8">
              <button
                type="button"
                className={BUTTON_SECONDARY}
                aria-expanded={expanded}
                aria-controls="other-results"
                onClick={() => setExpandedFor(expanded ? null : v)}
              >
                {expanded ? "Hide other results" : `Other results (${others.length.toLocaleString("en-US")})`}
              </button>
              {expanded && (
                <ol id="other-results" aria-label="Other results" className={`mt-6 space-y-6 ${pending ? "opacity-60" : ""}`}>
                  {others.map((r) => (
                    <ResultItem key={r.conversationId} r={r} />
                  ))}
                </ol>
              )}
            </div>
          )}
          {v.totalPages > 1 && (
            <nav aria-label="Search result pages" className="mt-8 flex flex-wrap items-center gap-3">
              <button type="button" className={BUTTON_SECONDARY} disabled={pending || v.page <= 1} onClick={() => onPage(v.page - 1)}>
                Previous results
              </button>
              <span className="text-sm" aria-current="page">
                Page {v.page} of {v.totalPages}
              </span>
              <button type="button" className={BUTTON_SECONDARY} disabled={pending || v.page >= v.totalPages} onClick={() => onPage(v.page + 1)}>
                Next results
              </button>
            </nav>
          )}
        </>
      )}
    </section>
  );
}

/** Search by meaning's notice: exact words were used instead, or some conversations are not indexed yet. */
function Notice({ notice }: { notice: Results["notice"] }) {
  if (!notice) return null;
  const indexLink = notice.kind === "partial" || notice.reason === "INDEX_EMPTY" || notice.reason === "INDEX_INCOMPATIBLE";
  return (
    <p
      data-testid="search-notice"
      className={`mt-3 max-w-prose ${NOTE.warning}`}
    >
      {noticeMessage(notice)}
      {indexLink && (
        <>
          {" "}
          <Link href="/import" className={LINK}>
            Index them on the Import page.
          </Link>
        </>
      )}
    </p>
  );
}

function ResultItem({ r }: { r: Results["results"][number] }) {
  return (
    <li>
      <h3 className="text-lg break-words">
        <Link href={r.href} className={LINK}>
          {r.title === null ? UNTITLED : <HighlightedText segments={r.title} />}
        </Link>
      </h3>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        {[
          r.updated !== null ? (
            <span key="u">
              Updated <time dateTime={r.updatedIso ?? undefined}>{r.updated}</time>
            </span>
          ) : null,
          r.matchedBy !== null ? (
            <span key="w" data-testid="matched-by">
              {matchedByLabel(r.matchedBy)}
            </span>
          ) : null,
          r.titleMatch ? <span key="t">Title match</span> : null,
          r.matchingMessages > 0 ? <span key="m">{plural(r.matchingMessages, "matching message", "matching messages")}</span> : null,
          r.messageNumber !== null ? <span key="b">Best match: message {r.messageNumber.toLocaleString("en-US")}</span> : null,
        ]
          .filter((x) => x !== null)
          .flatMap((x, i) => (i === 0 ? [x] : [<span key={`s${i}`}> · </span>, x]))}
      </p>
      {r.snippet !== null && (
        <p className="mt-2 max-w-prose break-words text-neutral-800 dark:text-neutral-200">
          <HighlightedText segments={r.snippet} />
        </p>
      )}
    </li>
  );
}

/** Search by meaning: close matches and how many other results (counts only). */
function meaningAnnouncement(view: Results): string | null {
  if (!view.results.some((r) => r.close !== null)) return null;
  const close = view.results.filter((r) => r.close).length;
  const others = view.results.length - close;
  const main = close === 0 ? "No conversations match." : `${close.toLocaleString("en-US")} ${close === 1 ? "conversation matches" : "conversations match"}.`;
  return others > 0 ? `${main} ${others.toLocaleString("en-US")} other results.` : main;
}
