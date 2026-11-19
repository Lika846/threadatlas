import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ConversationNotFound from "./not-found";

describe("conversation not-found page (M2.3)", () => {
  it("explains the missing conversation and links back to Search and the list", () => {
    const html = renderToStaticMarkup(<ConversationNotFound />);
    expect(html).toContain("<h1");
    expect(html).toContain("Conversation not found");
    expect(html).toContain("no longer exists");
    expect(html).toMatch(/href="\/search"[^>]*>Search again</);
    expect(html).toMatch(/href="\/conversations"[^>]*>All conversations</);
  });
});
