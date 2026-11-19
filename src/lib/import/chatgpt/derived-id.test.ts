import { describe, expect, it } from "vitest";
import { nestedArrays } from "../../../../tests/helpers/fixtures";
import { JsonTooDeepError } from "../canonical-json";
import { deriveConversationId } from "./derived-id";

const node = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  id,
  message: {
    id,
    author: { role: "user" },
    create_time: 1,
    content: { content_type: "text", parts: [text] },
    ...extra,
  },
  parent: null,
  children: [],
});

describe("deriveConversationId (proposal v1, Q11)", () => {
  const mapping = { n1: node("n1", "synthetic canary"), n2: node("n2", "more canary") };

  it("produces a versioned SHA-256 identifier", () => {
    expect(deriveConversationId(100, mapping)).toMatch(/^derived:v1:[0-9a-f]{64}$/);
  });

  it("is deterministic and independent of mapping key order", () => {
    const reordered = { n2: mapping.n2, n1: mapping.n1 };
    expect(deriveConversationId(100, reordered)).toBe(deriveConversationId(100, mapping));
  });

  it("changes when message content or create_time changes", () => {
    const base = deriveConversationId(100, mapping);
    expect(deriveConversationId(101, mapping)).not.toBe(base);
    expect(
      deriveConversationId(100, { ...mapping, n2: node("n2", "different canary") }),
    ).not.toBe(base);
  });

  it("ignores metadata and unknown fields (stable across export versions)", () => {
    const base = deriveConversationId(100, mapping);
    const withExtras = {
      n1: { ...node("n1", "synthetic canary", { metadata: { x: 1 }, update_time: 9 }), x_new: 1 },
      n2: mapping.n2,
    };
    expect(deriveConversationId(100, withExtras)).toBe(base);
  });

  it("does not normalise Unicode (distinct encodings stay distinct)", () => {
    const composed = { n1: node("n1", "caf\u00e9 canary") };
    const decomposed = { n1: node("n1", "cafe\u0301 canary") };
    expect(deriveConversationId(1, composed)).not.toBe(deriveConversationId(1, decomposed));
  });

  it("returns null when there is no message content", () => {
    expect(deriveConversationId(1, {})).toBeNull();
    expect(
      deriveConversationId(1, { root: { id: "root", message: null, parent: null, children: [] } }),
    ).toBeNull();
    expect(
      deriveConversationId(1, { n: { id: "n", message: { id: "n", content: null } } }),
    ).toBeNull();
  });
});

describe("deriveConversationId depth backstop (F2)", () => {
  it("throws JsonTooDeepError instead of overflowing the stack on over-deep input", () => {
    const mapping = { n1: node("n1", "x", { content: { content_type: "text", parts: [nestedArrays(100_000)] } }) };
    expect(() => deriveConversationId(1, mapping)).toThrow(JsonTooDeepError);
  });
});
