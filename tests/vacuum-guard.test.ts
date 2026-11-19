import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A90: VACUUM may renumber rowids, and the search index refers to rows by
 * rowid. Production code may run VACUUM only through `vacuumDatabase` in
 * src/lib/search/fts-index.ts, which rebuilds and checks the index whenever
 * the tables are not empty. This fails on any other VACUUM statement (string
 * literals in non-test source files under src/, excluding generated code).
 */
const ALLOWED = path.join("src", "lib", "search", "fts-index.ts");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (p === path.join("src", "generated")) continue;
      out.push(...sourceFiles(p));
    } else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

describe("VACUUM guard", () => {
  it("only the sanctioned helper issues VACUUM", () => {
    const hits: string[] = [];
    for (const file of sourceFiles("src")) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (/^\s*(\*|\/\/|\/\*)/.test(line)) return; // comments may mention VACUUM
        if (/["'`]\s*VACUUM\b/i.test(line)) hits.push(`${file}:${i + 1}`);
      });
    }
    expect(hits.map((h) => h.split(":")[0])).toEqual([ALLOWED]);
  });
});
