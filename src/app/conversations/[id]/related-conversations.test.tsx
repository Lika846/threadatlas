import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RelatedResult } from "@/lib/semantic/related/related";
import { RelatedConversations } from "./related-conversations";

const html = (result: RelatedResult | null) => renderToStaticMarkup(<RelatedConversations result={result} />);

describe("RelatedConversations", () => {
  it("lists related conversations in the given order, with links, and the passages under 'Why related'", () => {
    const out = html({
      status: "ok",
      related: [
        {
          id: "c2",
          title: "Hiking boots or trail runners",
          updatedAtSec: 1_700_000_000,
          similarity: 0.53,
          evidence: {
            focus: { text: "… Trail shoes grip better on wet rock …", messageNumber: 2, href: "/conversations/c1#m-2" },
            other: { text: "Boots support the ankle on long descents", messageNumber: 4, href: "/conversations/c2#m-4" },
          },
        },
        { id: "c3", title: null, updatedAtSec: null, similarity: 0.4, evidence: null },
      ],
    });
    expect(out).toContain('<h2 id="related-title"');
    expect(out).toContain('href="/conversations/c2"');
    expect(out.indexOf("/conversations/c2")).toBeLessThan(out.indexOf("/conversations/c3"));
    expect(out).toContain("Untitled conversation");
    expect(out.match(/<details/g)).toHaveLength(1); // only the link with evidence
    expect(out).toContain("Why related");
    expect(out).toContain('href="/conversations/c1#m-2"');
    expect(out).toContain('href="/conversations/c2#m-4"');
    expect(out).toContain("message 4");
    expect(out).not.toContain("0.53"); // no scores or confidence labels yet
  });

  it("renders passages as text, never as markup", () => {
    const out = html({
      status: "ok",
      related: [{ id: "c2", title: "<b>t</b>", updatedAtSec: null, similarity: 0.5, evidence: { focus: { text: '<img src=x onerror="alert(1)">', messageNumber: 1, href: "/conversations/c1#m-1" }, other: { text: "<script>x</script>", messageNumber: 1, href: "/conversations/c2#m-1" } } }],
    });
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<b>t</b>");
    expect(out).toContain("&lt;script&gt;");
  });

  it.each([
    [{ status: "ok", related: [] } as RelatedResult, "No close conversations."],
    [{ status: "not-indexed" } as RelatedResult, "isn&#x27;t in the semantic index"],
    [{ status: "no-index" } as RelatedResult, "once your conversations are indexed"],
    [null, "could not be loaded"],
  ])("states: %j", (result, text) => {
    const out = html(result);
    expect(out).toContain("Related conversations");
    expect(out).toContain(text);
    expect(out).not.toContain("<ol");
  });
});
