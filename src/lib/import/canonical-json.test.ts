import { describe, expect, it } from "vitest";
import { DEEP_CANARY, jsonTextDepth, nestedArrays } from "../../../tests/helpers/fixtures";
import { canonicalJson, exceedsJsonDepth, JsonTooDeepError, MAX_JSON_DEPTH } from "./canonical-json";

describe("canonicalJson", () => {
  it("sorts object keys recursively and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,1]},"b":1}',
    );
  });

  it("is independent of key insertion order", () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });

  it("sorts keys by UTF-16 code unit (uppercase before lowercase, é after z)", () => {
    expect(canonicalJson({ a: 1, B: 2, z: 3, é: 4 })).toBe('{"B":2,"a":1,"z":3,"é":4}');
  });

  it("omits undefined values but keeps null", () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it("uses shortest round-trip numbers, so 1.0 and 1 are the same after JSON.parse", () => {
    expect(canonicalJson(JSON.parse("[1.0, 1, 0.5, -0, 1e2]"))).toBe("[1,1,0.5,0,100]");
  });

  it("does not normalise Unicode", () => {
    const composed = "café";
    const decomposed = "café";
    expect(canonicalJson(composed)).not.toBe(canonicalJson(decomposed));
  });

  it("escapes strings deterministically, including control characters and quotes", () => {
    expect(canonicalJson('a"b\n\u0001')).toBe('"a\\"b\\n\\u0001"');
  });
});

describe("exceedsJsonDepth (F2)", () => {
  it("counts the root container as level 1 and primitives as no level", () => {
    expect(exceedsJsonDepth("text", 0)).toBe(false);
    expect(exceedsJsonDepth(null, 0)).toBe(false);
    expect(exceedsJsonDepth([], 1)).toBe(false);
    expect(exceedsJsonDepth([], 0)).toBe(true);
    expect(exceedsJsonDepth({ a: [{ b: [] }] }, 4)).toBe(false);
    expect(exceedsJsonDepth({ a: [{ b: [] }] }, 3)).toBe(true);
  });

  it.each([
    [511, false],
    [512, false],
    [513, true],
  ])("a value nested %i levels deep exceeds 512: %s", (levels, expected) => {
    const value = nestedArrays(levels);
    expect(jsonTextDepth(JSON.stringify(value))).toBe(levels);
    expect(exceedsJsonDepth(value, MAX_JSON_DEPTH)).toBe(expected);
  });

  it("finds a deep branch that is not the first child", () => {
    const value = { a: 1, b: [2, "x", { c: nestedArrays(600) }] };
    expect(exceedsJsonDepth(value, MAX_JSON_DEPTH)).toBe(true);
  });

  it("does not count width as depth", () => {
    const wide = Object.fromEntries(Array.from({ length: 100_000 }, (_, i) => [`k${i}`, [i]]));
    expect(exceedsJsonDepth(wide, 2)).toBe(false);
  });

  it("handles 1,000,000 levels of hostile nesting without throwing", () => {
    const n = 1_000_000;
    const value = JSON.parse("[".repeat(n) + "]".repeat(n)) as unknown;
    expect(exceedsJsonDepth(value, MAX_JSON_DEPTH)).toBe(true);
  });
});

describe("canonicalJson depth backstop (F2)", () => {
  it("serialises 512 levels like JSON.stringify", () => {
    const value = nestedArrays(512);
    expect(canonicalJson(value)).toBe(JSON.stringify(value));
  });

  it.each([513, 100_000])("throws JsonTooDeepError, not RangeError, at %i levels", (levels) => {
    const value = nestedArrays(levels);
    expect(() => canonicalJson(value)).toThrow(JsonTooDeepError);
    try {
      canonicalJson(value);
    } catch (e) {
      expect((e as Error).message).not.toContain(DEEP_CANARY);
    }
  });
});
