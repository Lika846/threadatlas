// Migration-drift analysis for `npm run db:check-migrations` (M2.1, A91).
//
// Prisma cannot describe the FTS5 search index (virtual tables), so
// `prisma migrate diff --from-migrations prisma/migrations --to-schema
// prisma/schema.prisma --script` always proposes to drop it. This accepts
// exactly that difference and nothing else:
// - one `DROP TABLE "<name>"` for each of the 10 expected tables (2 virtual and
//   8 shadow), each exactly once, none missing;
// - the `PRAGMA foreign_keys=off` / `PRAGMA foreign_keys=on` pair Prisma wraps
//   around each drop, exactly one pair per drop;
// - no other statement of any kind.
// A missing search-index migration (no drops at all) is drift as well.
// Prisma ignores triggers, so they are checked by src/lib/db/schema.int.test.ts.
//
// Keep EXPECTED_SEARCH_INDEX_TABLES equal to SEARCH_INDEX_ALL_TABLES in
// src/lib/search/fts-index.ts (tests/migration-drift.test.ts checks this).

export const EXPECTED_SEARCH_INDEX_TABLES = Object.freeze([
  "message_fts",
  "message_fts_config",
  "message_fts_data",
  "message_fts_docsize",
  "message_fts_idx",
  "conversation_fts",
  "conversation_fts_config",
  "conversation_fts_data",
  "conversation_fts_docsize",
  "conversation_fts_idx",
]);

/**
 * @param {string} script SQL written by `prisma migrate diff --script`
 * @returns {{ ok: boolean, unexpected: string[], missing: string[] }}
 */
export function analyzeDrift(script) {
  const statements = script
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s !== "");
  const expected = new Set(EXPECTED_SEARCH_INDEX_TABLES);
  const dropped = new Set();
  const unexpected = [];
  let pragmaOff = 0;
  let pragmaOn = 0;
  for (const st of statements) {
    if (st === "PRAGMA foreign_keys=off") {
      pragmaOff++;
      continue;
    }
    if (st === "PRAGMA foreign_keys=on") {
      pragmaOn++;
      continue;
    }
    const m = /^DROP TABLE "([A-Za-z0-9_]+)"$/.exec(st);
    if (m && expected.has(m[1]) && !dropped.has(m[1])) {
      dropped.add(m[1]);
      continue;
    }
    unexpected.push(st);
  }
  if (pragmaOff !== dropped.size || pragmaOn !== dropped.size) {
    unexpected.push(`PRAGMA foreign_keys: ${pragmaOff} off / ${pragmaOn} on for ${dropped.size} expected drops`);
  }
  const missing = EXPECTED_SEARCH_INDEX_TABLES.filter((t) => !dropped.has(t));
  return { ok: unexpected.length === 0 && missing.length === 0, unexpected, missing };
}
