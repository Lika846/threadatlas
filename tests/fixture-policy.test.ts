import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Fixture safeguard (A7/A18, D13/D23). This catches accidental drops of
 * non-synthetic files; it cannot prove data is fictional.
 */

const FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures", "chatgpt");
const MAX_FIXTURE_BYTES = 32 * 1024;
const ALLOWED_NON_JSON = new Set(["README.md"]);

export function checkFixture(name: string, bytes: number, text: string): string[] {
  const problems: string[] = [];
  if (!name.endsWith(".json")) {
    if (!ALLOWED_NON_JSON.has(name)) problems.push("not a .json fixture");
    return problems;
  }
  if (bytes > MAX_FIXTURE_BYTES) problems.push(`larger than ${MAX_FIXTURE_BYTES} bytes`);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    problems.push("not valid JSON (use inline strings in tests for malformed input)");
    return problems;
  }
  if (!Array.isArray(data)) {
    problems.push("top level is not an array");
    return problems;
  }
  const objects = data.filter(
    (e): e is Record<string, unknown> =>
      typeof e === "object" && e !== null && !Array.isArray(e),
  );
  if (objects.length === 0) problems.push("contains no conversation objects");
  objects.forEach((o) => {
    if (o._synthetic !== true) problems.push('an object entry lacks "_synthetic": true');
  });
  return problems;
}

describe("fixture policy", () => {
  const entries = readdirSync(FIXTURE_DIR);

  it("has fixtures to check", () => {
    expect(entries.filter((e) => e.endsWith(".json")).length).toBeGreaterThan(0);
  });

  it.each(entries)("%s satisfies the synthetic-fixture rules", (name) => {
    const full = path.join(FIXTURE_DIR, name);
    const stat = statSync(full);
    expect(stat.isFile(), "subdirectories are not allowed").toBe(true);
    const problems = checkFixture(name, stat.size, readFileSync(full, "utf8"));
    expect(problems).toEqual([]);
  });

  describe("the checker itself", () => {
    const ok = JSON.stringify([{ _synthetic: true, mapping: {} }]);

    it("accepts a compliant fixture", () => {
      expect(checkFixture("x.json", ok.length, ok)).toEqual([]);
    });

    it.each([
      ["missing marker", JSON.stringify([{ mapping: {} }])],
      ["marker not strictly true", JSON.stringify([{ _synthetic: "yes" }])],
      ["one entry without marker", JSON.stringify([{ _synthetic: true }, { title: "x" }])],
      ["object top level", JSON.stringify({ _synthetic: true })],
      ["no objects", JSON.stringify([1, 2])],
      ["invalid JSON", "[{"],
    ])("rejects: %s", (_label, text) => {
      expect(checkFixture("x.json", text.length, text)).not.toEqual([]);
    });

    it("rejects oversized and non-JSON files", () => {
      expect(checkFixture("big.json", MAX_FIXTURE_BYTES + 1, ok)).not.toEqual([]);
      expect(checkFixture("export.zip", 10, "")).not.toEqual([]);
      expect(checkFixture("README.md", 10, "")).toEqual([]);
    });
  });
});
