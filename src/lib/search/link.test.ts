import { describe, expect, it } from "vitest";
import { MESSAGES_PER_PAGE } from "../conversations/queries";
import { linkFor, messagePage, searchLinkHref } from "./link";

describe("search links", () => {
  it.each([
    [1, 1],
    [MESSAGES_PER_PAGE, 1],
    [MESSAGES_PER_PAGE + 1, 2],
    [2 * MESSAGES_PER_PAGE, 2],
    [2 * MESSAGES_PER_PAGE + 1, 3],
  ])("message %d is on page %d", (n, page) => {
    expect(messagePage(n)).toBe(page);
  });

  it("builds the detail page's URL: page only after page 1, anchor per message, never hidden=show", () => {
    expect(searchLinkHref(linkFor("cabc123", 7))).toBe("/conversations/cabc123#m-7");
    expect(searchLinkHref(linkFor("cabc123", 1_500))).toBe("/conversations/cabc123?page=2#m-1500");
    expect(searchLinkHref(linkFor("cabc123", null))).toBe("/conversations/cabc123");
    expect(linkFor("cabc123", null)).toEqual({ conversationId: "cabc123", page: 1, messageNumber: null });
  });

  it("encodes the id defensively", () => {
    expect(searchLinkHref(linkFor("a/b?c#d", 1))).toBe("/conversations/a%2Fb%3Fc%23d#m-1");
  });
});
