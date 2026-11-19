import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { EmptyState } from "@/components/empty-state";
import { getDb } from "@/lib/db/client";
import { buildAtlas, type Atlas } from "@/lib/semantic/topics/atlas";
import { atlasHref, parseAtlasParams, selectionOf, topicName, type AtlasParams, type Selection } from "@/lib/semantic/topics/atlas-view";
import { AtlasOutline } from "./atlas-outline";
import { AtlasPanel } from "./atlas-panel";
import { TopicMapView, type AtlasMapData } from "./topic-map";
import { LINK, NOTE } from "@/components/styles";

export const metadata: Metadata = { title: "Map" };

// Reads the database on every request; never prerendered at build time.
export const dynamic = "force-dynamic";

/** Topics drawn beside a selected theme; the rest are in the outline and the panel. */
export const MAP_TOPICS = 12;

const TAB = "rounded-md px-3 py-1.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600";
const NOTE_BOX = `mt-4 max-w-prose ${NOTE.warning}`;

/** The map's data: themes, and the selected theme's first topics. Same URLs as the outline. */
function mapData(atlas: Atlas, params: AtlasParams, selection: Selection): AtlasMapData {
  const base = { method: params.method, view: params.view };
  const selectedTheme = selection.kind === "theme" || selection.kind === "topic" || selection.kind === "loose" ? selection.theme.id : null;
  return {
    total: atlas.themes.reduce((n, t) => n + t.typical.length, 0),
    homeHref: atlasHref(base),
    themes: atlas.themes.map((t) => {
      const selected = t.id === selectedTheme;
      const topics = selected ? t.topics.slice(0, MAP_TOPICS) : [];
      return {
        id: t.id,
        name: t.name,
        count: t.typical.length,
        href: atlasHref({ ...base, theme: t.id }),
        selected,
        topics: topics.map((p) => ({
          id: p.id,
          label: p.titles[0] ?? "Untitled conversations",
          fullName: topicName(p),
          count: p.conversations.length,
          href: atlasHref({ ...base, theme: t.id, topic: p.id }),
          selected: selection.kind === "topic" && selection.topic.id === p.id,
        })),
        moreTopics: selected ? Math.max(0, t.topics.length - MAP_TOPICS) : 0,
        moreHref: selected ? atlasHref({ ...base, theme: t.id }) : null,
      };
    }),
  };
}

function NotIndexedYet({ count }: { count: number }) {
  return (
    <p className={NOTE_BOX}>
      {count.toLocaleString("en-US")} {count === 1 ? "conversation isn't" : "conversations aren't"} indexed yet, so{" "}
      {count === 1 ? "it isn't" : "they aren't"} on the map.{" "}
      <Link href="/import" className={LINK}>
        Index {count === 1 ? "it" : "them"} on the Import page
      </Link>
      .
    </p>
  );
}

function NotIndexed() {
  return (
    <p className={NOTE_BOX}>
      Your conversations aren&apos;t indexed yet, so they can&apos;t be grouped.{" "}
      <Link href="/import" className={LINK}>
        Index them on the Import page
      </Link>
      , then come back.
    </p>
  );
}

function tabClass(current: boolean): string {
  return `${TAB} ${current ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900" : "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"}`;
}

/**
 * The map (phase 2): the outline of themes and topics, the map, and the selected theme's or
 * topic's conversations, side by side on wide screens. Small screens (and 200% zoom) show the
 * list first: the outline, or the selection's conversations once something is selected, with
 * the map one tap away (`?view=map`). Everything is in the URL (`atlas-view.ts`).
 * `?method=kmeans` shows the k-means baseline. Nothing is stored and no model runs.
 */
export default async function MapPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = parseAtlasParams(await searchParams);
  // The header renders at once; the atlas streams in when ready (the first time after indexing,
  // its tree takes a few seconds in a worker thread, `hierarchy-host.ts`).
  return (
    <div data-layout="wide">
      <h1 className="text-3xl font-semibold tracking-tight">Map</h1>
      <p className="mt-2 max-w-prose text-neutral-600 dark:text-neutral-400">
        Your conversations grouped by meaning into themes and topics, in any language. A rough guide for exploring, not categories.
      </p>
      <Suspense
        fallback={
          <p role="status" className="mt-6 text-neutral-600 dark:text-neutral-400" data-testid="atlas-preparing">
            Preparing the map…
          </p>
        }
      >
        <AtlasBody params={params} />
      </Suspense>
    </div>
  );
}

async function AtlasBody({ params }: { params: AtlasParams }) {
  let atlas: Atlas | null;
  try {
    atlas = await buildAtlas(getDb(), { method: params.method });
  } catch {
    atlas = null;
  }
  if (atlas === null)
    return (
      <>
        <p role="alert" className="mt-6">
          The map is not available: the database could not be read.
        </p>
      </>
    );
  if (atlas.total === 0)
    return (
      <>
        <EmptyState title="Nothing to map yet">
          <p>
            The map shows your conversations after you{" "}
            <Link href="/import" className={LINK}>
              import a ChatGPT export
            </Link>
            .
          </p>
        </EmptyState>
      </>
    );
  if (!atlas.indexed || atlas.themes.length === 0)
    return (
      <>
        <NotIndexed />
      </>
    );

  const selection = selectionOf(atlas, params);
  const selected = selection.kind !== "none";
  const showMap = params.view === "map";
  // Small screens: one of outline, panel or map; large screens: all three.
  const outlineClass = showMap || selected ? "hidden lg:block" : "block";
  const panelClass = showMap || !selected ? "hidden lg:block" : "block";
  const mapClass = showMap ? "block" : "hidden lg:block";
  return (
    <>
      {atlas.ungrouped.length > 0 && <NotIndexedYet count={atlas.ungrouped.length} />}
      <nav aria-label="Map view" className="mt-4 flex flex-wrap gap-1 lg:hidden">
        <Link href={atlasHref({ ...params, view: "list", all: false })} scroll={false} aria-current={!showMap ? "page" : undefined} className={tabClass(!showMap)}>
          List
        </Link>
        {/* The map starts low on small screens and at 200% zoom: `#map` scrolls it into view. */}
        <Link href={`${atlasHref({ ...params, view: "map", all: false })}#map`} aria-current={showMap ? "page" : undefined} className={tabClass(showMap)}>
          Map
        </Link>
      </nav>
      <div className="mt-4 gap-6 lg:grid lg:grid-cols-[16rem_minmax(0,1fr)_20rem]">
        <div className={`${outlineClass} lg:max-h-[calc(100vh-14rem)] lg:overflow-y-auto lg:pr-1`}>
          <AtlasOutline atlas={atlas} params={params} selection={selection} />
          <p className="mt-4 px-2 text-sm text-neutral-600 dark:text-neutral-400">
            {params.method === "kmeans" ? (
              <>
                Showing the k-means baseline (one level, without the language correction).{" "}
                <Link href={atlasHref({ view: params.view })} className={LINK}>
                  Back to themes and topics
                </Link>
                .
              </>
            ) : (
              <>
                <Link href={atlasHref({ method: "kmeans", view: params.view })} className={LINK}>
                  Compare with the k-means baseline
                </Link>{" "}
                (the earlier one-level grouping).
              </>
            )}
          </p>
        </div>
        <div id="map" className={`${mapClass} scroll-mt-2`}>
          <noscript>
            <p className={NOTE_BOX}>The map needs JavaScript; the list next to it has the same themes and topics.</p>
          </noscript>
          <TopicMapView data={mapData(atlas, params, selection)} className="h-[70vh] min-h-[24rem] lg:h-[calc(100vh-14rem)]" />
        </div>
        <div className={`${panelClass} mt-6 lg:mt-0 lg:max-h-[calc(100vh-14rem)] lg:overflow-y-auto`}>
          <AtlasPanel atlas={atlas} params={params} selection={selection} />
        </div>
      </div>
    </>
  );
}
