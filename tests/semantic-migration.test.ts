import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The semantic-index migration (M5.1b) is the reviewed file, byte for byte, and only
 * ADDS three tables and two indexes. Approved by the owner on 2026-11-11 with its
 * SHA-256; any change to the file must go through review again.
 *
 * Every statement must be one of:
 * - CREATE TABLE "EmbeddingIndex" | "EmbeddingStatus" | "EmbeddingChunk" (...)
 * - CREATE INDEX "Embedding…" ON "EmbeddingStatus" | "EmbeddingChunk"(...)
 * between exactly one BEGIN (first) and one COMMIT (last), so a failure rolls
 * everything back (Prisma does not wrap SQLite migrations). Anything else (DROP,
 * DELETE, UPDATE, ALTER, INSERT, PRAGMA, a trigger, a table with another name) fails.
 */
const FILE = path.join(process.cwd(), "prisma", "migrations", "20261111120000_semantic_index", "migration.sql");
const REVIEWED_SHA256 = "e761409da750d7c12f6ac146335cd792b1f92a47394d9e65e4f5d6ed5771598d";
const REVIEWED_COPY = path.join(process.cwd(), "docs", "spikes", "m5.1b", "migration", "migration.sql");

function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((s) => `${s};`);
}

const TABLE = /^CREATE TABLE "(EmbeddingIndex|EmbeddingStatus|EmbeddingChunk)" \([^;]*\);$/;
const INDEX = /^CREATE INDEX "Embedding(Status|Chunk)_[A-Za-z_]+_idx" ON "Embedding(Status|Chunk)"\("[A-Za-z]+"(, "[A-Za-z]+")*\);$/;
/** Inside a CREATE TABLE: only column definitions, the primary key and cascading foreign keys to Conversation. */
const FORBIDDEN_IN_TABLE = /\b(DROP|DELETE FROM|UPDATE "|ALTER|INSERT|PRAGMA|TRIGGER|AUTOINCREMENT|REFERENCES "(?!Conversation")|CHECK)\b/i;

function unsafe(st: string): string | null {
  if (INDEX.test(st)) return null;
  if (TABLE.test(st) && !FORBIDDEN_IN_TABLE.test(st)) return null;
  return st;
}

describe("semantic-index migration (M5.1b)", () => {
  const bytes = fs.readFileSync(FILE);
  const sql = bytes.toString("utf8");
  const sts = statements(sql);

  it("is byte-identical to the reviewed file (SHA-256 approved 2026-11-11)", () => {
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(REVIEWED_SHA256);
    expect(bytes.equals(fs.readFileSync(REVIEWED_COPY))).toBe(true);
  });

  it("is one transaction of 3 CREATE TABLE and 2 CREATE INDEX, nothing else", () => {
    expect(sts[0]).toBe("BEGIN;");
    expect(sts[sts.length - 1]).toBe("COMMIT;");
    const inner = sts.slice(1, -1);
    expect(inner.map(unsafe).filter((x) => x !== null)).toEqual([]);
    expect(inner.filter((s) => TABLE.test(s)).map((s) => TABLE.exec(s)![1])).toEqual(["EmbeddingIndex", "EmbeddingStatus", "EmbeddingChunk"]);
    expect(inner.filter((s) => INDEX.test(s))).toHaveLength(2);
    expect(inner).toHaveLength(5);
  });

  it.each([
    ["a row deletion", `DELETE FROM "Message";`],
    ["a table drop", `DROP TABLE "message_fts";`],
    ["an update", `UPDATE "Message" SET "contentText" = '';`],
    ["a schema change", `ALTER TABLE "Message" ADD COLUMN "x" TEXT;`],
    ["an insert", `INSERT INTO "EmbeddingIndex" ("id") VALUES ('main');`],
    ["a table with another name", `CREATE TABLE "Other" ("id" TEXT NOT NULL PRIMARY KEY);`],
    ["an AUTOINCREMENT key", `CREATE TABLE "EmbeddingIndex" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT);`],
    ["a trigger", `CREATE TRIGGER "t" AFTER INSERT ON "Message" BEGIN DELETE FROM "Conversation"; END;`],
    ["a pragma", `PRAGMA foreign_keys = OFF;`],
  ])("would reject %s", (_label, extra) => {
    const withExtra = statements(sql.replace(/\nCOMMIT;\s*$/, `\n${extra}\nCOMMIT;\n`)).slice(1, -1);
    expect(withExtra.map(unsafe).filter((x) => x !== null).length).toBeGreaterThanOrEqual(1);
  });
});
