import { describe, expect, it } from "vitest";
import type { Atlas, AtlasTheme } from "./atlas";
import { atlasHref, parseAtlasParams, selectionConversations, selectionOf, topicName } from "./atlas-view";

const c = (id: string) => ({ id, title: id, updatedAtSec: null });
const theme: AtlasTheme = {
  id: "th-a",
  name: "Food and cooking",
  nameSource: "vocabulary",
  typical: [c("1"), c("2"), c("3")],
  topics: [{ id: "th-a.tp-x", titles: ["Bread", "Rolls"], conversations: [c("1"), c("2")] }],
  loose: [c("3")],
};
const atlas: Pick<Atlas, "themes" | "other" | "ungrouped"> = { themes: [theme], other: [c("9")], ungrouped: [] };

describe("parseAtlasParams and atlasHref", () => {
  it("round-trips a state, leaving defaults out of the URL", () => {
    const p = { method: "kmeans" as const, theme: "th-a", topic: "th-a.tp-x", view: "map" as const, all: true };
    expect(atlasHref(p)).toBe("/map?method=kmeans&theme=th-a&topic=th-a.tp-x&view=map&all=1");
    expect(parseAtlasParams(Object.fromEntries(new URLSearchParams(atlasHref(p).split("?")[1])))).toEqual(p);
    expect(atlasHref({})).toBe("/map");
    expect(atlasHref({ topic: "th-a.tp-x" })).toBe("/map"); // a topic needs its theme
  });

  it("ignores unknown or oversized values, and repeated parameters", () => {
    expect(parseAtlasParams({ method: "other", view: "grid", all: "yes", theme: ["a", "b"] })).toEqual({ method: "topics", theme: null, topic: null, view: "list", all: false });
    expect(parseAtlasParams({ theme: "x".repeat(201) }).theme).toBeNull();
  });

  it("reads earlier list links (view=list&open=…)", () => {
    expect(parseAtlasParams({ view: "list", open: "th-a.tp-x" })).toMatchObject({ theme: "th-a", topic: "th-a.tp-x" });
    expect(parseAtlasParams({ view: "list", open: "th-a" })).toMatchObject({ theme: "th-a", topic: null });
  });
});

describe("selectionOf", () => {
  const p = (theme: string | null, topic: string | null = null) => ({ ...parseAtlasParams({}), theme, topic });
  it("selects a theme, a topic, its loose conversations, Other, or nothing", () => {
    expect(selectionOf(atlas, p("th-a")).kind).toBe("theme");
    expect(selectionOf(atlas, p("th-a", "th-a.tp-x")).kind).toBe("topic");
    expect(selectionOf(atlas, p("th-a", "loose")).kind).toBe("loose");
    expect(selectionOf(atlas, p("other")).kind).toBe("other");
    expect(selectionOf(atlas, p("ungrouped")).kind).toBe("none"); // empty list
    expect(selectionOf(atlas, p("th-gone")).kind).toBe("none"); // a stale link selects nothing
    expect(selectionOf(atlas, p("th-a", "th-a.tp-gone")).kind).toBe("theme");
  });

  it("lists each selection's conversations", () => {
    expect(selectionConversations(atlas, selectionOf(atlas, p("th-a"))).map((x) => x.id)).toEqual(["1", "2", "3"]);
    expect(selectionConversations(atlas, selectionOf(atlas, p("th-a", "th-a.tp-x"))).map((x) => x.id)).toEqual(["1", "2"]);
    expect(selectionConversations(atlas, selectionOf(atlas, p("th-a", "loose"))).map((x) => x.id)).toEqual(["3"]);
    expect(selectionConversations(atlas, selectionOf(atlas, p(null)))).toEqual([]);
    expect(topicName(theme.topics[0]!)).toBe("Bread / Rolls");
  });
});
