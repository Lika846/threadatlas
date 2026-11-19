import { describe, expect, it } from "vitest";
import { MAX_QUERY_CHARS, MAX_QUERY_TERMS, MIN_PREFIX_CHARS, parseSearchQuery } from "./query";

const fts = (input: string) => {
  const r = parseSearchQuery(input);
  if (!r.ok) throw new Error(`expected a query, got ${r.rejection.reason}`);
  return r.fts;
};
const reason = (input: unknown) => {
  const r = parseSearchQuery(input);
  return r.ok ? "ok" : r.rejection.reason;
};

describe("parseSearchQuery: words, phrases, prefix", () => {
  it.each([
    ["hello", `"hello"`],
    ["  hello   world  ", `"hello" "world"`],
    [`"exact phrase" word`, `"exact phrase" "word"`],
    [`"  spaced    phrase "`, `"spaced phrase"`],
    ["prog*", `"prog"*`],
    ["word prog*", `"word" "prog"*`],
    ["prog**", `"prog"*`],
    // Only the last unquoted word can be a prefix; elsewhere `*` is just a character.
    ["prog* word", `"prog*" "word"`],
    [`"prog*"`, `"prog*"`],
    [`word "prog"*`, `"word" "prog"`],
  ])("%j → %s", (input, expected) => {
    expect(fts(input)).toBe(expected);
  });

  it("reports the terms it built", () => {
    const r = parseSearchQuery(`alpha "beta gamma" del*`);
    expect(r).toEqual({
      ok: true,
      fts: `"alpha" "beta gamma" "del"*`,
      terms: [
        { text: "alpha", phrase: false, prefix: false },
        { text: "beta gamma", phrase: true, prefix: false },
        { text: "del", phrase: false, prefix: true },
      ],
    });
  });
});

describe("parseSearchQuery: special characters and FTS5 operators are only words", () => {
  it.each([
    ["C++", `"C++"`],
    [".NET", `".NET"`],
    ["C#", `"C#"`],
    ["alice@example.com", `"alice@example.com"`],
    ["foo-bar", `"foo-bar"`],
    ["don't", `"don't"`],
    ["AND", `"AND"`],
    ["foo OR bar", `"foo" "OR" "bar"`],
    ["NOT foo", `"NOT" "foo"`],
    ["foo NOT bar", `"foo" "NOT" "bar"`],
    ["NEAR(foo bar)", `"NEAR(foo" "bar)"`],
    ["NEAR(foo bar, 2)", `"NEAR(foo" "bar," "2)"`],
    ["title:secret", `"title:secret"`],
    ["contentText:secret", `"contentText:secret"`],
    ["{title contentText}:x", `"{title" "contentText}:x"`],
    ["^start", `"^start"`],
    ["-foo +bar", `"-foo" "+bar"`],
    ["(foo)", `"(foo)"`],
    ["foo*bar", `"foo*bar"`],
    ["a:b:c", `"a:b:c"`],
    ["x'; DROP TABLE Message; --", `"x';" "DROP" "TABLE" "Message;"`],
    ["rank:1", `"rank:1"`],
    ["message_fts", `"message_fts"`],
  ])("%j → %s", (input, expected) => {
    expect(fts(input)).toBe(expected);
  });

  it("drops terms with no letter or digit (the tokenizer would ignore them)", () => {
    expect(fts("foo - bar")).toBe(`"foo" "bar"`);
    expect(fts("foo ++ ... !!! bar")).toBe(`"foo" "bar"`);
    expect(fts("foo 🙂 bar")).toBe(`"foo" "bar"`);
    expect(fts(`foo "" bar`)).toBe(`"foo" "bar"`);
  });
});

describe("parseSearchQuery: quotes", () => {
  it.each([
    [`"unbalanced phrase`, `"unbalanced" "phrase"`],
    [`unbalanced phrase"`, `"unbalanced" "phrase"`],
    [`"one" "two`, `"one" "two"`],
    [`a"b c"d`, `"a b" "c d"`],
    [`"a" b "c d" "`, `"a" "b" "c d"`],
    [`"""`, null],
    [`""foo""`, `"foo"`],
  ])("%j → %s", (input, expected) => {
    const r = parseSearchQuery(input);
    if (expected === null) expect(r.ok).toBe(false);
    else expect(r.ok && r.fts).toBe(expected);
  });

  it("never leaves a raw double quote inside a term", () => {
    for (const input of [`a"b`, `"a"b"c"`, `x""y`, `"he said ""hi"""`]) {
      const r = parseSearchQuery(input);
      if (r.ok) for (const t of r.terms) expect(t.text).not.toContain('"');
    }
  });
});

describe("parseSearchQuery: normalisation and control characters", () => {
  it("applies NFKC (full-width, ligatures, composed accents)", () => {
    expect(fts("ｆｏｏ　ｂａｒ")).toBe(`"foo" "bar"`); // full-width letters and ideographic space
    expect(fts("ﬁle")).toBe(`"file"`);
    expect(fts("café")).toBe(`"café"`);
    expect(fts("①")).toBe(`"1"`);
  });

  it("reads control characters as spaces", () => {
    expect(fts("foo\u0000bar")).toBe(`"foo" "bar"`);
    expect(fts("foo\tbar\nbaz\rqux")).toBe(`"foo" "bar" "baz" "qux"`);
    expect(fts("foo\u0085bar\u009fbaz\u007fq")).toBe(`"foo" "bar" "baz" "q"`);
    expect(fts(`"a\u0000b"`)).toBe(`"a b"`);
  });

  it("keeps non-Latin scripts", () => {
    expect(fts("Привет мир")).toBe(`"Привет" "мир"`);
    expect(fts("שלום")).toBe(`"שלום"`);
    expect(fts("東京")).toBe(`"東京"`);
  });
});

describe("parseSearchQuery: typed rejections instead of truncation", () => {
  it.each([[""], ["   "], ["\n\t"]])("empty: %j", (input) => {
    expect(reason(input)).toBe("empty");
  });

  it("rejects non-strings as empty", () => {
    for (const v of [undefined, null, 42, ["a"], { q: "a" }]) expect(reason(v)).toBe("empty");
  });

  it.each([["***"], ["!!! ???"], ["🙂🙂"], ['"" ""'], ["-"], ["\u0000"]])("no searchable terms: %j", (input) => {
    expect(reason(input)).toBe("no_terms");
  });

  it(`accepts exactly ${MAX_QUERY_CHARS} characters and rejects ${MAX_QUERY_CHARS + 1}`, () => {
    const at = "a".repeat(MAX_QUERY_CHARS);
    expect(parseSearchQuery(at).ok).toBe(true);
    expect(parseSearchQuery(`  ${at}  `).ok).toBe(true); // surrounding whitespace is not counted
    expect(parseSearchQuery(at + "b")).toEqual({ ok: false, rejection: { reason: "too_long", limit: MAX_QUERY_CHARS, length: MAX_QUERY_CHARS + 1 } });
  });

  it("counts code points, not UTF-16 units", () => {
    expect(parseSearchQuery("𝒜".repeat(MAX_QUERY_CHARS)).ok).toBe(true); // 2 units each
    expect(reason("𝒜".repeat(MAX_QUERY_CHARS + 1))).toBe("too_long");
  });

  it(`accepts ${MAX_QUERY_TERMS} terms and rejects ${MAX_QUERY_TERMS + 1}`, () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
    const ok = parseSearchQuery(words(MAX_QUERY_TERMS));
    expect(ok.ok && ok.terms).toHaveLength(MAX_QUERY_TERMS);
    expect(parseSearchQuery(words(MAX_QUERY_TERMS + 1))).toEqual({ ok: false, rejection: { reason: "too_many_terms", limit: MAX_QUERY_TERMS, terms: MAX_QUERY_TERMS + 1 } });
    // A phrase is one term; punctuation-only tokens are not terms.
    expect(parseSearchQuery(`${words(MAX_QUERY_TERMS - 1)} "a b c d" - + !`).ok).toBe(true);
  });

  it(`needs ${MIN_PREFIX_CHARS} letters or digits before a prefix *`, () => {
    expect(parseSearchQuery("a*")).toEqual({ ok: false, rejection: { reason: "prefix_too_short", minimum: MIN_PREFIX_CHARS } });
    expect(reason("word é*")).toBe("prefix_too_short");
    expect(reason("c+*")).toBe("prefix_too_short"); // one letter; '+' is not searchable
    expect(fts("ab*")).toBe(`"ab"*`);
    expect(fts("1a*")).toBe(`"1a"*`);
  });
});

describe("parseSearchQuery: hostile input", () => {
  it("never throws and every output is a list of quoted strings", () => {
    const pieces = [`"`, "*", "(", ")", ":", "^", "+", "-", "AND", "OR", "NOT", "NEAR", "{", "}", "'", "\\", "\u0000", "‮", "\ud800", "🙂", "é", "a", "1", " ", "\n", "%", "_", ";", ",", "NEAR(", "col:", "", "￿"];
    let seed = 7;
    const rand = (n: number) => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648), seed % n);
    const shape = /^("([^"]|"")*"\*?)( "([^"]|"")*"\*?)*$/;
    for (let i = 0; i < 3_000; i++) {
      const input = Array.from({ length: 1 + rand(24) }, () => pieces[rand(pieces.length)]).join(rand(2) ? " " : "");
      const r = parseSearchQuery(input);
      if (r.ok) {
        expect(r.fts).toMatch(shape);
        expect(r.terms.length).toBeLessThanOrEqual(MAX_QUERY_TERMS);
        expect(r.terms.filter((t) => t.prefix).length).toBeLessThanOrEqual(1);
      }
    }
  });
});
