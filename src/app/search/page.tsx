import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { getDb } from "@/lib/db/client";
import { defaultSearchMode } from "@/lib/semantic/search/meaning-search";
import { SearchForm } from "./search-form";
import { LINK, NOTE } from "@/components/styles";

export const metadata: Metadata = { title: "Search" };

// Reads the database on every request; never prerendered at build time.
export const dynamic = "force-dynamic";


/**
 * Search (M2.3; by meaning since M5.2). The page itself never receives a query: searches go
 * to a Server Action from the client form, so search terms never appear in
 * this page's URL. Search needs JavaScript.
 */
export default async function SearchPage() {
  let count: number | null;
  try {
    count = await getDb().conversation.count();
  } catch {
    count = null;
  }
  const mode = count ? await defaultSearchMode(getDb()) : "words";
  return (
    <>
      <h1 className="text-3xl font-semibold tracking-tight">Search</h1>
      {count === null ? (
        <p role="alert" className="mt-6">
          Search is not available: the database could not be read.
        </p>
      ) : count === 0 ? (
        <EmptyState title="Nothing to search yet">
          <p>
            Search looks through your conversations after you{" "}
            <Link href="/import" className={LINK}>
              import a ChatGPT export
            </Link>
            .
          </p>
        </EmptyState>
      ) : (
        <>
          <noscript>
            <p className={`mt-6 ${NOTE.warning}`}>
              Search needs JavaScript. Turn it on for this page to search your conversations; browsing them works without it.
            </p>
          </noscript>
          <SearchForm defaultMode={mode} />
        </>
      )}
    </>
  );
}
