import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HighlightedText } from "./highlighted-text";

describe("HighlightedText (M2.3)", () => {
  it("wraps matches in <mark> and renders everything else as text", () => {
    const html = renderToStaticMarkup(
      <p>
        <HighlightedText
          segments={[
            { text: "…before ", match: false },
            { text: "word", match: true },
            { text: " after…", match: false },
          ]}
        />
      </p>,
    );
    expect(html).toMatch(/^<p>…before <mark[^>]*>word<\/mark> after…<\/p>$/);
  });

  it("never turns imported text into markup", () => {
    const hostile = `<script>alert(1)</script><img src=x onerror=alert(2)><b>bold</b>`;
    const html = renderToStaticMarkup(
      <p>
        <HighlightedText
          segments={[
            { text: hostile, match: false },
            { text: `<mark>fake</mark>`, match: true },
          ]}
        />
      </p>,
    );
    expect(html).not.toMatch(/<script|<img|<b>/);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(html.match(/<mark/g)).toHaveLength(1); // only the real highlight
    expect(html).toContain("&lt;mark&gt;fake&lt;/mark&gt;");
  });

  it("renders nothing for no segments", () => {
    expect(renderToStaticMarkup(<HighlightedText segments={[]} />)).toBe("");
  });
});
