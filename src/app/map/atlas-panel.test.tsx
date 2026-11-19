import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Atlas } from "@/lib/semantic/topics/atlas";
import { parseAtlasParams, selectionOf } from "@/lib/semantic/topics/atlas-view";
import { AtlasOutline } from "./atlas-outline";
import { AtlasPanel } from "./atlas-panel";

const c = (i: number) => ({ id: `c${i}`, title: i === 0 ? null : `Conversation ${i}`, updatedAtSec: null });
const many = Array.from({ length: 60 }, (_, i) => c(i));
const atlas: Pick<Atlas, "method" | "total" | "themes" | "other" | "ungrouped"> = {
  method: "topics",
  total: 61,
  themes: [
    {
      id: "th-a",
      name: "Food and cooking",
      nameSource: "vocabulary",
      typical: many,
      topics: [{ id: "th-a.tp-1", titles: ["Bread", "Rolls"], conversations: many.slice(0, 55) }],
      loose: many.slice(55),
    },
  ],
  other: [c(99)],
  ungrouped: [],
};
const render = (q: Record<string, string>) => {
  const params = parseAtlasParams(q);
  const selection = selectionOf(atlas, params);
  return { panel: renderToStaticMarkup(<AtlasPanel atlas={atlas} params={params} selection={selection} />), outline: renderToStaticMarkup(<AtlasOutline atlas={atlas} params={params} selection={selection} />) };
};

describe("AtlasPanel", () => {
  it("without a selection: a summary and how to choose", () => {
    const { panel } = render({});
    expect(panel).toContain(">All themes</h2>");
    expect(panel).toContain("61 conversations in 1 theme and 1 topic.");
  });

  it("a topic: a breadcrumb up to its theme, its first 50 conversations and Show all", () => {
    const { panel } = render({ theme: "th-a", topic: "th-a.tp-1" });
    expect(panel).toContain(">Bread / Rolls</h2>");
    expect(panel).toContain('href="/map?theme=th-a"');
    expect(panel.match(/href="\/conversations\//g)).toHaveLength(50);
    expect(panel).toContain('href="/map?theme=th-a&amp;topic=th-a.tp-1&amp;all=1"');
    expect(panel).toContain("Show all 55");
    expect(panel).toContain("Untitled conversation");
  });

  it("all=1 lists every conversation", () => {
    const { panel } = render({ theme: "th-a", topic: "th-a.tp-1", all: "1" });
    expect(panel.match(/href="\/conversations\//g)).toHaveLength(55);
    expect(panel).not.toContain("Show all");
  });

  it("a theme: its topics, then its most typical conversations; a polite status says what is shown", () => {
    const { panel } = render({ theme: "th-a" });
    expect(panel).toContain(">Topics</h3>");
    expect(panel).toContain(">Most typical conversations</h3>");
    expect(panel).toMatch(/role="status" aria-live="polite"[^>]*>60 conversations in 1 topic\./);
  });
});

describe("AtlasOutline", () => {
  it("lists themes; the selected theme opens to its topics and loose conversations; the current one is marked", () => {
    const none = render({}).outline;
    expect(none).toContain(">Food and cooking<");
    expect(none).not.toContain("Bread");
    const { outline } = render({ theme: "th-a", topic: "th-a.tp-1" });
    expect(outline).toMatch(/aria-current="page"[^>]*><span[^>]*>Bread</);
    expect(outline).toContain('title="Bread / Rolls"');
    expect(outline).toContain("Also in this theme");
    expect(outline).toContain('href="/map?theme=other"');
  });

  it("keeps the grouping method in every link", () => {
    expect(render({ method: "kmeans" }).outline).toContain('href="/map?method=kmeans&amp;theme=th-a"');
  });
});
