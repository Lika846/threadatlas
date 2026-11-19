import Link from "next/link";
import type { Atlas } from "@/lib/semantic/topics/atlas";
import { atlasHref, topicName, type AtlasParams, type Selection } from "@/lib/semantic/topics/atlas-view";

/**
 * The atlas as an outline of links (phase 2): every theme, the selected theme's topics, and the
 * Other and Not-grouped lists. The same data and URLs as the map, so the two always agree; it is
 * the map's accessible equivalent and, on small screens, the main view. Server-rendered: works
 * with a keyboard, a screen reader and without JavaScript.
 */

const ITEM =
  "flex items-baseline gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:hover:bg-neutral-800";
const CURRENT = "bg-neutral-900 font-semibold text-white hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200";
const COUNT = "ml-auto shrink-0 text-xs tabular-nums opacity-80";

function Item({ href, current, label, count, title }: { href: string; current: boolean; label: string; count: number; title?: string }) {
  return (
    <Link href={href} scroll={false} title={title} aria-current={current ? "page" : undefined} className={`${ITEM} ${current ? CURRENT : ""}`}>
      <span className="min-w-0 break-words">{label}</span>
      <span className={COUNT}>{count.toLocaleString("en-US")}</span>
    </Link>
  );
}

export function AtlasOutline({ atlas, params, selection }: { atlas: Pick<Atlas, "method" | "themes" | "other" | "ungrouped">; params: AtlasParams; selection: Selection }) {
  const base = { method: params.method, view: params.view };
  const selectedTheme = selection.kind === "theme" || selection.kind === "topic" || selection.kind === "loose" ? selection.theme.id : null;
  return (
    <nav aria-label="Themes" data-testid="atlas-outline">
      <h2 className="px-2 text-sm font-semibold text-neutral-600 dark:text-neutral-400">
        {atlas.themes.length.toLocaleString("en-US")} {atlas.themes.length === 1 ? "theme" : "themes"}
      </h2>
      <ol className="mt-1 space-y-0.5">
        {atlas.themes.map((t) => (
          <li key={t.id}>
            <Item href={atlasHref({ ...base, theme: t.id })} current={selection.kind === "theme" && selectedTheme === t.id} label={t.name} count={t.typical.length} />
            {selectedTheme === t.id && t.topics.length > 0 && (
              <ol aria-label={`Topics in ${t.name}`} className="mt-0.5 mb-2 ml-3 space-y-0.5 border-l border-neutral-200 pl-2 dark:border-neutral-800">
                {t.topics.map((p) => (
                  <li key={p.id}>
                    <Item href={atlasHref({ ...base, theme: t.id, topic: p.id })} current={selection.kind === "topic" && selection.topic.id === p.id} label={p.titles[0] ?? "Untitled conversations"} title={topicName(p)} count={p.conversations.length} />
                  </li>
                ))}
                {t.loose.length > 0 && (
                  <li>
                    <Item href={atlasHref({ ...base, theme: t.id, topic: "loose" })} current={selection.kind === "loose"} label="Also in this theme" count={t.loose.length} />
                  </li>
                )}
              </ol>
            )}
          </li>
        ))}
      </ol>
      {(atlas.other.length > 0 || atlas.ungrouped.length > 0) && (
        <ul className="mt-3 space-y-0.5 border-t border-neutral-200 pt-3 dark:border-neutral-800">
          {atlas.other.length > 0 && (
            <li>
              <Item href={atlasHref({ ...base, theme: "other" })} current={selection.kind === "other"} label="Other" count={atlas.other.length} />
            </li>
          )}
          {atlas.ungrouped.length > 0 && (
            <li>
              <Item href={atlasHref({ ...base, theme: "ungrouped" })} current={selection.kind === "ungrouped"} label="Not grouped yet" count={atlas.ungrouped.length} />
            </li>
          )}
        </ul>
      )}
    </nav>
  );
}
