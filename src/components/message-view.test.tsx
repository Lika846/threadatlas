import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { displayTitle, formatEpochSeconds, isoFromEpochSeconds, pathNote, roleLabel } from "@/lib/conversations/display";
import type { DisplayedMessage } from "@/lib/conversations/queries";
import { MessageView } from "./message-view";

const msg = (over: Partial<DisplayedMessage> = {}): DisplayedMessage => ({
  sourceNodeId: "n1", number: 1, role: "user", authorName: null, contentType: "text", contentText: "hello",
  codeLanguage: null, isMalformed: false, hasUnsupportedParts: false, isHidden: false, createdAtSec: 1767225600, versions: 1, ...over,
});

describe("MessageView renders imported values as text only", () => {
  const XSS = `<script>alert(1)</script><img src=x onerror=alert(2)><a href="https://example.com">link</a>`;

  it("escapes markup in text, role, author and code language", () => {
    const html = [
      renderToStaticMarkup(<MessageView message={msg({ contentText: XSS, role: "<b>role</b>", authorName: "<i>me</i>" })} />),
      renderToStaticMarkup(<MessageView message={msg({ contentType: "code", contentText: XSS, codeLanguage: "<svg onload=x>" })} />),
    ].join("");
    expect(html).not.toMatch(/<script|<img|<a |<svg|<b>|<i>/);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(2)&gt;");
    expect(html).toContain("&lt;svg onload=x&gt;");
    expect(html).not.toContain('href="'); // only the escaped text href=&quot;… remains
  });

  it("keeps code text exactly, in a pre block, with the language as a label", () => {
    const code = "def f():\n\treturn  1\n";
    const html = renderToStaticMarkup(<MessageView message={msg({ contentType: "code", contentText: code, codeLanguage: "python" })} />);
    expect(html).toContain("<pre");
    expect(html).toContain(`<code>${code}</code>`);
    expect(html).toMatch(/Code(<!-- -->)? \(python\)/);
  });

  it("shows markers for branches, hidden, malformed and unsupported messages", () => {
    const html = renderToStaticMarkup(<MessageView message={msg({ versions: 3, isHidden: true, isMalformed: true, hasUnsupportedParts: true })} />);
    expect(html).toMatch(/3(<!-- -->)? versions exist/);
    for (const text of ["Hidden by default", "Malformed in the export", "Contains unsupported content"]) expect(html).toContain(text);
    expect(renderToStaticMarkup(<MessageView message={msg()} />)).not.toContain("Notes");
  });

  it("shows an empty message as 'No text.' and a missing time as nothing", () => {
    const html = renderToStaticMarkup(<MessageView message={msg({ contentText: "", createdAtSec: null })} />);
    expect(html).toContain("No text.");
    expect(html).not.toContain("<time");
  });
});

describe("display helpers", () => {
  it("labels known roles and keeps others exactly", () => {
    expect([roleLabel("user"), roleLabel("assistant"), roleLabel("system"), roleLabel("tool")]).toEqual(["User", "Assistant", "System", "Tool"]);
    expect(roleLabel("critic")).toBe("critic");
    expect(roleLabel(null)).toBe("Unknown role");
    expect(roleLabel("constructor")).toBe("constructor");
  });

  it("falls back to Untitled", () => {
    expect([displayTitle(null), displayTitle("  "), displayTitle("Plan")]).toEqual(["Untitled conversation", "Untitled conversation", "Plan"]);
  });

  it("formats times deterministically and survives extreme values", () => {
    expect(formatEpochSeconds(1767225600.9)).toBe("2026-01-01 00:00 UTC");
    expect(formatEpochSeconds(null)).toBeNull();
    expect(formatEpochSeconds(1e300)).toBe("outside the displayable date range");
    expect(isoFromEpochSeconds(1e300)).toBeUndefined();
    expect(isoFromEpochSeconds(0)).toBe("1970-01-01T00:00:00.000Z");
  });

  it("explains every path strategy except current_node", () => {
    expect(pathNote("current_node")).toBeNull();
    for (const s of ["latest_leaf", "last_child", "none", "future"]) expect(pathNote(s)).toMatch(/\.$/);
    expect(pathNote("latest_leaf")).toContain("may not be the branch you last viewed");
  });
});

// ---------------------------------------------------------------- reading layout (phase 3)

const assistantMsg = (o: Partial<DisplayedMessage>): DisplayedMessage => ({
  sourceNodeId: "n1",
  number: 1,
  role: "assistant",
  authorName: null,
  contentType: "text",
  contentText: "**bold** and <b>tag</b>",
  codeLanguage: null,
  isMalformed: false,
  hasUnsupportedParts: false,
  isHidden: false,
  createdAtSec: null,
  versions: 1,
  ...o,
});
const render = (o: Partial<DisplayedMessage>) => renderToStaticMarkup(<MessageView message={assistantMsg(o)} />);

describe("MessageView (reading layout)", () => {
  it("renders an assistant message's Markdown, with raw HTML as text", () => {
    const html = render({});
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("&lt;b&gt;tag&lt;/b&gt;");
    expect(html).toContain('data-role="assistant"');
    expect(html).toContain("font-serif");
  });

  it("shows your messages exactly as typed, in a tinted block", () => {
    const html = render({ role: "user", contentText: "**not bold**\n  indented" });
    expect(html).toContain("**not bold**\n  indented");
    expect(html).not.toContain("<strong>");
    expect(html).toContain("bg-neutral-100");
  });

  it("keeps code and tool output exact, and malformed messages as plain text", () => {
    expect(render({ contentType: "code", contentText: "if a < b:\n    **x**" })).toContain("<code>if a &lt; b:\n    **x**</code>");
    expect(render({ isMalformed: true, contentText: "**raw**" })).toContain("**raw**");
  });

  it("keeps the message heading the search links and outline target", () => {
    expect(render({ number: 7 })).toMatch(/<h3 id="m-7"/);
  });
});
