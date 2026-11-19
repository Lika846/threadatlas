import { describe, expect, it } from "vitest";
import { ADAPTER_VERSION } from "../chatgpt/adapter";
import { decide, type IncomingSummary, type StoredSummary } from "./decide";
import { compareParserVersions, parseContentHash, parseParserVersion } from "./versions";

const H = (c: string) => `v1:${c.repeat(64)}`;
const A = H("a");
const B = H("b");

const stored = (over: Partial<StoredSummary> = {}): StoredSummary => ({
  id: "internal-1",
  contentHash: A,
  updatedAtSec: 100,
  parserVersion: "0.3.0",
  ...over,
});
const incoming = (over: Partial<IncomingSummary> = {}): IncomingSummary => ({
  contentHash: A,
  updatedAt: 100,
  parserVersion: "0.3.0",
  ...over,
});

describe("parser version grammar", () => {
  it.each(["0.0.0", "0.3.0", "1.2.3", "10.20.30", "999999.0.1"])("accepts %s", (v) => {
    expect(parseParserVersion(v)).not.toBeNull();
  });

  it.each([
    "", "0.3", "0.3.0.1", "v0.3.0", "0.3.0-beta", "0.3.0+build", "01.0.0", "0.03.0", "0.3.00",
    " 0.3.0", "0.3.0 ", "0.3.0\n", "1000000.0.0", "-1.0.0", "1.e.0", "０.3.0", "0..0",
  ])("rejects %j", (v) => {
    expect(parseParserVersion(v)).toBeNull();
  });

  it.each([null, undefined, 3, ["0", "3", "0"], { major: 0 }])("rejects non-string %j", (v) => {
    expect(parseParserVersion(v)).toBeNull();
  });

  it("compares numerically, not as text", () => {
    const cmp = (a: string, b: string) => Math.sign(compareParserVersions(parseParserVersion(a)!, parseParserVersion(b)!));
    expect(cmp("0.10.0", "0.9.0")).toBe(1);
    expect(cmp("0.3.0", "0.3.0")).toBe(0);
    expect(cmp("0.3.0", "0.3.1")).toBe(-1);
    expect(cmp("1.0.0", "0.99.99")).toBe(1);
  });

  it("the running parser's own version is valid", () => {
    expect(parseParserVersion(ADAPTER_VERSION)).not.toBeNull();
  });
});

describe("content hash grammar", () => {
  it("accepts v1 with 64 lowercase hex digits", () => {
    expect(parseContentHash(A)).toEqual({ version: "v1", digest: "a".repeat(64) });
  });

  it.each([
    ["unknown version v2", `v2:${"a".repeat(64)}`],
    ["no version", "a".repeat(64)],
    ["uppercase hex", `v1:${"A".repeat(64)}`],
    ["63 digits", `v1:${"a".repeat(63)}`],
    ["65 digits", `v1:${"a".repeat(65)}`],
    ["non-hex", `v1:${"g".repeat(64)}`],
    ["v0", `v0:${"a".repeat(64)}`],
    ["trailing newline", `${A}\n`],
    ["empty", ""],
  ])("rejects %s", (_l, v) => {
    expect(parseContentHash(v)).toBeNull();
  });
});

describe("decide: state table cases 5–13", () => {
  it("5: nothing stored → add", () => {
    expect(decide(null, incoming())).toEqual({ kind: "add", case: 5 });
  });

  it("6: equal hash, same parser → unchanged", () => {
    expect(decide(stored(), incoming())).toEqual({ kind: "unchanged", case: 6 });
  });

  it("6: equal hash, stored by a newer parser → unchanged (never regress)", () => {
    expect(decide(stored({ parserVersion: "0.4.0" }), incoming())).toEqual({ kind: "unchanged", case: 6 });
  });

  it("7: equal hash, stored by an older parser → reprocess (parser upgrade)", () => {
    for (const old of ["0.2.9", "0.2.0", "0.0.1"]) {
      expect(decide(stored({ parserVersion: old }), incoming())).toEqual({ kind: "replace", case: 7, code: "CONVERSATION_REPROCESSED" });
    }
  });

  it("7: a parser refresh does not depend on times", () => {
    for (const t of [null, 50, 100, 150]) {
      expect(decide(stored({ parserVersion: "0.2.0", updatedAtSec: 100 }), incoming({ updatedAt: t })).kind).toBe("replace");
    }
  });

  it("8: different hash, incoming strictly newer → replace", () => {
    expect(decide(stored(), incoming({ contentHash: B, updatedAt: 100.000001 }))).toEqual({ kind: "replace", case: 8 });
    expect(decide(stored({ parserVersion: "0.2.0" }), incoming({ contentHash: B, updatedAt: 200 }))).toEqual({ kind: "replace", case: 8 });
  });

  it("9: different hash, incoming older → older (stored kept)", () => {
    expect(decide(stored(), incoming({ contentHash: B, updatedAt: 99 }))).toEqual({ kind: "older", case: 9, code: "CONVERSATION_OLDER" });
  });

  it("9: an older export with a newer parser is still older (no parser-driven overwrite)", () => {
    expect(decide(stored({ parserVersion: "0.2.0" }), incoming({ contentHash: B, updatedAt: 99 })).kind).toBe("older");
  });

  it("10: different hash, equal valid times → flagged", () => {
    expect(decide(stored(), incoming({ contentHash: B }))).toEqual({ kind: "flagged", case: 10, code: "CONVERSATION_VERSION_AMBIGUOUS" });
  });

  it.each<[string, number | null, number | null]>([
    ["incoming time missing", 100, null],
    ["stored time missing", null, 100],
    ["both missing", null, null],
    ["incoming NaN", 100, Number.NaN],
    ["incoming Infinity", 100, Number.POSITIVE_INFINITY],
    ["stored -Infinity", Number.NEGATIVE_INFINITY, 100],
  ])("11: different hash, %s → flagged (C9: never overwritten)", (_l, st, inc) => {
    expect(decide(stored({ updatedAtSec: st }), incoming({ contentHash: B, updatedAt: inc }))).toEqual({
      kind: "flagged",
      case: 11,
      code: "CONVERSATION_VERSION_AMBIGUOUS",
      field: "update_time",
    });
  });

  it("12: incoming newer but stored by a newer parser → flagged (parser downgrade)", () => {
    expect(decide(stored({ parserVersion: "0.4.0" }), incoming({ contentHash: B, updatedAt: 200 }))).toEqual({
      kind: "flagged",
      case: 12,
      code: "CONVERSATION_PARSER_DOWNGRADE",
    });
  });

  it("12 does not mask 9–11: older or ambiguous copies keep their own outcome", () => {
    const st = stored({ parserVersion: "0.4.0" });
    expect(decide(st, incoming({ contentHash: B, updatedAt: 50 })).case).toBe(9);
    expect(decide(st, incoming({ contentHash: B, updatedAt: 100 })).case).toBe(10);
    expect(decide(st, incoming({ contentHash: B, updatedAt: null })).case).toBe(11);
  });

  it.each([
    ["stored hash version v2 (hash-version mismatch)", { contentHash: `v2:${"a".repeat(64)}` }, "contentHash"],
    ["stored hash malformed", { contentHash: "v1:short" }, "contentHash"],
    ["stored hash empty", { contentHash: "" }, "contentHash"],
    ["stored parser version malformed", { parserVersion: "0.3" }, "parserVersion"],
    ["stored parser version with suffix", { parserVersion: "0.3.0-dev" }, "parserVersion"],
    ["stored parser version empty", { parserVersion: "" }, "parserVersion"],
  ] as const)("13: %s → flagged, never compared", (_l, over, field) => {
    // Even an otherwise identical or clearly newer copy is not written.
    for (const inc of [incoming(), incoming({ contentHash: B, updatedAt: 999 })]) {
      expect(decide(stored(over), inc)).toEqual({ kind: "flagged", case: 13, code: "CONVERSATION_STATE_UNRECOGNISED", field });
    }
  });

  it("13: an unrecognised incoming state is never written, even with nothing stored", () => {
    expect(decide(null, incoming({ contentHash: `v2:${"a".repeat(64)}` })).case).toBe(13);
    expect(decide(null, incoming({ parserVersion: "x" })).case).toBe(13);
    expect(decide(stored(), incoming({ parserVersion: "0.3.0.0" })).case).toBe(13);
  });

  it("exhaustive grid: a write happens only in cases 5, 7 and 8", () => {
    const hashes = [A, B];
    const times = [null, 50, 100, 150, Number.NaN];
    const parsers = ["0.2.0", "0.3.0", "0.4.0", "bad"];
    let writes = 0;
    for (const sh of hashes) for (const st of times) for (const sp of parsers)
      for (const ih of hashes) for (const it_ of times) for (const ip of parsers) {
        const d = decide({ id: "x", contentHash: sh, updatedAtSec: st, parserVersion: sp }, { contentHash: ih, updatedAt: it_, parserVersion: ip });
        if (d.kind !== "replace") continue;
        writes++;
        const sv = parseParserVersion(sp)!;
        const iv = parseParserVersion(ip)!;
        expect(sv).not.toBeNull();
        expect(iv).not.toBeNull();
        if (d.case === 7) {
          expect(sh).toBe(ih);
          expect(compareParserVersions(sv, iv)).toBeLessThan(0);
        } else {
          expect(sh).not.toBe(ih);
          expect(Number.isFinite(st) && Number.isFinite(it_) && it_! > st!).toBe(true);
          expect(compareParserVersions(sv, iv)).toBeLessThanOrEqual(0);
        }
      }
    expect(writes).toBeGreaterThan(0);
  });
});
