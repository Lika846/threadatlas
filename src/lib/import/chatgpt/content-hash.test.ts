import { describe, expect, it } from "vitest";
import { fixtureText, nestedArrays } from "../../../../tests/helpers/fixtures";
import { JsonTooDeepError } from "../canonical-json";
import { parseExportText } from "../validate-export";
import { canonicalContentV1, computeContentHash, type ContentHashInput } from "./content-hash";

const base: ContentHashInput = {
  title: "t",
  createTime: 100,
  updateTime: 200,
  currentNode: "a",
  mapping: {
    a: { id: "a", parent: null, children: [], message: { author: { role: "user" }, content: { content_type: "text", parts: ["x"] }, metadata: { m: 1 } } },
  },
};

function hashOfText(text: string): string {
  const res = parseExportText(text);
  if (!res.ok) throw new Error("expected ok");
  return res.conversations[0]!.contentHash;
}

describe("computeContentHash (A21)", () => {
  it("is versioned and deterministic", () => {
    expect(computeContentHash(base)).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(computeContentHash(base)).toBe(computeContentHash({ ...base }));
  });

  it("documents the canonical form", () => {
    expect(canonicalContentV1({ title: null, createTime: null, updateTime: null, currentNode: null, mapping: {} })).toBe(
      '{"create_time":null,"current_node":null,"mapping":{},"title":null,"update_time":null,"v":1}',
    );
  });

  it("is independent of key order at every level", () => {
    const reordered: ContentHashInput = {
      mapping: {
        a: { message: { metadata: { m: 1 }, content: { parts: ["x"], content_type: "text" }, author: { role: "user" } }, children: [], parent: null, id: "a" },
      },
      currentNode: "a",
      updateTime: 200,
      createTime: 100,
      title: "t",
    };
    expect(computeContentHash(reordered)).toBe(computeContentHash(base));
  });

  it.each([
    ["title", { title: "u" }],
    ["create time", { createTime: 101 }],
    ["update time", { updateTime: 201 }],
    ["current node", { currentNode: null }],
  ] as const)("changes when the %s changes", (_label, change) => {
    expect(computeContentHash({ ...base, ...change })).not.toBe(computeContentHash(base));
  });

  it("changes when anything in the mapping changes: content, metadata, structure", () => {
    const a = base.mapping.a as Record<string, unknown> & { message: Record<string, unknown> };
    const variants = [
      { a: { ...a, message: { ...a.message, content: { content_type: "text", parts: ["y"] } } } },
      { a: { ...a, message: { ...a.message, metadata: { m: 2 } } } },
      { a: { ...a, children: ["b"] } },
      { a, b: { id: "b", parent: "a", children: [], message: null } },
    ];
    for (const mapping of variants) {
      expect(computeContentHash({ ...base, mapping })).not.toBe(computeContentHash(base));
    }
  });

  it("does not normalise Unicode", () => {
    const withText = (s: string) => ({ ...base, title: s });
    expect(computeContentHash(withText("café"))).not.toBe(computeContentHash(withText("café")));
  });
});

describe("content hash in the parse pipeline", () => {
  const one = (extra: Record<string, unknown>) =>
    JSON.stringify([{ conversation_id: "c1", title: "t", update_time: 5, mapping: { a: { parent: null, children: [] } }, ...extra }]);

  it("ignores conversation-level fields that ThreadAtlas does not store", () => {
    expect(hashOfText(one({ is_archived: true, _synthetic: true, x_new: { a: 1 } }))).toBe(hashOfText(one({})));
  });

  it("ignores the conversation ID (it is the comparison key, not content)", () => {
    expect(hashOfText(one({ conversation_id: "c2" }))).toBe(hashOfText(one({})));
  });

  it("hashes validated values: a wrong-typed or malformed field counts as missing", () => {
    expect(hashOfText(one({ title: 42 }))).toBe(hashOfText(one({ title: null })));
    expect(hashOfText(one({ update_time: "garbage" }))).toBe(hashOfText(one({ update_time: null })));
  });

  it("treats equivalent number spellings and timestamp forms the same", () => {
    expect(hashOfText(one({ update_time: 5 }).replace('"update_time":5', '"update_time":5.0'))).toBe(hashOfText(one({})));
    expect(hashOfText(one({ update_time: "1970-01-01T00:00:05Z" }))).toBe(hashOfText(one({})));
  });

  it("does not depend on import time (no import metadata is an input)", () => {
    const text = fixtureText("branching.json");
    const a = parseExportText(text, { nowMs: 0 });
    const b = parseExportText(text, { nowMs: Date.UTC(2030, 0, 1) });
    if (!a.ok || !b.ok) throw new Error("expected ok");
    expect(a.conversations[0]!.contentHash).toBe(b.conversations[0]!.contentHash);
  });
});

describe("computeContentHash depth backstop (F2)", () => {
  it("throws JsonTooDeepError instead of overflowing the stack on over-deep input", () => {
    expect(() => computeContentHash({ ...base, mapping: { a: nestedArrays(100_000) } })).toThrow(JsonTooDeepError);
  });
});
