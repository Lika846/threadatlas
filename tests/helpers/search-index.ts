import Database, { type SqliteDatabase } from "better-sqlite3";
import fs from "node:fs";

/** First column of every row (the local better-sqlite3 typings declare only get/all/run). */
function column(db: SqliteDatabase, sql: string, ...params: unknown[]): unknown[] {
  return (db.prepare(sql).all(...params) as Record<string, unknown>[]).map((r) => Object.values(r)[0]);
}

/**
 * Search-index consistency for tests (M2.1). Opens the temporary database file
 * on its own connection. "Consistent" means all three agree:
 * 1. FTS5's integrity check, including the comparison with the content tables;
 * 2. the indexed document sets equal the Message and Conversation rowids;
 * 3. for each probe term, the live index matches exactly the rows a freshly
 *    built index (temp schema, same tokenizer) matches.
 */
export function searchIndexConsistency(file: string, probes: string[]): { ok: boolean; problems: string[] } {
  const db = new Database(file);
  const problems: string[] = [];
  try {
    for (const t of ["message_fts", "conversation_fts"]) {
      try {
        db.prepare(`INSERT INTO "${t}"("${t}", rank) VALUES ('integrity-check', 1)`).run();
      } catch (e) {
        problems.push(`${t} integrity-check: ${(e as { code?: string }).code ?? "error"}`);
      }
    }
    const same = (a: unknown[], b: unknown[]) => a.length === b.length && new Set(a.map(String)).size === a.length && b.every((x) => new Set(a.map(String)).has(String(x)));
    const msgDocs = column(db, `SELECT id FROM message_fts_docsize`);
    const msgRows = column(db, `SELECT rowid FROM "Message"`);
    if (!same(msgDocs, msgRows)) problems.push(`message documents ${msgDocs.length}, rows ${msgRows.length}`);
    const convDocs = column(db, `SELECT id FROM conversation_fts_docsize`);
    const convRows = column(db, `SELECT rowid FROM "Conversation"`);
    if (!same(convDocs, convRows)) problems.push(`title documents ${convDocs.length}, rows ${convRows.length}`);

    db.exec(`CREATE VIRTUAL TABLE temp.ref_m USING fts5(body, k UNINDEXED, tokenize='unicode61 remove_diacritics 2')`);
    db.exec(`CREATE VIRTUAL TABLE temp.ref_t USING fts5(body, k UNINDEXED, tokenize='unicode61 remove_diacritics 2')`);
    db.exec(`INSERT INTO temp.ref_m(body, k) SELECT "contentText", rowid FROM main."Message"`);
    db.exec(`INSERT INTO temp.ref_t(body, k) SELECT "title", rowid FROM main."Conversation"`);
    for (const p of probes) {
      const q = `"${p.replace(/"/g, '""')}"`;
      const live = column(db, `SELECT rowid FROM message_fts WHERE message_fts MATCH ?`, q);
      const ref = column(db, `SELECT k FROM temp.ref_m WHERE ref_m MATCH ?`, q);
      if (!same(live, ref)) problems.push(`probe "${p}": index ${live.length}, rebuilt ${ref.length}`);
      const liveT = column(db, `SELECT rowid FROM conversation_fts WHERE conversation_fts MATCH ?`, q);
      const refT = column(db, `SELECT k FROM temp.ref_t WHERE ref_t MATCH ?`, q);
      if (!same(liveT, refT)) problems.push(`title probe "${p}": index ${liveT.length}, rebuilt ${refT.length}`);
    }
  } finally {
    db.close();
  }
  return { ok: problems.length === 0, problems };
}

/** Rows (message rowids) the index matches for a term. */
export function indexMatches(file: string, table: "message_fts" | "conversation_fts", term: string): number {
  const db = new Database(file, { readonly: true });
  try {
    return column(db, `SELECT COUNT(*) FROM ${table} WHERE ${table} MATCH ?`, `"${term.replace(/"/g, '""')}"`)[0] as number;
  } finally {
    db.close();
  }
}

/** How many of `terms` still appear in the index's own data blocks (terms are stored lowercased, prefix-compressed: the tail is searched). */
export function termsInIndexData(file: string, terms: string[]): number {
  const db = new Database(file, { readonly: true });
  try {
    const blocks = Buffer.concat(
      ["message_fts_data", "conversation_fts_data"].flatMap((t) => (column(db, `SELECT block FROM ${t}`) as Buffer[]).map((b) => Buffer.from(b))),
    );
    return terms.filter((t) => blocks.includes(Buffer.from(t.toLowerCase().slice(3)))).length;
  } finally {
    db.close();
  }
}

/** How many of `terms` appear anywhere in the database file's bytes (tail searched, as above). */
export function termsInFile(file: string, terms: string[]): number {
  const bytes = fs.readFileSync(file);
  return terms.filter((t) => bytes.includes(Buffer.from(t.toLowerCase().slice(3)))).length;
}

/** The FTS5 `_data` record ids of both indexes (an empty index keeps only 1 and 10). */
export function indexDataIds(file: string): number[] {
  const db = new Database(file, { readonly: true });
  try {
    return ["message_fts_data", "conversation_fts_data"].flatMap((t) => column(db, `SELECT id FROM ${t} ORDER BY id`) as number[]);
  } finally {
    db.close();
  }
}
