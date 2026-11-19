import { describe, expect, it } from "vitest";
import { linkFor } from "./link";
import type { SearchOutcome, SearchResultItem } from "./search";
import { pageArgument, toSearchView } from "./view";

const item = (over: Partial<SearchResultItem> = {}): SearchResultItem => ({
  conversationId: "cabc",
  title: "Plan <b>x</b>",
  titleSegments: [
    { text: "Plan", match: true },
    { text: " <b>x</b>", match: false },
  ],
  titleMatch: true,
  matchingMessages: 2,
  updatedAtSec: 1_767_225_600,
  score: -3.5,
  snippet: [{ text: "hit", match: true }],
  link: linkFor("cabc", 1_351),
  ...over,
});

describe("toSearchView", () => {
  it("keeps only what the page shows: segments, link, counts, date", () => {
    const outcome: SearchOutcome = { status: "ok", results: [item()], total: 41, page: 3, totalPages: 3 };
    const v = toSearchView(outcome);
    expect(v).toEqual({
      kind: "results",
      results: [
        {
          conversationId: "cabc",
          href: "/conversations/cabc?page=2#m-1351",
          title: item().titleSegments,
          titleMatch: true,
          matchingMessages: 2,
          messageNumber: 1_351,
          updated: expect.any(String),
          updatedIso: "2026-01-01T00:00:00.000Z",
          snippet: [{ text: "hit", match: true }],
          matchedBy: null,
          close: null,
        },
      ],
      total: 41,
      page: 3,
      totalPages: 3,
      first: 41,
      last: 41,
      notice: null,
    });
    expect(JSON.stringify(v)).not.toContain("score");
  });

  it("untitled and blank titles become null; missing dates stay null", () => {
    const v = toSearchView({
      status: "ok",
      results: [item({ title: null, titleSegments: null, updatedAtSec: null }), item({ conversationId: "c2", title: "   ", titleSegments: [{ text: "   ", match: false }] })],
      total: 2,
      page: 1,
      totalPages: 1,
    });
    if (v.kind !== "results") throw new Error("results");
    expect(v.results.map((r) => r.title)).toEqual([null, null]);
    expect(v.results.map((r) => r.messageNumber)).toEqual([1_351, 1_351]);
    expect(v.results[0]).toMatchObject({ updated: null, updatedIso: null });
    expect(v).toMatchObject({ first: 1, last: 2 });
  });

  it("a title-only match has no best-match position and links to the top", () => {
    const v = toSearchView({
      status: "ok",
      results: [item({ matchingMessages: 0, snippet: null, link: linkFor("cabc", null) })],
      total: 1,
      page: 1,
      totalPages: 1,
    });
    if (v.kind !== "results") throw new Error("results");
    expect(v.results[0]).toMatchObject({ messageNumber: null, href: "/conversations/cabc", snippet: null });
  });

  it("passes rejections and error codes through; an empty result has positions 0", () => {
    expect(toSearchView({ status: "invalid", rejection: { reason: "empty" } })).toEqual({ kind: "invalid", rejection: { reason: "empty" } });
    expect(toSearchView({ status: "error", code: "DB_NOT_MIGRATED" })).toEqual({ kind: "error", code: "DB_NOT_MIGRATED" });
    expect(toSearchView({ status: "ok", results: [], total: 0, page: 1, totalPages: 1 })).toMatchObject({ first: 0, last: 0 });
  });
});

describe("pageArgument", () => {
  it.each<[unknown, string]>([
    [1, "1"], [7, "7"], ["3", "3"], [1_000_000_000, "1000000000"],
    [0, "1"], [-2, "1"], [1.5, "1"], [Number.NaN, "1"], [Infinity, "1"], [1_000_000_001, "1"],
    ["", "1"], ["2.5", "1"], ["1e3", "1"], [" 2", "1"], ["9999999999", "1"],
    [null, "1"], [undefined, "1"], [["2"], "1"], [{ page: 2 }, "1"], [true, "1"],
  ])("pageArgument(%j) = %s", (raw, expected) => {
    expect(pageArgument(raw)).toBe(expected);
  });
});
