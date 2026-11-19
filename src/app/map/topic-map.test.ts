import { describe, expect, it } from "vitest";
import { FIT_MIN_ZOOM, layout, viewportFor, type AtlasMapData, type MapTheme } from "./topic-map";

const theme = (id: string, selected = false, topics = 0, more = 0): MapTheme => ({
  id,
  name: `Theme ${id}`,
  count: 10,
  href: `/map?theme=${id}`,
  selected,
  topics: Array.from({ length: topics }, (_, i) => ({ id: `${id}.tp-${i}`, label: `Topic ${i}`, fullName: `Topic ${i}`, count: 2, href: `/map?theme=${id}&topic=${id}.tp-${i}`, selected: false })),
  moreTopics: more,
  moreHref: more > 0 ? `/map?theme=${id}` : null,
});
const data = (themes: MapTheme[]): AtlasMapData => ({ total: 100, homeHref: "/map", themes });

describe("layout (the map)", () => {
  it("lists nodes in reading order: centre, then each theme followed by its topics", () => {
    const { nodes, edges } = layout(data([theme("a"), theme("b", true, 2, 3), theme("c")]));
    expect(nodes.map((n) => n.id)).toEqual(["root", "theme:a", "theme:b", "topic:b.tp-0", "topic:b.tp-1", "more:b", "theme:c"]);
    expect(edges.every((e) => e.focusable === false)).toBe(true); // no edge is a focus stop
  });

  it("puts themes on alternate sides, and a selected theme's topics beside it, outwards", () => {
    const { nodes } = layout(data([theme("a", true, 1), theme("b")]));
    const at = (id: string) => nodes.find((n) => n.id === id)!.position;
    expect(at("theme:a").x).toBeGreaterThan(0);
    expect(at("theme:b").x).toBeLessThan(0);
    expect(at("topic:a.tp-0").x).toBeGreaterThan(at("theme:a").x);
  });
});

describe("viewportFor", () => {
  it("fits what fits, centred, at most at maxZoom", () => {
    const { nodes } = layout(data([theme("a"), theme("b")]));
    const v = viewportFor(nodes, 1600, 900, { minZoom: 0.6, maxZoom: 1.1, padding: 0.05 })!;
    expect(v.zoom).toBe(1.1);
  });

  it("never zooms below the floor for a large selection, and keeps the selected theme's top in view", () => {
    const { nodes } = layout(data([theme("a", true, 12, 5)]));
    const selection = nodes.filter((n) => n.id !== "root");
    const v = viewportFor(selection, 800, 400, { minZoom: FIT_MIN_ZOOM, maxZoom: 1.1, padding: 0.05 })!;
    expect(v.zoom).toBe(FIT_MIN_ZOOM);
    const top = Math.min(...selection.map((n) => n.position.y - 20));
    expect(top * v.zoom + v.y).toBeGreaterThanOrEqual(0); // the top of the selection is on screen
  });

  it("does nothing for an empty or hidden canvas", () => {
    expect(viewportFor([], 800, 600, { minZoom: 0.6, maxZoom: 1, padding: 0 })).toBeNull();
    expect(viewportFor(layout(data([theme("a")])).nodes, 0, 0, { minZoom: 0.6, maxZoom: 1, padding: 0 })).toBeNull();
  });
});
