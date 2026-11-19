/** Search by meaning (M5.2): gated fusion, best chunk per conversation, query parsing, notices. */
import { describe, expect, it } from "vitest";
import { matchedByLabel, noticeMessage } from "../../search/messages";
import { parseMeaningQuery } from "../../search/query";
import { quantizeInt8 } from "../quantize";
import { CLOSE_MATCH_MARGIN, closeMatches, fuse, MEANING_RESULTS, RRF_K } from "./meaning-search";
import { MIN_SEARCH_TOKENS, pack, topConversations } from "./vector-cache";

const ids = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}${String(i).padStart(3, "0")}`);

describe("fuse (ADR 0002 decision 7)", () => {
  it("no exact-word results: meaning only, in meaning order, at most 50 distinct", () => {
    const r = fuse(ids(80, "m"), []);
    expect(r).toHaveLength(MEANING_RESULTS);
    expect(r.map((x) => x.id)).toEqual(ids(50, "m"));
    expect(new Set(r.map((x) => x.matchedBy))).toEqual(new Set(["meaning"]));
  });

  it("with exact-word results: reciprocal rank fusion (k = 60); conversations in both lists lead", () => {
    const r = fuse(["a", "b", "c"], ["c", "d"]);
    // c: 1/63 + 1/61; a: 1/61; d: 1/62; b: 1/62 (b leads d: meaning first on ties)
    expect(r).toEqual([
      { id: "c", matchedBy: "both" },
      { id: "a", matchedBy: "meaning" },
      { id: "b", matchedBy: "meaning" },
      { id: "d", matchedBy: "words" },
    ]);
    expect(1 / (RRF_K + 3) + 1 / (RRF_K + 1)).toBeGreaterThan(1 / (RRF_K + 1));
  });

  it("returns at most 50 distinct conversations from both lists", () => {
    const r = fuse(ids(50, "m"), [...ids(30, "m"), ...ids(70, "w")]);
    expect(r).toHaveLength(50);
    expect(new Set(r.map((x) => x.id)).size).toBe(50);
    expect(r.slice(0, 30).every((x) => x.matchedBy === "both")).toBe(true);
  });
});

describe("closeMatches (relevance cutoff)", () => {
  const hit = (conversationId: string, score: number, short = false) => ({ conversationId, score, sourceNodeId: "n", start: 0, end: 1, short });
  const hits = [hit("best", 0.85), hit("near", 0.85 - CLOSE_MATCH_MARGIN), hit("far", 0.85 - CLOSE_MATCH_MARGIN - 0.001), hit("both", 0.7)];

  it(`keeps meaning matches within ${CLOSE_MATCH_MARGIN} of the best, and every exact-word match`, () => {
    const fused = [
      { id: "best", matchedBy: "meaning" as const },
      { id: "near", matchedBy: "meaning" as const },
      { id: "far", matchedBy: "meaning" as const },
      { id: "both", matchedBy: "both" as const },
      { id: "words-only", matchedBy: "words" as const },
    ];
    expect([...closeMatches(fused, hits)].sort()).toEqual(["best", "both", "near", "words-only"]);
  });

  it("a conversation scored only by very short chunks is never close to a longer best match, whatever its score", () => {
    const fused = [
      { id: "best", matchedBy: "meaning" as const },
      { id: "chatter", matchedBy: "meaning" as const },
    ];
    expect([...closeMatches(fused, [hit("best", 0.82), hit("chatter", 0.86, true)])]).toEqual(["best"]);
    // An archive of only short messages: compared among themselves.
    expect([...closeMatches(fused, [hit("best", 0.82, true), hit("chatter", 0.81, true)])].sort()).toEqual(["best", "chatter"]);
  });

  it("with no meaning hits, only exact-word matches are close", () => {
    expect([...closeMatches([{ id: "w", matchedBy: "words" }], [])]).toEqual(["w"]);
  });
});

describe("the vector cache", () => {
  const dims = 4;
  const unit = (...v: number[]) => {
    const n = Math.hypot(...v);
    return Float32Array.from(v.map((x) => x / n));
  };
  const row = (conversationId: string, sourceNodeId: string, start: number, v: Float32Array, tokenCount = 20) => ({ conversationId, sourceNodeId, start, end: start + 10, tokenCount, vector: quantizeInt8(v) });

  it("scores each conversation by its best chunk and returns that chunk", () => {
    const cache = pack("k", dims, [
      row("c1", "n1", 0, unit(1, 0, 0, 0)),
      row("c1", "n2", 5, unit(0, 1, 0, 0)),
      row("c2", "n1", 0, unit(0.6, 0.8, 0, 0)),
      row("c3", "n9", 3, unit(0, 0, 1, 0)),
    ]);
    const hits = topConversations(cache, unit(0, 1, 0, 0), 10);
    expect(hits.map((h) => h.conversationId)).toEqual(["c1", "c2", "c3"]);
    expect(hits[0]).toMatchObject({ sourceNodeId: "n2", start: 5, end: 15 });
    expect(hits[0]!.score).toBeCloseTo(1, 2);
    expect(hits[1]!.score).toBeCloseTo(0.8, 2);
    expect(topConversations(cache, unit(0, 1, 0, 0), 2)).toHaveLength(2);
  });

  it(`demotes chunks under ${MIN_SEARCH_TOKENS} tokens: they count only when the conversation has nothing longer`, () => {
    const cache = pack("k", dims, [
      // "thanks!"-like: the closest vector to the query, but short.
      row("chatter", "n1", 0, unit(1, 0.05, 0, 0), 2),
      row("chatter", "n2", 0, unit(0, 0, 1, 0), 30),
      row("answer", "n1", 0, unit(0.9, 0.3, 0, 0), 30),
      // Only short chunks: still found, after every conversation with a longer match.
      row("tiny", "n1", 0, unit(1, 0, 0, 0), 3),
    ]);
    const hits = topConversations(cache, unit(1, 0, 0, 0), 10);
    expect(hits.map((h) => h.conversationId)).toEqual(["answer", "chatter", "tiny"]);
    expect(hits[1]).toMatchObject({ sourceNodeId: "n2" }); // its long chunk, never the short one
    expect(hits[2]!.score).toBeCloseTo(1, 2);
  });

  it("a chunk of exactly the threshold counts normally", () => {
    const cache = pack("k", dims, [row("a", "n1", 0, unit(1, 0, 0, 0), MIN_SEARCH_TOKENS), row("b", "n1", 0, unit(0.5, 0.5, 0, 0), 40)]);
    expect(topConversations(cache, unit(1, 0, 0, 0), 2).map((h) => h.conversationId)).toEqual(["a", "b"]);
  });

  it("returns nothing for a query of another dimension, and handles an empty index", () => {
    const cache = pack("k", dims, [row("c1", "n1", 0, unit(1, 0, 0, 0))]);
    expect(topConversations(cache, new Float32Array(3), 5)).toEqual([]);
    expect(topConversations(pack("e", dims, []), unit(1, 0, 0, 0), 5)).toEqual([]);
  });
});

describe("parseMeaningQuery", () => {
  it("keeps the text as typed (trimmed; control characters as spaces)", () => {
    expect(parseMeaningQuery('  ideas about "garden" budgets*\n')).toEqual({ ok: true, text: 'ideas about "garden" budgets*' });
  });

  it.each([
    [undefined, "empty"],
    ["   ", "empty"],
    ["?! …", "no_terms"],
    ["a".repeat(257), "too_long"],
  ])("refuses %j (%s)", (input, reason) => {
    expect(parseMeaningQuery(input)).toMatchObject({ ok: false, rejection: { reason } });
  });

  it("allows more than 16 words (no term syntax)", () => {
    expect(parseMeaningQuery(Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ")).ok).toBe(true);
  });
});

describe("messages", () => {
  it("labels and notices are static text and counts", () => {
    expect(matchedByLabel("both")).toBe("Similar meaning · matches your words");
    expect(noticeMessage({ kind: "partial", notIndexed: 3 })).toBe("3 conversations aren't indexed yet; they appear only when the exact words match.");
    expect(noticeMessage({ kind: "fallback", reason: "MODEL_MISSING" })).toContain("npm run model:fetch");
  });
});

describe("usesProductionModel (whether the genericness correction applies)", () => {
  it("is true for the production inference child, false for the test suite's fake model or an invalid override", async () => {
    const { usesProductionModel } = await import("./meaning-search");
    const root = process.cwd();
    expect(usesProductionModel({ env: {}, root })).toBe(true);
    expect(usesProductionModel({ env: { VITEST: "1", THREADATLAS_INFERENCE_ENTRY: "tests/helpers/fake-inference-child.mts" }, root })).toBe(false);
    expect(usesProductionModel({ env: { VITEST: "1", THREADATLAS_INFERENCE_ENTRY: "somewhere/else.mts" }, root })).toBe(false);
    // Outside a test runner the override is ignored: production.
    expect(usesProductionModel({ env: { THREADATLAS_INFERENCE_ENTRY: "tests/helpers/fake-inference-child.mts" }, root })).toBe(true);
  });
});
