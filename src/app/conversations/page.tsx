import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { PageNav } from "@/components/page-nav";
import { getDb } from "@/lib/db/client";
import { displayTitle, formatEpochSeconds, isoFromEpochSeconds } from "@/lib/conversations/display";
import { CONVERSATIONS_PER_PAGE, listConversations, type ConversationList } from "@/lib/conversations/queries";
import { LINK } from "@/components/styles";

export const metadata: Metadata = { title: "Conversations" };

// Reads the database on every request; never prerendered at build time.
export const dynamic = "force-dynamic";


export default async function ConversationsPage({ searchParams }: PageProps<"/conversations">) {
  const { page } = await searchParams;
  let list: ConversationList;
  try {
    list = await listConversations(getDb(), page);
  } catch {
    return (
      <>
        <h1 className="text-3xl font-semibold tracking-tight">Conversations</h1>
        <p role="alert" className="mt-6">
          Conversations are not available: the database could not be read.
        </p>
      </>
    );
  }

  if (list.total === 0) {
    return (
      <>
        <h1 className="text-3xl font-semibold tracking-tight">Conversations</h1>
        <EmptyState title="No conversations yet">
          <p>
            Conversations appear here after you{" "}
            <Link href="/import" className={LINK}>
              import a ChatGPT export
            </Link>
            .
          </p>
        </EmptyState>
      </>
    );
  }

  const first = (list.page - 1) * CONVERSATIONS_PER_PAGE + 1;
  const last = first + list.items.length - 1;
  return (
    <>
      <h1 className="text-3xl font-semibold tracking-tight">Conversations</h1>
      <p className="mt-3 text-neutral-600 dark:text-neutral-400">
        {list.total} conversations, most recently updated first. Showing {first}–{last}.
      </p>
      <ol className="mt-6 divide-y divide-neutral-200 dark:divide-neutral-800" start={first}>
        {list.items.map((c) => {
          const updated = formatEpochSeconds(c.updatedAtSec);
          return (
            <li key={c.id} className="py-3">
              <Link href={`/conversations/${c.id}`} className={`${LINK} break-words`}>
                {displayTitle(c.title)}
              </Link>
              <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                {updated !== null ? (
                  <>
                    Updated <time dateTime={isoFromEpochSeconds(c.updatedAtSec)}>{updated}</time>
                  </>
                ) : (
                  "No update time"
                )}
                {" · "}
                {c.visibleMessageCount} {c.visibleMessageCount === 1 ? "message" : "messages"}
              </p>
            </li>
          );
        })}
      </ol>
      <PageNav
        label="Conversation pages"
        page={list.page}
        totalPages={list.totalPages}
        href={(p) => `/conversations?page=${p}`}
        previousText="Newer"
        nextText="Older"
      />
    </>
  );
}
