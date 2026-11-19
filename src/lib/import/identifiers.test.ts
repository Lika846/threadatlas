import { describe, expect, it } from "vitest";
import { exceedsIdLength, MAX_ID_LENGTH } from "./identifiers";

const EMOJI = "\u{1F600}"; // one code point, two UTF-16 code units

describe("exceedsIdLength (Q12)", () => {
  it("allows exactly 512 code points", () => {
    expect(MAX_ID_LENGTH).toBe(512);
    expect(exceedsIdLength("a".repeat(511))).toBe(false);
    expect(exceedsIdLength("a".repeat(512))).toBe(false);
    expect(exceedsIdLength("a".repeat(513))).toBe(true);
  });

  it("counts code points, not UTF-16 code units", () => {
    expect(exceedsIdLength(EMOJI.repeat(512))).toBe(false); // 1,024 code units
    expect(exceedsIdLength(EMOJI.repeat(513))).toBe(true);
    expect(exceedsIdLength("a" + EMOJI.repeat(511))).toBe(false);
    expect(exceedsIdLength("ab" + EMOJI.repeat(511))).toBe(true);
  });

  it("counts a lone surrogate as one code point", () => {
    expect(exceedsIdLength("\uD800".repeat(512))).toBe(false);
    expect(exceedsIdLength("\uD800".repeat(513))).toBe(true);
  });

  it("decides a 10 MB string without scanning it", () => {
    expect(exceedsIdLength("x".repeat(10_000_000))).toBe(true);
  });

  it("treats the empty string as within the limit", () => {
    expect(exceedsIdLength("")).toBe(false);
  });
});
