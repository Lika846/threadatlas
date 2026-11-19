import { describe, expect, it } from "vitest";
import { CHUNKER_VERSION, chunkId, chunkMessages, chunkSpans, splitSentences, type Span } from "./chunker";

// Deterministic stand-in tokenizers: one token per word, or one per code point.
const words = (s: string) => s.split(/\s+/u).filter(Boolean).length;
const codePoints = (s: string) => [...s].length;

const texts = (text: string, spans: Span[]) => spans.map((s) => text.slice(s.start, s.end));

describe("splitSentences", () => {
  it("splits at . ! ? followed by whitespace and trims each span", () => {
    const t = "  First one. Second!  Third?\tFourth  ";
    expect(texts(t, splitSentences(t))).toEqual(["First one.", "Second!", "Third?", "Fourth"]);
  });

  it("keeps lines without final punctuation (the research regex dropped them)", () => {
    const t = "A heading\nSome text. More text\n- a list item\n\n\nlast line";
    expect(texts(t, splitSentences(t))).toEqual(["A heading", "Some text.", "More text", "- a list item", "last line"]);
  });

  it("does not split inside numbers, domains or abbreviations without a following space", () => {
    const t = "It weighs 3.5 kg, see example.com/a.b for v1.2.3 details.";
    expect(texts(t, splitSentences(t))).toEqual([t]);
  });

  it("keeps closing quotes and brackets with their sentence, and runs of marks together", () => {
    const t = 'He said "Stop." Then (he left!) Really?! Yes… ok';
    expect(texts(t, splitSentences(t))).toEqual(['He said "Stop."', "Then (he left!)", "Really?!", "Yes…", "ok"]);
  });

  it("splits after CJK sentence marks without whitespace", () => {
    const t = "你好。我很好！真的吗？好";
    expect(texts(t, splitSentences(t))).toEqual(["你好。", "我很好！", "真的吗？", "好"]);
  });

  it("treats CRLF, CR, LS and PS as line breaks and drops blank lines", () => {
    const t = "one\r\ntwo\rthree four five\r\n\r\n  \n";
    expect(texts(t, splitSentences(t))).toEqual(["one", "two", "three", "four", "five"]);
  });

  it("returns nothing for empty or whitespace-only text", () => {
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences(" \n\t \r\n ")).toEqual([]);
  });
});

describe("chunkSpans", () => {
  it("packs whole sentences up to the budget with one sentence of overlap", () => {
    // Five 3-word sentences, budget 7 words: two sentences per chunk, the second repeated.
    const t = "a b c. d e f. g h i. j k l. m n o.";
    const chunks = texts(t, chunkSpans(t, { countTokens: words, maxTokens: 7 }));
    expect(chunks).toEqual(["a b c. d e f.", "d e f. g h i.", "g h i. j k l.", "j k l. m n o."]);
  });

  it("starts the next chunk after the overlap sentence when the two would not fit together", () => {
    // Budget 7: [3,4] fit; then 4 + 5 > 7, so no overlap; 5 alone; then 5 + 1 fits.
    const t = "a b c. d e f g. h i j k l. m.";
    const chunks = texts(t, chunkSpans(t, { countTokens: words, maxTokens: 7 }));
    expect(chunks).toEqual(["a b c. d e f g.", "h i j k l. m."]);
  });

  it("never produces a chunk contained in another chunk", () => {
    const t = "one two. three four five six seven. eight. nine ten eleven twelve thirteen. x.";
    const spans = chunkSpans(t, { countTokens: words, maxTokens: 6 });
    for (const a of spans) {
      for (const b of spans) if (a !== b) expect(a.start >= b.start && a.end <= b.end).toBe(false);
    }
  });

  it("splits an oversized sentence at whitespace into the longest runs that fit", () => {
    const t = "w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11. Short. One two three.";
    const chunks = texts(t, chunkSpans(t, { countTokens: words, maxTokens: 4 }));
    // The last piece packs with the next sentence, which then overlaps into the next chunk.
    expect(chunks).toEqual(["w1 w2 w3 w4", "w5 w6 w7 w8", "w9 w10 w11. Short.", "Short. One two three."]);
  });

  it("splits a single over-long word at code points without breaking surrogate pairs", () => {
    const t = "🙂".repeat(5) + "abcdefg";
    const spans = chunkSpans(t, { countTokens: codePoints, maxTokens: 4 });
    expect(texts(t, spans)).toEqual(["🙂🙂🙂🙂", "🙂abc", "defg"]);
    for (const s of spans) {
      expect(codePoints(t.slice(s.start, s.end))).toBeLessThanOrEqual(4);
      expect(t.slice(s.start, s.end).isWellFormed()).toBe(true);
    }
  });

  it("keeps every chunk within the budget and every word in at least one chunk", () => {
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let round = 0; round < 50; round++) {
      const parts: string[] = [];
      const n = 1 + Math.floor(rand() * 40);
      for (let i = 0; i < n; i++) {
        const len = 1 + Math.floor(rand() * 30);
        const sentence = Array.from({ length: len }, (_, k) => `t${round}x${i}y${k}`).join(" ");
        parts.push(sentence + [".", "!", "?", "", "\n"][Math.floor(rand() * 5)]);
      }
      const t = parts.join(rand() < 0.5 ? " " : "\n");
      const max = 2 + Math.floor(rand() * 20);
      const spans = chunkSpans(t, { countTokens: words, maxTokens: max });
      const covered = new Set<string>();
      for (const s of spans) {
        const piece = t.slice(s.start, s.end);
        expect(piece).toBe(piece.trim());
        expect(piece.length).toBeGreaterThan(0);
        expect(words(piece)).toBeLessThanOrEqual(max);
        for (const w of piece.split(/\s+/u)) covered.add(w.replace(/[.!?]+$/u, ""));
      }
      for (const w of t.split(/\s+/u).filter(Boolean)) expect(covered.has(w.replace(/[.!?]+$/u, ""))).toBe(true);
      // Chunks are in text order.
      for (let i = 1; i < spans.length; i++) expect(spans[i]!.start).toBeGreaterThan(spans[i - 1]!.start);
    }
  });

  it("is deterministic", () => {
    const t = "Alpha beta. Gamma delta epsilon! Zeta?\nEta theta iota kappa lambda mu nu xi omicron pi.";
    const a = chunkSpans(t, { countTokens: words, maxTokens: 5 });
    const b = chunkSpans(t, { countTokens: words, maxTokens: 5 });
    expect(a).toEqual(b);
  });

  it("returns nothing for empty or whitespace-only messages and rejects a bad budget", () => {
    expect(chunkSpans("", { countTokens: words })).toEqual([]);
    expect(chunkSpans(" \n \t", { countTokens: words })).toEqual([]);
    expect(() => chunkSpans("x", { countTokens: words, maxTokens: 0 })).toThrow(RangeError);
    expect(() => chunkSpans("x", { countTokens: words, maxTokens: 1.5 })).toThrow(RangeError);
  });

  it("defaults to a 64-token budget", () => {
    const t = Array.from({ length: 100 }, (_, i) => `w${i}`).join(" ");
    expect(chunkSpans(t, { countTokens: words }).map((s) => words(t.slice(s.start, s.end)))).toEqual([64, 36]);
  });
});

describe("chunkMessages", () => {
  const opts = { countTokens: words, maxTokens: 4, tokenizerKey: "test-tokenizer" };
  const messages = [
    { sourceNodeId: "n1", text: "One two three. Four five six seven eight." },
    { sourceNodeId: "n2", text: "   " },
    { sourceNodeId: "n3", text: "Nine ten." },
  ];

  it("returns exact substrings with offsets, per-message indexes and token counts", () => {
    const chunks = chunkMessages(messages, opts);
    expect(chunks.map((c) => [c.sourceNodeId, c.chunkIndex, c.text, c.tokenCount])).toEqual([
      ["n1", 0, "One two three.", 3],
      ["n1", 1, "Four five six seven", 4],
      ["n1", 2, "eight.", 1],
      ["n3", 0, "Nine ten.", 2],
    ]);
    for (const c of chunks) {
      const source = messages.find((m) => m.sourceNodeId === c.sourceNodeId)!.text;
      expect(source.slice(c.start, c.end)).toBe(c.text);
    }
  });

  it("gives reproducible content-addressed ids", () => {
    const a = chunkMessages(messages, opts).map((c) => c.id);
    const b = chunkMessages(messages, opts).map((c) => c.id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
    for (const id of a) expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("changes ids when the tokenizer, budget, message or text changes", () => {
    const base = { tokenizerKey: "k", maxTokens: 64, sourceNodeId: "n1", chunkIndex: 0, start: 0, end: 5, text: "Hello" };
    const id = chunkId(base);
    expect(chunkId({ ...base })).toBe(id);
    expect(chunkId({ ...base, tokenizerKey: "k2" })).not.toBe(id);
    expect(chunkId({ ...base, maxTokens: 32 })).not.toBe(id);
    expect(chunkId({ ...base, sourceNodeId: "n2" })).not.toBe(id);
    expect(chunkId({ ...base, chunkIndex: 1 })).not.toBe(id);
    expect(chunkId({ ...base, text: "Hellp" })).not.toBe(id);
  });

  it("names its version", () => {
    expect(CHUNKER_VERSION).toBe("sentence-pack-v1");
  });
});
