import { describe, expect, it } from "vitest";
import { createMarkers, ELLIPSIS, MAX_CONTEXT_CHARS, MAX_MATCH_CHARS, parseMarkedText, type SnippetMarkers } from "./snippet";

const m: SnippetMarkers = createMarkers();
const S = m.start;
const E = m.end;
const L = m.ellipsis;
const plain = (segments: { text: string }[]) => segments.map((s) => s.text).join("");

describe("createMarkers", () => {
  it("uses private-use characters and a fresh 128-bit value each time", () => {
    const a = createMarkers();
    const b = createMarkers();
    expect(a.start).not.toBe(b.start);
    for (const x of [a.start, a.end, a.ellipsis]) expect(x).toMatch(/^[-][0-9a-f]{32}[-]$/);
    expect(new Set([a.start, a.end, a.ellipsis]).size).toBe(3);
  });
});

describe("parseMarkedText", () => {
  it("splits matches from context and turns FTS5's ellipsis into …", () => {
    expect(parseMarkedText(`${L}before ${S}word${E} middle ${S}other${E} after${L}`, m)).toEqual([
      { text: `${ELLIPSIS}before `, match: false },
      { text: "word", match: true },
      { text: " middle ", match: false },
      { text: "other", match: true },
      { text: ` after${ELLIPSIS}`, match: false },
    ]);
  });

  it("keeps imported text as plain text, markup included", () => {
    const html = `<script>alert(1)</script> <b onclick="x">`;
    expect(parseMarkedText(`${html} ${S}word${E}`, m)).toEqual([
      { text: `${html} `, match: false },
      { text: "word", match: true },
    ]);
  });

  it("text without markers is one plain segment", () => {
    expect(parseMarkedText("just a title", m)).toEqual([{ text: "just a title", match: false }]);
    expect(parseMarkedText("", m)).toEqual([]);
  });

  describe("forged markers in imported text are plain text", () => {
    const other = createMarkers();
    it.each([
      ["bare private-use characters", "fake text"],
      ["markers with a different random value", `${other.start}fake${other.end}`],
      ["a guessed value", `${"0".repeat(32)}fake${"0".repeat(32)}`],
    ])("%s", (_label, forged) => {
      const segments = parseMarkedText(`${forged} ${S}real${E}`, m);
      expect(segments).toEqual([
        { text: `${forged} `, match: false },
        { text: "real", match: true },
      ]);
    });
  });

  describe("malformed markers fall back to plain text, every marker removed", () => {
    it.each([
      ["start without end", `a ${S}b c`, "a b c"],
      ["end without start", `a b${E} c`, "a b c"],
      ["end before start", `a${E} b ${S}c`, "a b c"],
      ["nested", `${S}a ${S}b${E} c${E}`, "a b c"],
      ["empty match", `a ${S}${E} b`, "a  b"],
      ["valid match then a stray end", `${S}a${E} b${E}`, "a b"],
    ])("%s", (_label, input, expected) => {
      expect(parseMarkedText(input, m)).toEqual([{ text: expected, match: false }]);
    });

    it("keeps the ellipsis in the fallback", () => {
      expect(parseMarkedText(`${L}a ${S}b`, m)).toEqual([{ text: `${ELLIPSIS}a b`, match: false }]);
    });
  });

  describe("caps long segments without splitting characters", () => {
    const long = (ch: string, n: number) => ch.repeat(n);

    it("context before the first match keeps its end", () => {
      const [first, match] = parseMarkedText(`${long("x", 5_000)}tail ${S}hit${E}`, m);
      expect(Array.from(first!.text)).toHaveLength(MAX_CONTEXT_CHARS + 1);
      expect(first!.text.startsWith(ELLIPSIS)).toBe(true);
      expect(first!.text.endsWith("tail ")).toBe(true);
      expect(match).toEqual({ text: "hit", match: true });
    });

    it("context after the last match keeps its start", () => {
      const segments = parseMarkedText(`${S}hit${E} head${long("y", 5_000)}`, m);
      expect(segments[1]!.text.startsWith(" head")).toBe(true);
      expect(segments[1]!.text.endsWith(ELLIPSIS)).toBe(true);
      expect(Array.from(segments[1]!.text)).toHaveLength(MAX_CONTEXT_CHARS + 1);
    });

    it("context between matches keeps both ends", () => {
      const segments = parseMarkedText(`${S}a${E} start${long("z", 5_000)}end ${S}b${E}`, m);
      const mid = segments[1]!.text;
      expect(mid.startsWith(" start")).toBe(true);
      expect(mid.endsWith("end ")).toBe(true);
      expect(mid).toContain(ELLIPSIS);
      expect(Array.from(mid)).toHaveLength(MAX_CONTEXT_CHARS + 1);
    });

    it("a long matched token keeps its start and stays a match", () => {
      const [seg] = parseMarkedText(`${S}${long("w", 10_000)}${E}`, m);
      expect(seg!.match).toBe(true);
      expect(Array.from(seg!.text)).toHaveLength(MAX_MATCH_CHARS + 1);
      expect(seg!.text.endsWith(ELLIPSIS)).toBe(true);
    });

    it("a long text without matches (a plain title) keeps its start", () => {
      const [seg] = parseMarkedText(long("t", 1_000), m);
      expect(Array.from(seg!.text)).toHaveLength(MAX_CONTEXT_CHARS + 1);
    });

    it("never splits a surrogate pair", () => {
      const segments = parseMarkedText(`${long("🙂", 500)} ${S}hit${E} ${long("𝒜", 500)}`, m);
      for (const s of segments) expect(s.text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
      expect(plain(segments)).toContain("hit");
    });

    it("the total stays bounded for the most matches FTS5 can mark", () => {
      const parts = Array.from({ length: 16 }, () => `${long("c", 1_000)}${S}${long("m", 1_000)}${E}`).join("");
      const segments = parseMarkedText(parts + long("c", 1_000), m);
      expect(segments.filter((s) => s.match)).toHaveLength(16);
      expect(Array.from(plain(segments)).length).toBeLessThanOrEqual(17 * (MAX_CONTEXT_CHARS + 1) + 16 * (MAX_MATCH_CHARS + 1));
    });
  });
});
