import Link from "next/link";
import { displayTitle, formatEpochSeconds, isoFromEpochSeconds } from "@/lib/conversations/display";
import type { RelatedPassage, RelatedResult } from "@/lib/semantic/related/related";
import { FOCUS, LINK, MUTED } from "@/components/styles";

/**
 * "Related conversations" on the conversation page (knowledge-graph MVP, step 1): up to five
 * conversations close in meaning, most similar first, each with a passage from both
 * conversations that explains the link when one is informative. Server-rendered: native
 * links and disclosure widgets, so it works with a keyboard, a screen reader and without
 * JavaScript. Passages are imported text, rendered as text (never as HTML).
 */


function Passage({ label, passage }: { label: string; passage: RelatedPassage }) {
  return (
    <figure className="mt-2">
      <figcaption className={MUTED}>
        {label} ·{" "}
        <Link href={passage.href} className={LINK}>
          message {passage.messageNumber.toLocaleString("en-US")}
        </Link>
      </figcaption>
      <blockquote className="mt-1 border-l-2 border-neutral-300 pl-3 text-sm break-words whitespace-pre-wrap dark:border-neutral-700">{passage.text}</blockquote>
    </figure>
  );
}

function Body({ result }: { result: RelatedResult | null }) {
  if (result === null) return <p className={MUTED}>Related conversations could not be loaded.</p>;
  if (result.status === "no-index")
    return (
      <p className={MUTED}>
        Related conversations are found by meaning once your conversations are indexed.{" "}
        <Link href="/import" className={LINK}>
          Index them on the Import page
        </Link>
        .
      </p>
    );
  if (result.status === "not-indexed")
    return (
      <p className={MUTED}>
        This conversation isn&apos;t in the semantic index (it may not be indexed yet, or has no text to compare), so related
        conversations can&apos;t be found.{" "}
        <Link href="/import" className={LINK}>
          Index it on the Import page
        </Link>
        .
      </p>
    );
  if (result.related.length === 0) return <p className={MUTED}>No close conversations.</p>;
  return (
    <ol className="space-y-3">
      {result.related.map((r) => {
        const updated = formatEpochSeconds(r.updatedAtSec);
        return (
          <li key={r.id} className="break-words">
            <Link href={`/conversations/${encodeURIComponent(r.id)}`} className={LINK}>
              {displayTitle(r.title)}
            </Link>
            {updated && (
              <span className={MUTED}>
                {" · "}
                <time dateTime={isoFromEpochSeconds(r.updatedAtSec)}>{updated}</time>
              </span>
            )}
            {r.evidence && (
              <details className="mt-1">
                <summary className={`cursor-pointer rounded text-sm text-neutral-700 hover:text-neutral-950 dark:text-neutral-300 dark:hover:text-white ${FOCUS}`}>
                  Why related
                </summary>
                <Passage label="This conversation" passage={r.evidence.focus} />
                <Passage label="The related one" passage={r.evidence.other} />
              </details>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function RelatedConversations({ result }: { result: RelatedResult | null }) {
  return (
    <section aria-labelledby="related-title" className="border-t border-neutral-200 pt-6 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6 dark:border-neutral-800" data-testid="related-conversations">
      <h2 id="related-title" className="text-base font-semibold" tabIndex={-1}>
        Related conversations
      </h2>
      <p className={`mb-3 ${MUTED}`}>Close in meaning, most similar first. Found automatically, so some links may be loose.</p>
      <Body result={result} />
    </section>
  );
}
