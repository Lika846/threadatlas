import { describe, expect, it } from "vitest";
import { MAX_MARKDOWN_CHARS, parseInline, parseMarkdown, safeHref } from "./parse";

describe("blocks", () => {
  it("headings, paragraphs with line breaks, rules", () => {
    expect(parseMarkdown("# Title\n\nOne line\nnext line\n\n---")).toEqual([
      { type: "heading", level: 1, children: [{ type: "text", text: "Title" }] },
      { type: "paragraph", children: [{ type: "text", text: "One line" }, { type: "br" }, { type: "text", text: "next line" }] },
      { type: "hr" },
    ]);
  });

  it("fenced code keeps its text exactly, with the language; an unclosed fence runs to the end", () => {
    expect(parseMarkdown("```python\nx = 1  # *not emphasis*\n\n  y = <b>\n```\nafter")).toEqual([
      { type: "code", lang: "python", text: "x = 1  # *not emphasis*\n\n  y = <b>" },
      { type: "paragraph", children: [{ type: "text", text: "after" }] },
    ]);
    expect(parseMarkdown("~~~\nopen")).toEqual([{ type: "code", lang: null, text: "open" }]);
  });

  it("bullet and numbered lists, nested by indentation, with a start number", () => {
    const tree = parseMarkdown("3. first\n4. second\n   - inner a\n   - inner b\n5. third")!;
    expect(tree).toHaveLength(1);
    const list = tree[0]!;
    expect(list).toMatchObject({ type: "list", ordered: true, start: 3 });
    if (list.type !== "list") throw new Error();
    expect(list.items).toHaveLength(3);
    expect(list.items[1]![1]).toMatchObject({ type: "list", ordered: false });
  });

  it("block quotes and pipe tables with alignment", () => {
    expect(parseMarkdown("> quoted *text*")![0]).toMatchObject({ type: "blockquote", children: [{ type: "paragraph" }] });
    const t = parseMarkdown("| Name | Count |\n|:--|--:|\n| a \\| b | `1|2` |\n| c | 3 |")![0]!;
    expect(t).toMatchObject({ type: "table", align: ["left", "right"] });
    if (t.type !== "table") throw new Error();
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0]![0]).toEqual([{ type: "text", text: "a | b" }]);
    expect(t.rows[0]![1]).toEqual([{ type: "code", text: "1|2" }]);
  });

  it("very long messages are left to the plain-text view", () => {
    expect(parseMarkdown("x".repeat(MAX_MARKDOWN_CHARS + 1))).toBeNull();
  });

  it("deep nesting stops at a bounded depth", () => {
    const deep = Array.from({ length: 40 }, (_, i) => `${" ".repeat(i * 2)}- level ${i}`).join("\n");
    expect(() => parseMarkdown(deep)).not.toThrow();
    expect(() => parseMarkdown(">".repeat(200) + " deep")).not.toThrow();
  });
});

describe("inline", () => {
  it("bold, italic, strikethrough, inline code, escapes", () => {
    expect(parseInline("**bold** and *it* and ~~gone~~ and `a*b*c` and \\*literal\\*")).toEqual([
      { type: "strong", children: [{ type: "text", text: "bold" }] },
      { type: "text", text: " and " },
      { type: "em", children: [{ type: "text", text: "it" }] },
      { type: "text", text: " and " },
      { type: "del", children: [{ type: "text", text: "gone" }] },
      { type: "text", text: " and " },
      { type: "code", text: "a*b*c" },
      { type: "text", text: " and *literal*" },
    ]);
  });

  it("leaves snake_case, lone asterisks and maths alone", () => {
    expect(parseInline("my_var_name and 2 * 3 * 4 and $a_b$")).toEqual([{ type: "text", text: "my_var_name and 2 * 3 * 4 and $a_b$" }]);
  });

  it("links, autolinks and bare URLs", () => {
    expect(parseInline("[docs](https://example.org/a_(b)) <https://x.test> see https://y.test/p.")).toEqual([
      { type: "link", href: "https://example.org/a_(b)", children: [{ type: "text", text: "docs" }] },
      { type: "text", text: " " },
      { type: "link", href: "https://x.test/", children: [{ type: "text", text: "https://x.test" }] },
      { type: "text", text: " see " },
      { type: "link", href: "https://y.test/p", children: [{ type: "text", text: "https://y.test/p" }] },
      { type: "text", text: "." },
    ]);
  });

  it("images become placeholders, never something to load", () => {
    expect(parseInline("![a chart](https://tracker.test/pixel.png)")).toEqual([{ type: "image", alt: "a chart" }]);
  });
});

describe("safeHref (security)", () => {
  it.each(["https://example.org/x?y=1#z", "http://example.org", "mailto:someone@example.org"])("allows %s", (u) => {
    expect(safeHref(u)).not.toBeNull();
  });

  it.each([
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    " javascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "java\u0000script:alert(1)",
    "javascript&#58;alert(1)",
    "&#106;avascript:alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "ftp://example.org",
    "blob:https://example.org/x",
    "//evil.example/x",
    "/settings",
    "#m-1",
    "conversations/abc",
    "https://exa mple.org",
    "https://",
    "",
  ])("refuses %j", (u) => {
    expect(safeHref(u)).toBeNull();
  });

  it("an unsafe link keeps its text, without a link", () => {
    expect(parseInline("[click me](javascript:alert(1))")).toEqual([{ type: "text", text: "click me" }]);
    expect(parseInline("<javascript:alert(1)>")).toEqual([{ type: "text", text: "<javascript:alert(1)>" }]);
  });
});

describe("release review: nesting, lists, tables, escaping", () => {
  const t = (text: string) => ({ type: "text", text });

  it("nested emphasis: bold around italic, italic around bold, ***both***", () => {
    expect(parseInline("***x***")).toEqual([{ type: "strong", children: [{ type: "em", children: [t("x")] }] }]);
    expect(parseInline("*it **b** it*")).toEqual([{ type: "em", children: [t("it "), { type: "strong", children: [t("b")] }, t(" it")] }]);
    expect(parseInline("**b *i* b**")).toEqual([{ type: "strong", children: [t("b "), { type: "em", children: [t("i")] }, t(" b")] }]);
  });

  it("a link's text never holds another link (nested anchors are invalid HTML)", () => {
    expect(parseInline("[see https://x.test](https://y.test)")).toEqual([{ type: "link", href: "https://y.test/", children: [t("see https://x.test")] }]);
    expect(parseInline("[[a](https://x.test)](https://y.test)")).toEqual([{ type: "link", href: "https://y.test/", children: [t("a")] }]);
    expect(parseInline("[**<https://x.test>**](https://y.test)")).toEqual([{ type: "link", href: "https://y.test/", children: [{ type: "strong", children: [t("<https://x.test>")] }] }]);
  });

  it("link titles are skipped; an unencoded bracket in a bare destination makes no link", () => {
    expect(parseInline('[a](https://x.test "t")')).toEqual([{ type: "link", href: "https://x.test/", children: [t("a")] }]);
    expect(parseInline("[a](https://x.test (t))")).toEqual([{ type: "link", href: "https://x.test/", children: [t("a")] }]);
    expect(parseInline("[a](mailto:x@example.org?s=[1])")).toEqual([t("[a](mailto:x@example.org?s=[1])")]);
  });

  it("fenced code inside a list item keeps its text, blank lines included", () => {
    expect(parseMarkdown("1. Step\n   ```js\n   const a = 1;\n\n   b();\n   ```\n2. Next")).toEqual([
      { type: "list", ordered: true, start: 1, items: [[{ type: "paragraph", children: [t("Step")] }, { type: "code", lang: "js", text: "const a = 1;\n\nb();" }], [{ type: "paragraph", children: [t("Next")] }]] },
    ]);
  });

  it("table cells: inline formatting, code with a pipe, escaped pipes, unsafe links and tags as text", () => {
    expect(parseMarkdown("| a | b |\n|:-|-:|\n| `x|y` \\| p | [l](javascript:x) <b>h</b> |")).toEqual([
      { type: "table", align: ["left", "right"], header: [[t("a")], [t("b")]], rows: [[[{ type: "code", text: "x|y" }, t(" | p")], [t("l <b>h</b>")]]] },
    ]);
  });

  it("a table right after a paragraph line still starts a table", () => {
    expect(parseMarkdown("Here:\n| a |\n|---|\n| 1 |")).toEqual([
      { type: "paragraph", children: [t("Here:")] },
      { type: "table", align: [null], header: [[t("a")]], rows: [[[t("1")]]] },
    ]);
  });

  it("escapes, entities and headings with a closing run", () => {
    expect(parseInline("\\*no\\* \\\\ \\[x\\](y) \\`z\\` &amp;")).toEqual([t("*no* \\ [x](y) `z` &amp;")]);
    expect(parseMarkdown("## Title ##\n#nope")).toEqual([
      { type: "heading", level: 2, children: [t("Title")] },
      { type: "paragraph", children: [t("#nope")] },
    ]);
    expect(parseMarkdown("~~~py extra `x`\ncode\n~~~")).toEqual([{ type: "code", lang: "py", text: "code" }]);
  });

  // Each of these took 2–40 s at this size before the scans were made linear (release review).
  it.each([
    ["unmatched asterisks", "*a ".repeat(33_000)],
    ["unmatched underscores", "_a ".repeat(33_000)],
    ["unmatched brackets", "[".repeat(99_000)],
    ["unmatched images", "![".repeat(49_000)],
    ["open destinations", "[a](x".repeat(19_000)],
    ["open quoted titles", '[a](b "'.repeat(14_000)],
    ["open bracketed titles", "[a](b (".repeat(14_000)],
    ["a long fence info string", "```" + "a".repeat(99_000) + "`"],
    ["spaces in a heading", "# a" + " ".repeat(99_000) + "b"],
    ["spaces in a table delimiter row", "a | b\n|-" + " ".repeat(99_000) + "x"],
    ["spaces in a paragraph", "a" + " ".repeat(99_000) + "b\nc"],
  ])("stays fast on %s (100,000 characters)", (_, text) => {
    expect(text.length).toBeLessThanOrEqual(MAX_MARKDOWN_CHARS);
    const start = performance.now();
    parseMarkdown(text);
    expect(performance.now() - start).toBeLessThan(1_000);
  });
});
