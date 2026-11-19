import { describe, expect, it } from "vitest";
import { analyzeDrift, EXPECTED_SEARCH_INDEX_TABLES } from "../scripts/migration-drift.mjs";
import { SEARCH_INDEX_ALL_TABLES } from "../src/lib/search/fts-index";

/** The script Prisma 7.10.1 writes for the expected drift (shape measured in M2.0). */
function prismaDrops(tables: readonly string[]): string {
  return tables.map((t) => `-- DropTable\nPRAGMA foreign_keys=off;\nDROP TABLE "${t}";\nPRAGMA foreign_keys=on;\n`).join("\n");
}

describe("analyzeDrift (db:check-migrations)", () => {
  it("lists the same tables as the search-index module", () => {
    expect([...EXPECTED_SEARCH_INDEX_TABLES].sort()).toEqual([...SEARCH_INDEX_ALL_TABLES].sort());
  });

  it("accepts exactly the drops of the 10 search-index tables", () => {
    expect(analyzeDrift(prismaDrops(EXPECTED_SEARCH_INDEX_TABLES))).toEqual({ ok: true, unexpected: [], missing: [] });
  });

  it("rejects a missing search-index migration (empty diff)", () => {
    const r = analyzeDrift("-- This is an empty migration.\n");
    expect(r.ok).toBe(false);
    expect(r.missing).toHaveLength(10);
  });

  it("rejects when one shadow table is missing from the drops", () => {
    const r = analyzeDrift(prismaDrops(EXPECTED_SEARCH_INDEX_TABLES.filter((t) => t !== "message_fts_idx")));
    expect(r).toMatchObject({ ok: false, missing: ["message_fts_idx"] });
  });

  it.each([
    ["dropping an application table", `DROP TABLE "Message";`],
    ["an unknown extra table", `DROP TABLE "message_fts_extra";`],
    ["a column change", `ALTER TABLE "Conversation" ADD COLUMN "x" TEXT;`],
    ["a new table", `CREATE TABLE "Other" ("id" TEXT NOT NULL PRIMARY KEY);`],
    ["an index change", `CREATE INDEX "Message_role_idx" ON "Message"("role");`],
    ["a duplicate drop", `PRAGMA foreign_keys=off;\nDROP TABLE "message_fts";\nPRAGMA foreign_keys=on;`],
    ["a table rebuild Prisma uses for altered columns", `PRAGMA defer_foreign_keys=ON;\nCREATE TABLE "new_Message" ("id" TEXT);\nDROP TABLE "Message";\nALTER TABLE "new_Message" RENAME TO "Message";`],
  ])("rejects any other difference: %s", (_label, extra) => {
    const r = analyzeDrift(`${prismaDrops(EXPECTED_SEARCH_INDEX_TABLES)}\n${extra}\n`);
    expect(r.ok).toBe(false);
    expect(r.unexpected.length).toBeGreaterThan(0);
  });

  it("rejects unbalanced foreign_keys pragmas", () => {
    const r = analyzeDrift(`${prismaDrops(EXPECTED_SEARCH_INDEX_TABLES)}\nPRAGMA foreign_keys=off;\n`);
    expect(r.ok).toBe(false);
  });

  it("ignores comments and whitespace only", () => {
    const spaced = prismaDrops(EXPECTED_SEARCH_INDEX_TABLES).replace(/\n/g, "\n\n  ");
    expect(analyzeDrift(`-- generated\n${spaced}`).ok).toBe(true);
  });
});
