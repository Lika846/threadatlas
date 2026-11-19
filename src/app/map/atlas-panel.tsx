import Link from "next/link";
import { displayTitle, formatEpochSeconds, isoFromEpochSeconds } from "@/lib/conversations/display";
import type { Atlas } from "@/lib/semantic/topics/atlas";
import { atlasHref, PANEL_LIMIT, selectionConversations, topicName, type AtlasParams, type Selection } from "@/lib/semantic/topics/atlas-view";
import { LINK, MUTED } from "@/components/styles";

/**
 * The selected theme's or topic's conversations, next to the map (phase 2), with a way back up.
 * Server-rendered from the URL. A polite status line says what is shown, so a selection made in
 * the map or the outline is announced. Titles are imported text, rendered as text.
 */

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

function heading(s: Selection): { title: string; parent: { label: string; href: (p: AtlasParams) => string } | null } {
  switch (s.kind) {
    case "theme":
      return { title: s.theme.name, parent: null };
    case "topic":
      return { title: topicName(s.topic), parent: { label: s.theme.name, href: (p) => atlasHref({ method: p.method, view: p.view, theme: s.theme.id }) } };
    case "loose":
      return { title: `Also in ${s.theme.name}`, parent: { label: s.theme.name, href: (p) => atlasHref({ method: p.method, view: p.view, theme: s.theme.id }) } };
    case "other":
      return { title: "Other", parent: null };
    case "ungrouped":
      return { title: "Not grouped yet", parent: null };
    default:
      return { title: "All themes", parent: null };
  }
}

export function AtlasPanel({ atlas, params, selection }: { atlas: Pick<Atlas, "method" | "total" | "themes" | "other" | "ungrouped">; params: AtlasParams; selection: Selection }) {
  const { title, parent } = heading(selection);
  const conversations = selectionConversations(atlas, selection);
  const shown = params.all ? conversations : conversations.slice(0, PANEL_LIMIT);
  const home = atlasHref({ method: params.method, view: params.view });
  const topics = atlas.themes.reduce((n, t) => n + t.topics.length, 0);
  return (
    <section aria-labelledby="atlas-panel-title" data-testid="atlas-panel">
      <nav aria-label="Map breadcrumb" className={MUTED}>
        <ol className="flex flex-wrap gap-x-1">
          <li>
            {selection.kind === "none" ? (
              <span>All themes</span>
            ) : (
              <Link href={home} scroll={false} className={LINK}>
                All themes
              </Link>
            )}
          </li>
          {parent && (
            <li>
              <span aria-hidden="true">› </span>
              <Link href={parent.href(params)} scroll={false} className={LINK}>
                {parent.label}
              </Link>
            </li>
          )}
        </ol>
      </nav>
      <h2 id="atlas-panel-title" className="mt-2 text-lg font-semibold break-words">
        {title}
      </h2>
      <p role="status" aria-live="polite" className={MUTED}>
        {selection.kind === "none"
          ? `${plural(atlas.total, "conversation", "conversations")} in ${plural(atlas.themes.length, "theme", "themes")}${topics > 0 ? ` and ${plural(topics, "topic", "topics")}` : ""}.`
          : selection.kind === "theme" && selection.theme.topics.length > 0
            ? `${plural(conversations.length, "conversation", "conversations")} in ${plural(selection.theme.topics.length, "topic", "topics")}.`
            : `${plural(conversations.length, "conversation", "conversations")}.`}
      </p>

      {selection.kind === "none" ? (
        <p className={`mt-3 ${MUTED}`}>Select a theme on the map or in the list to see its topics and conversations.</p>
      ) : (
        <>
          {selection.kind === "theme" && selection.theme.topics.length > 0 && (
            <>
              <h3 className="mt-4 text-sm font-semibold">Topics</h3>
              <ul className="mt-1 space-y-1">
                {selection.theme.topics.map((p) => (
                  <li key={p.id} className="text-sm break-words">
                    <Link href={atlasHref({ method: params.method, view: params.view, theme: selection.theme.id, topic: p.id })} scroll={false} className={LINK}>
                      {topicName(p)}
                    </Link>{" "}
                    <span className={MUTED}>({p.conversations.length.toLocaleString("en-US")})</span>
                  </li>
                ))}
              </ul>
              <h3 className="mt-4 text-sm font-semibold">{selection.theme.topics.length > 0 ? "Most typical conversations" : "Conversations"}</h3>
            </>
          )}
          <ol className="mt-2 space-y-2" aria-label="Conversations">
            {shown.map((c) => {
              const updated = formatEpochSeconds(c.updatedAtSec);
              return (
                <li key={c.id} className="break-words">
                  <Link href={`/conversations/${encodeURIComponent(c.id)}`} className={LINK}>
                    {displayTitle(c.title)}
                  </Link>
                  {updated && (
                    <span className={`block ${MUTED}`}>
                      <time dateTime={isoFromEpochSeconds(c.updatedAtSec)}>{updated}</time>
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
          {conversations.length > shown.length && (
            <p className="mt-3 text-sm">
              <Link href={atlasHref({ ...params, all: true })} scroll={false} className={LINK}>
                Show all {conversations.length.toLocaleString("en-US")}
              </Link>
            </p>
          )}
        </>
      )}
    </section>
  );
}
