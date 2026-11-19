/**
 * The map page's state in its URL (phase 2): which grouping, which theme or topic is selected,
 * and which view small screens show. Pure; shared by the page, the outline, the panel and the
 * map, so they always agree. Back and reload restore everything, because the page renders
 * from these parameters alone.
 *
 * - `method=kmeans`: the k-means baseline (default: themes → topics).
 * - `theme=<id>`: a theme, or `other` / `ungrouped` for those lists.
 * - `topic=<id>`: a topic of the selected theme (`loose` for its conversations in no topic).
 * - `view=map`: small screens show the map instead of the list (large screens show both).
 * - `all=1`: the panel lists every conversation of the selection, not the first `PANEL_LIMIT`.
 * - Earlier links (`view=list&open=<id>`) still open the theme or topic they named.
 */
import type { Atlas, AtlasMethod, AtlasTheme, AtlasTopic } from "./atlas.ts";
import type { TopicConversation } from "./topics.ts";

/** Conversations the panel lists before "Show all". */
export const PANEL_LIMIT = 50;

export type AtlasParams = { method: AtlasMethod; theme: string | null; topic: string | null; view: "list" | "map"; all: boolean };

type Raw = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | null => (typeof v === "string" && v.length <= 200 ? v : null);

/** Reads the parameters (unknown values are ignored, never echoed). */
export function parseAtlasParams(raw: Raw): AtlasParams {
  const method: AtlasMethod = one(raw.method) === "kmeans" ? "kmeans" : "topics";
  let theme = one(raw.theme);
  let topic = one(raw.topic);
  const open = one(raw.open);
  if (theme === null && open !== null) {
    // An earlier list link: a topic id starts with its theme's id ("th-….tp-…").
    const dot = open.indexOf(".tp-");
    theme = dot > 0 ? open.slice(0, dot) : open;
    topic = dot > 0 ? open : null;
  }
  return { method, theme, topic: theme === null ? null : topic, view: one(raw.view) === "map" ? "map" : "list", all: one(raw.all) === "1" };
}

/** The URL of a state; parameters at their defaults are left out. */
export function atlasHref(p: Partial<AtlasParams>): string {
  const q = new URLSearchParams();
  if (p.method === "kmeans") q.set("method", "kmeans");
  if (p.theme) q.set("theme", p.theme);
  if (p.theme && p.topic) q.set("topic", p.topic);
  if (p.view === "map") q.set("view", "map");
  if (p.all) q.set("all", "1");
  const s = q.toString();
  return s ? `/map?${s}` : "/map";
}

export type Selection =
  | { kind: "none" }
  | { kind: "theme"; theme: AtlasTheme }
  | { kind: "topic"; theme: AtlasTheme; topic: AtlasTopic }
  | { kind: "loose"; theme: AtlasTheme }
  | { kind: "other" }
  | { kind: "ungrouped" };

/** What the parameters select in this atlas; an id that no longer exists selects nothing. */
export function selectionOf(atlas: Pick<Atlas, "themes" | "other" | "ungrouped">, p: AtlasParams): Selection {
  if (p.theme === "other" && atlas.other.length > 0) return { kind: "other" };
  if (p.theme === "ungrouped" && atlas.ungrouped.length > 0) return { kind: "ungrouped" };
  const theme = atlas.themes.find((t) => t.id === p.theme);
  if (!theme) return { kind: "none" };
  if (p.topic === "loose" && theme.loose.length > 0 && theme.topics.length > 0) return { kind: "loose", theme };
  const topic = theme.topics.find((t) => t.id === p.topic);
  return topic ? { kind: "topic", theme, topic } : { kind: "theme", theme };
}

/** The conversations the panel lists for a selection, in its order. */
export function selectionConversations(atlas: Pick<Atlas, "other" | "ungrouped">, s: Selection): readonly TopicConversation[] {
  switch (s.kind) {
    case "theme":
      return s.theme.typical;
    case "topic":
      return s.topic.conversations;
    case "loose":
      return s.theme.loose;
    case "other":
      return atlas.other;
    case "ungrouped":
      return atlas.ungrouped;
    default:
      return [];
  }
}

/** A topic's display name: its two most typical titles. */
export function topicName(t: Pick<AtlasTopic, "titles">): string {
  return t.titles.length > 0 ? t.titles.join(" / ") : "Untitled conversations";
}
