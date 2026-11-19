import { describe, expect, it } from "vitest";
import { normalizeTimestamp, parseIsoTimestamp, validSeconds } from "./timestamps";

const NOW_MS = Date.UTC(2026, 10, 3); // 2026-11-03, fixed for determinism

describe("normalizeTimestamp (A22)", () => {
  it("treats null and undefined as missing", () => {
    expect(normalizeTimestamp(null, NOW_MS)).toEqual({ status: "missing" });
    expect(normalizeTimestamp(undefined, NOW_MS)).toEqual({ status: "missing" });
  });

  it("accepts epoch seconds and keeps their precision exactly", () => {
    expect(normalizeTimestamp(1767225600.123456, NOW_MS)).toEqual({
      status: "valid",
      seconds: 1767225600.123456,
      unusual: false,
    });
  });

  it("rejects non-finite and unrepresentable numbers", () => {
    for (const v of [Infinity, -Infinity, NaN, 1e300, -1e300, 8.64e12 + 1]) {
      expect(normalizeTimestamp(v, NOW_MS)).toEqual({ status: "invalid" });
    }
    expect(normalizeTimestamp(8.64e12, NOW_MS).status).toBe("valid"); // the Date maximum
  });

  it("has no historical cutoff; very old or far-future values are kept and marked unusual", () => {
    expect(normalizeTimestamp(0, NOW_MS)).toEqual({ status: "valid", seconds: 0, unusual: true });
    expect(normalizeTimestamp(-86400, NOW_MS)).toMatchObject({ status: "valid", unusual: true });
    // Milliseconds mistaken for seconds land around the year 57,000.
    expect(normalizeTimestamp(1767225600000, NOW_MS)).toMatchObject({
      status: "valid",
      unusual: true,
    });
    expect(normalizeTimestamp(NOW_MS / 1000 + 3600, NOW_MS)).toMatchObject({ unusual: false });
    expect(normalizeTimestamp(NOW_MS / 1000 + 2 * 86400, NOW_MS)).toMatchObject({
      unusual: true,
    });
  });

  it("treats other types as invalid", () => {
    for (const v of [true, {}, [], "1767225600"]) {
      expect(normalizeTimestamp(v, NOW_MS)).toEqual({ status: "invalid" });
    }
  });
});

describe("parseIsoTimestamp", () => {
  it.each([
    ["2026-01-01", 1767225600],
    ["2026-01-01T00:00:00Z", 1767225600],
    ["2026-01-01T00:00Z", 1767225600],
    ["2026-01-01T05:30:00+05:30", 1767225600],
    ["2025-12-31T23:00:00-01:00", 1767225600],
    ["2026-01-01T00:00:00.5Z", 1767225600.5],
    ["2024-02-29T00:00:00Z", 1709164800],
    ["0050-01-01", -60589296000], // years below 100 are not shifted to 19xx
  ])("parses %s", (text, seconds) => {
    expect(parseIsoTimestamp(text)).toBeCloseTo(seconds, 6);
  });

  it("keeps sub-millisecond fractions", () => {
    expect(parseIsoTimestamp("2026-01-01T00:00:00.123456Z")! - 1767225600).toBeCloseTo(
      0.123456,
      6,
    );
  });

  it.each([
    "2026-02-30",
    "2025-02-29T00:00:00Z",
    "2026-13-01",
    "2026-01-01T24:00:00Z",
    "2026-01-01T00:00:60Z",
    "2026-01-01T00:00:00", // no offset: would depend on the machine's time zone
    "2026-01-01 00:00:00Z",
    "not-a-date",
    "",
    "1767225600",
    "2026-01-01T00:00:00+25:00",
  ])("rejects %j", (text) => {
    expect(parseIsoTimestamp(text)).toBeNull();
  });
});

describe("validSeconds", () => {
  it("returns seconds only for valid values", () => {
    expect(validSeconds(10)).toBe(10);
    expect(validSeconds("2026-01-01")).toBe(1767225600);
    expect(validSeconds("bad")).toBeUndefined();
    expect(validSeconds(1e300)).toBeUndefined();
    expect(validSeconds(null)).toBeUndefined();
  });
});
