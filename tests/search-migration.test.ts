import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The search-index migration may only ADD the index (M2.1 final review): it
 * must contain no statement that could change or remove existing conversation
 * data. The file is parsed into statements, and each must be one of:
 * - CREATE VIRTUAL TABLE "message_fts" | "conversation_fts" USING fts5(...)
 * - CREATE TRIGGER ... AFTER INSERT | DELETE | UPDATE OF ... ON "Message" | "Conversation",
 *   whose body consists only of INSERT INTO "message_fts" | "conversation_fts"
 * - INSERT INTO "<index>"("<index>") VALUES ('rebuild')
 * all between exactly one BEGIN (first statement) and one COMMIT (last), so a
 * failure rolls everything back (Prisma does not wrap SQLite migrations).
 * Anything else (DROP, DELETE FROM, UPDATE, ALTER, REPLACE, INSERT into another
 * table, PRAGMA, ...) fails. The 'delete' string inside the delete triggers is
 * FTS5's command to remove an entry from the index, not a row deletion.
 */
const FILE = path.join(process.cwd(), "prisma", "migrations", "20261107190000_search_index", "migration.sql");
const INDEX = `"(message_fts|conversation_fts)"`;

function statements(sql: string): string[] {
  const text = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  const out: string[] = [];
  let cur = "";
  let inTrigger = false;
  for (const token of text.split(/(;)/)) {
    cur += token;
    if (/\bCREATE\s+TRIGGER\b/i.test(cur) && !/\bEND\s*;?$/i.test(cur.trim())) inTrigger = true;
    if (token === ";" && (!inTrigger || /\bEND\s*;$/i.test(cur.trim()))) {
      out.push(cur.replace(/\s+/g, " ").trim());
      cur = "";
      inTrigger = false;
    }
  }
  if (cur.trim() !== "") out.push(cur.replace(/\s+/g, " ").trim());
  return out;
}

const VIRTUAL = new RegExp(`^CREATE VIRTUAL TABLE ${INDEX} USING fts5\\([^;]*\\);$`);
const TRIGGER = new RegExp(`^CREATE TRIGGER "[a-z_]+" AFTER (INSERT|DELETE|UPDATE OF "(contentText|title)") ON "(Message|Conversation)" BEGIN (.*) END;$`);
const BODY_INSERT = new RegExp(`^INSERT INTO ${INDEX}\\([^;]*\\) VALUES \\([^;]*\\)$`);
const REBUILD = new RegExp(`^INSERT INTO ${INDEX}\\("(message_fts|conversation_fts)"\\) VALUES \\('rebuild'\\);$`);

function unsafe(st: string): string | null {
  if (VIRTUAL.test(st) || REBUILD.test(st)) return null;
  const m = TRIGGER.exec(st);
  if (!m) return st;
  const body = m[4]!.split(";").map((s) => s.trim()).filter(Boolean);
  return body.length > 0 && body.every((b) => BODY_INSERT.test(b)) ? null : st;
}

describe("search-index migration is additive only", () => {
  const sql = fs.readFileSync(FILE, "utf8");
  const sts = statements(sql);

  it("is one transaction of 2 virtual tables, 6 triggers and 2 rebuilds, nothing else", () => {
    expect(sts[0]).toBe("BEGIN;");
    expect(sts[sts.length - 1]).toBe("COMMIT;");
    const inner = sts.slice(1, -1);
    expect(inner.map(unsafe).filter((x) => x !== null)).toEqual([]);
    expect(sts.filter((s) => VIRTUAL.test(s))).toHaveLength(2);
    expect(sts.filter((s) => TRIGGER.test(s))).toHaveLength(6);
    expect(sts.filter((s) => REBUILD.test(s))).toHaveLength(2);
    expect(inner).toHaveLength(10);
  });

  it.each([
    ["a row deletion", `DELETE FROM "Message";`],
    ["a table drop", `DROP TABLE "Conversation";`],
    ["an update", `UPDATE "Message" SET "contentText" = '';`],
    ["a schema change", `ALTER TABLE "Message" ADD COLUMN "x" TEXT;`],
    ["an insert into a data table", `INSERT INTO "Message"("id") VALUES ('x');`],
    ["a trigger that deletes rows", `CREATE TRIGGER "t" AFTER INSERT ON "Message" BEGIN DELETE FROM "Conversation"; END;`],
    ["a pragma", `PRAGMA foreign_keys = OFF;`],
  ])("would reject %s", (_label, extra) => {
    const withExtra = statements(sql.replace(/\nCOMMIT;\s*$/, `\n${extra}\nCOMMIT;\n`)).slice(1, -1);
    expect(withExtra.map(unsafe).filter((x) => x !== null)).toHaveLength(1);
  });
});
