/**
 * Markdown rendering security (phase 3): hostile imported text rendered to HTML must contain no
 * markup of its own, no script-capable URL, no event handler and nothing that loads a resource.
 */
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./markdown";

const render = (text: string) => renderToStaticMarkup(<Markdown text={text} />);
/** The real tags of the output (escaped text such as `&lt;img …` is not a tag). */
const tags = (html: string) => html.match(/<[a-zA-Z][^>]*>/g) ?? [];

const HOSTILE = [
  "<script>alert(1)</script>",
  '<img src="x" onerror="alert(1)">',
  '<a href="javascript:alert(1)">x</a>',
  "<iframe src=https://evil.test></iframe>",
  "<style>body{display:none}</style>",
  '<svg onload="alert(1)"></svg>',
  "[x](javascript:alert(1))",
  "[x](JaVaScRiPt:alert(1))",
  "[x](java\tscript:alert(1))",
  "[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
  "[x](vbscript:msgbox(1))",
  '[x](https://ok.test "title" onmouseover="alert(1)")',
  "![pixel](https://tracker.test/p.gif)",
  "![x](javascript:alert(1))",
  "<javascript:alert(1)>",
  "**<b>bold html</b>**",
  "`<script>in code</script>`",
  "```html\n<script>alert(1)</script>\n```",
  "| a | b |\n|---|---|\n| <img src=x onerror=alert(1)> | [y](javascript:void(0)) |",
  "> <script>quoted</script>",
  "- <script>listed</script>",
];

describe("Markdown rendering is safe", () => {
  it.each(HOSTILE)("renders %j without markup, scripts, handlers or loads", (text) => {
    for (const tag of tags(render(text))) {
      expect(tag).not.toMatch(/^<(script|img|iframe|style|svg|object|embed|link|meta|base|form|input|video|audio|source)\b/i);
      expect(tag).not.toMatch(/\son[a-z]+=/i); // no event handler attributes
      expect(tag).not.toMatch(/\s(src|style|action|formaction)=/i);
      const href = /\shref="([^"]*)"/.exec(tag)?.[1];
      if (href !== undefined) expect(href).toMatch(/^(https?:\/\/|mailto:)/);
    }
  });

  it("shows raw HTML as text, escaped", () => {
    expect(render("<b>hi</b>")).toContain("&lt;b&gt;hi&lt;/b&gt;");
    expect(render("```\n<script>x</script>\n```")).toContain("&lt;script&gt;x&lt;/script&gt;");
  });

  it("safe links open in a new tab without a referrer or an opener", () => {
    const html = render("[docs](https://example.org/x)");
    expect(html).toContain('href="https://example.org/x"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain('referrerPolicy="no-referrer"');
  });

  it("an image is a text placeholder", () => {
    expect(render("![a chart](https://tracker.test/p.png)")).toContain("[Image: a chart]");
  });

  it("headings start below the message heading; code blocks keep their text", () => {
    const html = render("# Big\n\n```js\nconst a = 1;\n  indented();\n```");
    expect(html).toContain("<h4");
    expect(html).not.toContain("<h1");
    expect(html).toContain("const a = 1;\n  indented();");
  });

  it("falls back to plain text for a message too long to parse", () => {
    const html = render(`**${"x".repeat(100_001)}**`);
    expect(html).toContain("whitespace-pre-wrap");
    expect(html).not.toContain("<strong>");
  });

  it("never uses dangerouslySetInnerHTML (renderer and message view)", () => {
    for (const f of ["src/components/markdown.tsx", "src/components/message-view.tsx", "src/lib/markdown/parse.ts"]) {
      expect(fs.readFileSync(path.join(process.cwd(), f), "utf8")).not.toMatch(/dangerouslySetInnerHTML\s*=/);
    }
  });
});

describe("Markdown rendering under random hostile input", () => {
  const PIECES = ["**", "*", "_", "~~", "`", "```", "\n", "\n\n", "# ", "- ", "1. ", "> ", "| ", "|---|", "[", "]", "(", ")", "<", ">", "!", "\\", "javascript:", "JaVaScRiPt:", "data:text/html,", "https://ok.test/", "mailto:a@b.test", "<script>", "</script>", "<img src=x onerror=alert(1)>", '" onclick="x', "&#106;", "\t", "\u0000", "text ", "word"];
  it("never produces markup, handlers, loads or unsafe links, and never throws (2,000 messages)", () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let n = 0; n < 2_000; n++) {
      const text = Array.from({ length: 1 + Math.floor(rnd() * 30) }, () => PIECES[Math.floor(rnd() * PIECES.length)]).join("");
      for (const tag of tags(render(text))) {
        expect(tag, text).not.toMatch(/^<(script|img|iframe|style|svg|object|embed|link|meta|base|form|input|video|audio|source)\b/i);
        expect(tag, text).not.toMatch(/\son[a-z]+=|\s(src|style|action|formaction)=/i);
        const href = /\shref="([^"]*)"/.exec(tag)?.[1];
        if (href !== undefined) expect(href, text).toMatch(/^(https?:\/\/[^\s]|mailto:)/);
      }
    }
  });
});
