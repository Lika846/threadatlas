import { describe, expect, it } from "vitest";
import { quantizeInt8 } from "./quantize";
import { centre, chunkSelection, chunkVector, correctChunk, hasNearCopies, languageCorrectedVectors, languageMeans, REPEATED_IN, textKey, type ChunkInput, type CorrectedVectors } from "./conversation-vectors";
import { pack } from "./search/vector-cache";
import type { Lang } from "./topics/lang";

const DIMS = 16;
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const unitRandom = (r: () => number) => {
  const v = Float32Array.from({ length: DIMS }, () => r() * 2 - 1);
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};

/** A packed vector cache and the corrected vectors over it, as `correctedVectors` builds them (no database). */
function fixture(conversations: { lang: Lang; chunks: Float32Array[] }[]) {
  const rows = conversations.flatMap((c, ci) => c.chunks.map((v, k) => ({ conversationId: `c${ci}`, sourceNodeId: `n${k}`, start: 0, end: 1, tokenCount: 20, vector: quantizeInt8(v) })));
  const cache = pack("key", DIMS, rows);
  const chunkLang = rows.map((r) => conversations[Number(r.conversationId.slice(1))]!.lang);
  const inputs: ChunkInput[] = rows.map((r, i) => ({ conversation: Number(r.conversationId.slice(1)), lang: chunkLang[i]!, short: false, vector: chunkVector(cache, i) }));
  const means = languageMeans(DIMS, inputs);
  const vectors = languageCorrectedVectors(conversations.length, DIMS, inputs, means);
  const norms = Float32Array.from(inputs, (c) => Math.hypot(...c.vector.map((x, d) => x - means.get(c.lang)![d]!)));
  const ids = conversations.map((_, i) => `c${i}`);
  const cv: CorrectedVectors = { source: cache, ids, position: new Map(ids.map((id, i) => [id, i])), vectors, centred: centre(vectors), chunks: [], chunkLang, means, norms, cachePosition: Int32Array.from(ids, (_, i) => i), nearCopies: new Map() };
  return { cache, cv, inputs, means };
}

describe("hasNearCopies (boilerplate passages)", () => {
  const r = rng(3);
  const boilerplate = unitRandom(r);
  // 8 conversations, two chunks each; conversations 0–4 also contain the same boilerplate passage.
  const convs = Array.from({ length: 8 }, (_, i) => ({ lang: (i % 2 ? "no" : "en") as Lang, chunks: [unitRandom(r), unitRandom(r), ...(i < 5 ? [boilerplate] : [])] }));
  const { cache, cv, inputs, means } = fixture(convs);

  it("agrees with comparing fully corrected vectors", () => {
    const corrected = inputs.map((c) => correctChunk(c.vector, means.get(c.lang)!));
    for (let i = 0; i < cache.chunks; i++) {
      const others = new Set<number>();
      for (let k = 0; k < cache.chunks; k++) {
        if (cache.conversation[k] === cache.conversation[i]) continue;
        if (corrected[i]!.reduce((s, x, d) => s + x * corrected[k]![d]!, 0) >= 0.9) others.add(cache.conversation[k]!);
      }
      expect(hasNearCopies(cache, cv, i, 0.9, 3, 2)).toBe(others.size >= 3);
    }
  });

  it("flags a passage repeated in 3 or more other conversations, and nothing else", () => {
    cv.nearCopies.clear();
    const flagged = Array.from({ length: cache.chunks }, (_, i) => i).filter((i) => hasNearCopies(cache, cv, i, 0.9, 3, 2));
    expect(flagged).toHaveLength(5);
    for (const i of flagged) expect(cache.sourceNodeIds[i]).toBe("n2");
    // Shared by only 2 other conversations: not boilerplate.
    expect(hasNearCopies(cache, cv, flagged[0]!, 0.9, 5, 2)).toBe(false);
  });

  it("remembers answers per chunk", () => {
    cv.nearCopies.clear();
    expect(hasNearCopies(cache, cv, 0, 0.9, 3, 2)).toBe(false);
    expect(cv.nearCopies.size).toBe(1);
    cv.nearCopies.set("0:0.9:3:2", true); // a remembered answer is returned as is…
    expect(hasNearCopies(cache, cv, 0, 0.9, 3, 2)).toBe(true);
    expect(hasNearCopies(cache, cv, 0, 0.9, 2, 2)).toBe(false); // …only for the same thresholds
  });
});

describe("hasNearCopies: a passage repeated within related conversations is not boilerplate", () => {
  it("near-copies in related conversations don't count; in unrelated ones they do", () => {
    const r = rng(11);
    const shared = unitRandom(r);
    const topic = unitRandom(r);
    // Conversations 0–3 are one family (they share a topic chunk and a reused prompt); 4–11 are unrelated.
    const convs = Array.from({ length: 12 }, (_, i) => ({ lang: "en" as Lang, chunks: i < 4 ? [topic, shared, unitRandom(r)] : [unitRandom(r), unitRandom(r)] }));
    const { cache, cv } = fixture(convs);
    const prompt = Array.from({ length: cache.chunks }, (_, i) => i).find((i) => cache.conversation[i] === 0 && cache.sourceNodeIds[i] === "n1")!;
    expect(hasNearCopies(cache, cv, prompt, 0.9, 3, 0.35)).toBe(false); // copies only in its own family
    expect(hasNearCopies(cache, cv, prompt, 0.9, 3, 2)).toBe(true); // with no conversation counted as related
  });
});

describe("centre", () => {
  it("handles no vectors and leaves unit vectors", () => {
    expect(centre([])).toEqual([]);
    for (const v of centre([Float64Array.of(1, 0), Float64Array.of(0, 1), Float64Array.of(1, 1)])) expect(Math.hypot(...v)).toBeCloseTo(1, 9);
  });

  it("counts each distinct vector once: many copies don't move the mean", () => {
    const a = Float64Array.of(1, 0, 0);
    const b = Float64Array.of(0, 1, 0);
    const c = Float64Array.of(0, 0, 1);
    const once = centre([a, b, c]);
    const many = centre([a, ...Array.from({ length: 200 }, () => Float64Array.from(b)), c]);
    expect(many[0]).toEqual(once[0]);
    expect(many[1]).toEqual(once[1]);
    expect(many[201]).toEqual(once[2]);
  });
});

describe("languageMeans", () => {
  it("counts each distinct chunk vector once, per language and overall", () => {
    const v = (...x: number[]) => Float64Array.from(x);
    const chunks = (copies: number): ChunkInput[] => [
      { conversation: 0, lang: "en", short: false, vector: v(1, 0, 0) },
      ...Array.from({ length: copies }, (_, i) => ({ conversation: 1 + i, lang: "en" as Lang, short: false, vector: v(0, 1, 0) })),
      { conversation: 99, lang: "en", short: false, vector: v(0, 0, 1) },
    ];
    expect(languageMeans(3, chunks(300)).get("en")).toEqual(languageMeans(3, chunks(1)).get("en"));
    expect([...languageMeans(3, chunks(300)).get("en")!].map((x) => +x.toFixed(9))).toEqual([0.333333333, 0.333333333, 0.333333333]);
  });
});

describe("repeated text (chunkSelection, text keys)", () => {
  // The real model gives the same text slightly different vectors in different batches (up to
  // 0.02 per dimension measured), so repeats must be found by text, not by exact vector.
  const r = rng(21);
  const boilerplate = unitRandom(r);
  const noisy = () => Float64Array.from(boilerplate, (x) => x + (r() - 0.5) * 0.04);
  const archive = (copies: number, withKeys: boolean): ChunkInput[] =>
    Array.from({ length: copies }, (_, conversation) => [
      { conversation, lang: "en" as Lang, short: false, vector: Float64Array.from(unitRandom(r)), key: withKeys ? textKey(`content ${conversation}`) : undefined },
      { conversation, lang: "en" as Lang, short: false, vector: noisy(), key: withKeys ? textKey("I hope this helps!  Let me know…") : undefined },
    ]).flat();

  it(`leaves out text repeated in ${REPEATED_IN}+ conversations, found by text despite different vectors`, () => {
    const used = chunkSelection(archive(REPEATED_IN, true));
    expect(used.filter((_, i) => i % 2 === 1)).toEqual(Array(REPEATED_IN).fill(false)); // boilerplate left out
    expect(used.filter((_, i) => i % 2 === 0)).toEqual(Array(REPEATED_IN).fill(true));
    expect(chunkSelection(archive(REPEATED_IN, false)).every(Boolean)).toBe(true); // by vector, the copies look distinct
  });

  it("keeps repeated text that appears in fewer conversations (a prompt reused in a small group)", () => {
    expect(chunkSelection(archive(REPEATED_IN - 1, true)).every(Boolean)).toBe(true);
  });

  it("keeps it when that is all a conversation has (templates still have a vector, and identical ones match)", () => {
    const only = Array.from({ length: 12 }, (_, conversation) => ({ conversation, lang: "en" as Lang, short: false, vector: noisy(), key: textKey("template") }));
    expect(chunkSelection(only).every(Boolean)).toBe(true);
  });

  it("text keys ignore case and whitespace only", () => {
    expect(textKey("Hello   World\n")).toBe(textKey("hello world"));
    expect(textKey("hello world")).not.toBe(textKey("hello, world"));
  });

  it("centre counts conversations with the same key once", () => {
    const a = Float64Array.of(1, 0, 0), b = Float64Array.of(0, 1, 0), c = Float64Array.of(0, 0, 1);
    const copies = Array.from({ length: 50 }, () => Float64Array.from(b, (x) => x + 0.001));
    const withKeys = centre([a, ...copies, c], ["a", ...copies.map(() => "b"), "c"]);
    const once = centre([a, copies[49]!, c]);
    expect(withKeys[0]).toEqual(once[0]);
    expect(withKeys[51]).toEqual(once[2]);
  });
});

describe("degenerate archives", () => {
  it("only identical vectors: no NaN, no related conversations, no themes or topics", async () => {
    const { nearestConversations } = await import("./related/similarity");
    const { buildHierarchy } = await import("./topics/themes");
    const r = rng(5);
    const same = unitRandom(r);
    for (const langs of [["en"], ["en", "no", "ru"]] as Lang[][]) {
      const { cache, cv } = fixture(Array.from({ length: 12 }, (_, i) => ({ lang: langs[i % langs.length]!, chunks: [same, same] })));
      for (const v of [...cv.vectors, ...cv.centred]) expect(v.every(Number.isFinite)).toBe(true);
      for (let i = 0; i < cv.ids.length; i++) expect(nearestConversations(cv.centred, i)).toEqual([]);
      expect(buildHierarchy(cv.centred)).toEqual({ topicCut: null, themeCut: null, themes: [], other: cv.ids.map((_, i) => i) });
      for (let i = 0; i < cache.chunks; i++) expect(typeof hasNearCopies(cache, cv, i, 0.9, 3, 0.35)).toBe("boolean");
    }
  });

  it("identical conversations in a varied archive still match each other first", async () => {
    const { nearestConversations } = await import("./related/similarity");
    const r = rng(8);
    const twin = [unitRandom(r), unitRandom(r)];
    const convs = [...Array.from({ length: 30 }, () => ({ lang: "en" as Lang, chunks: [unitRandom(r), unitRandom(r)] })), { lang: "en" as Lang, chunks: twin }, { lang: "en" as Lang, chunks: twin }];
    const { cv } = fixture(convs);
    const [first] = nearestConversations(cv.centred, 30);
    expect(first!.index).toBe(31);
    expect(first!.similarity).toBeCloseTo(1, 6);
    expect(nearestConversations(cv.centred, 31)[0]!.index).toBe(30);
  });
});
