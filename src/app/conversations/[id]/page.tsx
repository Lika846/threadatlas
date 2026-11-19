import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { LinkedMessageMarker } from "@/components/linked-message-marker";
import { MessageView } from "@/components/message-view";
import { PageNav } from "@/components/page-nav";
import { getDb } from "@/lib/db/client";
import { displayTitle, formatEpochSeconds, isoFromEpochSeconds, pathNote } from "@/lib/conversations/display";
import { getConversationDetail, getConversationHeader, MESSAGES_PER_PAGE } from "@/lib/conversations/queries";
import { findRelated, type RelatedResult } from "@/lib/semantic/related/related";
import { RelatedConversations } from "./related-conversations";
import { LINK, MUTED, NOTE } from "@/components/styles";

// Reads the database on every request; never prerendered at build time.
export const dynamic = "force-dynamic";


/** One header query per request, shared by metadata and the page. */
const header = cache(async (id: string) => {
  try {
    return await getConversationHeader(getDb(), id);
  } catch {
    return undefined; // database unreadable (distinct from "not found")
  }
});

export async function generateMetadata({ params }: PageProps<"/conversations/[id]">): Promise<Metadata> {
  const { id } = await params;
  const h = await header(id);
  return { title: h ? displayTitle(h.title) : "Conversation" };
}

export default async function ConversationPage({ params, searchParams }: PageProps<"/conversations/[id]">) {
  const { id } = await params;
  const { page, hidden } = await searchParams;
  const includeHidden = hidden === "show";

  let detail: Awaited<ReturnType<typeof getConversationDetail>> | undefined;
  // Related conversations are optional: a failure there never affects the conversation itself.
  const related: Promise<RelatedResult | null> = findRelated(getDb(), id).catch(() => null);
  try {
    detail = await getConversationDetail(getDb(), id, { includeHidden, page });
  } catch {
    detail = undefined;
  }
  if (detail === null) notFound();
  if (detail === undefined) {
    return (
      <>
        <h1 className="text-3xl font-semibold tracking-tight">Conversation</h1>
        <p role="alert" className="mt-6">
          This conversation is not available: the database could not be read.
        </p>
      </>
    );
  }

  const { conversation: c, messages } = detail;
  const note = pathNote(c.pathStrategy);
  const created = formatEpochSeconds(c.createdAtSec);
  const updated = formatEpochSeconds(c.updatedAtSec);
  const base = `/conversations/${c.id}`;
  const href = (p: number, show = includeHidden) => {
    const q = new URLSearchParams();
    if (show) q.set("hidden", "show");
    if (p > 1) q.set("page", String(p));
    const s = q.toString();
    return s ? `${base}?${s}` : base;
  };
  const first = messages[0]?.number ?? 0;
  const last = messages[messages.length - 1]?.number ?? 0;

  const relatedResult = await related;
  const relatedCount = relatedResult?.status === "ok" ? relatedResult.related.length : 0;

  // Wide screens: the conversation in a reading column, related conversations in a column
  // beside it (sticky). In the page's order (phones, screen readers) the conversation comes
  // first and related conversations after it, with a link to them near the top.
  return (
    <div data-layout="wide" className="lg:grid lg:grid-cols-[minmax(0,46rem)_18rem] lg:gap-x-12">
      <div className="min-w-0">
        <p>
          <Link href="/conversations" className={LINK}>
            All conversations
          </Link>
        </p>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight text-balance break-words">{displayTitle(c.title)}</h1>
        <p className={`mt-2 ${MUTED}`}>
          {created !== null && (
            <>
              Created <time dateTime={isoFromEpochSeconds(c.createdAtSec)}>{created}</time>
              {" · "}
            </>
          )}
          {updated !== null && (
            <>
              Updated <time dateTime={isoFromEpochSeconds(c.updatedAtSec)}>{updated}</time>
              {" · "}
            </>
          )}
          {c.visibleMessageCount} {c.visibleMessageCount === 1 ? "message" : "messages"}
        </p>
        {relatedCount > 0 && (
          <p className="mt-2 text-sm lg:hidden">
            <a href="#related-title" className={LINK}>
              {relatedCount} related {relatedCount === 1 ? "conversation" : "conversations"}
            </a>
          </p>
        )}
        {note !== null && <p className={`mt-4 ${NOTE.warning}`}>{note}</p>}
        {detail.hiddenCount > 0 && (
          <p className="mt-4 text-sm">
            {includeHidden ? (
              <Link href={href(1, false)} className={LINK}>
                Hide {detail.hiddenCount} hidden {detail.hiddenCount === 1 ? "message" : "messages"}
              </Link>
            ) : (
              <Link href={href(1, true)} className={LINK}>
                Show {detail.hiddenCount} hidden {detail.hiddenCount === 1 ? "message" : "messages"}
              </Link>
            )}
            <span className="text-neutral-600 dark:text-neutral-400"> (system messages and messages marked hidden in the export)</span>
          </p>
        )}

        {messages.length === 0 ? (
          <p className="mt-8 text-neutral-600 dark:text-neutral-400">There are no messages to show on this conversation&apos;s path.</p>
        ) : (
          <section aria-labelledby="messages-title" className="mt-8">
            <h2 id="messages-title" className="sr-only">
              Messages
            </h2>
            {detail.totalPages > 1 && (
              <p className={MUTED}>
                Messages {first}–{last} of {detail.displayedCount} ({MESSAGES_PER_PAGE} per page)
              </p>
            )}
            <PageNav label="Message pages" page={detail.page} totalPages={detail.totalPages} href={(p) => href(p)} previousText="Previous messages" nextText="Next messages" />
            <LinkedMessageMarker />
            <ol className="mt-4 space-y-6">
              {messages.map((m) => (
                <li key={m.sourceNodeId}>
                  <MessageView message={m} />
                </li>
              ))}
            </ol>
            <PageNav label="Message pages, bottom" page={detail.page} totalPages={detail.totalPages} href={(p) => href(p)} previousText="Previous messages" nextText="Next messages" />
          </section>
        )}
      </div>
      <aside aria-label="Related conversations" className="mt-10 lg:sticky lg:top-6 lg:col-start-2 lg:row-start-1 lg:mt-0 lg:max-h-[calc(100vh-3rem)] lg:self-start lg:overflow-y-auto">
        <RelatedConversations result={relatedResult} />
      </aside>
    </div>
  );
}
