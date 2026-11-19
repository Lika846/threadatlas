import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dumpExact, importText } from "../../../tests/helpers/import";
import { indexDataIds, indexMatches, searchIndexConsistency, termsInFile, termsInIndexData } from "../../../tests/helpers/search-index";
import { exportText, syntheticConversation } from "../../../tests/helpers/synthetic-export";
import { createTestDb, type TestDb } from "../../../tests/helpers/test-db";
import { killChild, spawnChild, waitForFile } from "../../../tests/helpers/child/spawn";
import type { DbClient } from "../db/client";
import { deleteAllImportedData, finishStorageCleanup, getDataState } from "../data/delete-all";
import { checkSearchIndex, NonEmptyVacuumError, rebuildSearchIndex, SEARCH_INDEX_ALL_TABLES, SEARCH_INDEX_TRIGGERS, searchIndexIsEmpty, vacuumDatabase } from "./fts-index";

/**
 * Search index (M2.1): the FTS5 tables and triggers from the migration
 * `20261107190000_search_index`, against synthetic data in temporary
 * databases. Every scenario ends with `searchIndexConsistency`: FTS5's
 * integrity check, indexed documents = rows, and probe matches = a freshly
 * built index.
 */

const N = 30;
const ids = Array.from({ length: N }, (_, i) => `c${String(i).padStart(2, "0")}`);
/** Per-conversation planted words (unique, so each one is a remanence canary). */
const oldWord = (i: number) => `zqold${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}word`;
const oldTitle = (i: number) => `zqoldtitle${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}x`;
const V1 = exportText(ids.map((id, i) => syntheticConversation({ id, messages: 6, tag: oldWord(i), title: `Alpha ${oldTitle(i)} ${id}`, updateTime: 1_767_300_000 + i })));
/** Same IDs, newer: new text everywhere, half of the titles changed. */
const V2 = exportText(ids.map((id, i) => syntheticConversation({ id, messages: 6, tag: "zqnewword", title: i % 2 === 0 ? `Revised beta ${id}` : `Alpha ${oldTitle(i)} ${id}`, updateTime: 1_767_400_000 + i })));
const OLD_WORDS = ids.map((_, i) => oldWord(i));
const OLD_TITLES_REPLACED = ids.map((_, i) => oldTitle(i)).filter((_, i) => i % 2 === 0);
const PROBES = ["synthetic", "message", "zqnewword", "revised", "beta", "alpha", OLD_WORDS[0]!, OLD_WORDS[7]!, oldTitle(1), oldTitle(2)];

let t: TestDb;
beforeEach(() => {
  t = createTestDb();
});
afterEach(async () => {
  await t.cleanup();
});

const consistent = () => searchIndexConsistency(t.file, PROBES);

async function holdReadTransaction(reader: DbClient): Promise<() => Promise<void>> {
  let open!: () => void;
  let arrived!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  const ready = new Promise<void>((r) => (arrived = r));
  const done = reader.$transaction(async (tx) => {
    await tx.importBatch.count();
    arrived();
    await opened;
  }, { timeout: 60_000 });
  await ready;
  return async () => {
    open();
    await done;
  };
}

describe("schema", () => {
  it("the migration creates both indexes, their shadow tables and the six triggers", async () => {
    const rows = await t.db.$queryRaw<{ type: string; name: string }[]>`SELECT type, name FROM sqlite_master WHERE name LIKE '%fts%' ORDER BY name`;
    expect(rows.filter((r) => r.type === "table").map((r) => r.name).sort()).toEqual([...SEARCH_INDEX_ALL_TABLES].sort());
    expect(rows.filter((r) => r.type === "trigger").map((r) => r.name).sort()).toEqual([...SEARCH_INDEX_TRIGGERS]);
    expect(await searchIndexIsEmpty(t.db)).toBe(true);
    expect(await checkSearchIndex(t.db)).toBe(true);
  });

  it("the migration backfills a database that already holds conversations, changing none of its rows", async () => {
    // A pre-M2.1 database: no index, no triggers. Import, then apply the migration SQL.
    const raw = new Database(t.file);
    for (const tr of SEARCH_INDEX_TRIGGERS) raw.exec(`DROP TRIGGER "${tr}"`);
    raw.exec(`DROP TABLE "message_fts"; DROP TABLE "conversation_fts";`);
    raw.close();
    await importText(V1, { writer: t.writer });
    const before = await dumpExact(t.db);
    const rowids = async () => JSON.stringify(await t.db.$queryRawUnsafe(`SELECT rowid, id FROM "Message" UNION ALL SELECT rowid, id FROM "Conversation" ORDER BY 2`));
    const rowidsBefore = await rowids();
    const sql = fs.readFileSync(path.join(process.cwd(), "prisma", "migrations", "20261107190000_search_index", "migration.sql"), "utf8");
    const db = new Database(t.file);
    db.exec(sql);
    db.close();
    expect(await dumpExact(t.db)).toBe(before); // every row of every table, byte for byte
    expect(await rowids()).toBe(rowidsBefore);
    expect(consistent()).toEqual({ ok: true, problems: [] });
    expect(indexMatches(t.file, "message_fts", OLD_WORDS[3]!)).toBe(6);
  });
});

describe("synchronisation", () => {
  it("add, unchanged re-import (no index writes), replacement with title changes", async () => {
    const optimized: string[] = [];
    const hooks = { afterIndexOptimize: (r: string) => void optimized.push(r) };
    expect((await importText(V1, { writer: t.writer, hooks })).counts.added).toBe(N);
    expect(consistent()).toEqual({ ok: true, problems: [] });
    expect(indexMatches(t.file, "message_fts", OLD_WORDS[5]!)).toBe(6);
    expect(indexMatches(t.file, "conversation_fts", oldTitle(5))).toBe(1);

    const before = indexDataIds(t.file);
    expect((await importText(V1, { writer: t.writer, hooks })).counts.unchanged).toBe(N);
    expect(indexDataIds(t.file)).toEqual(before); // nothing written to the index
    expect(optimized).toEqual([]); // no replacement, no optimize

    expect((await importText(V2, { writer: t.writer, hooks })).counts.updated).toBe(N);
    expect(consistent()).toEqual({ ok: true, problems: [] });
    expect(optimized).toEqual(["optimized"]);
    for (const w of OLD_WORDS.slice(0, 5)) expect(indexMatches(t.file, "message_fts", w)).toBe(0);
    expect(indexMatches(t.file, "message_fts", "zqnewword")).toBe(N * 6);
    expect(indexMatches(t.file, "conversation_fts", "revised")).toBe(N / 2);
    expect(indexMatches(t.file, "conversation_fts", oldTitle(2))).toBe(0); // replaced title
    expect(indexMatches(t.file, "conversation_fts", oldTitle(1))).toBe(1); // kept title
    // optimize merged the index: replaced terms are gone from its data blocks.
    expect(termsInIndexData(t.file, [...OLD_WORDS, ...OLD_TITLES_REPLACED])).toBe(0);
  });

  it("an injected failure after the index writes rolls the conversation back, index included", async () => {
    const r = await importText(V1, {
      writer: t.writer,
      hooks: { inTransaction: (stage, index) => { if (stage === "beforeCommit" && index === 5) throw new Error("synthetic failure"); } },
    });
    expect(r.status).toBe("completed_with_errors");
    expect(indexMatches(t.file, "message_fts", OLD_WORDS[5]!)).toBe(0);
    expect(indexMatches(t.file, "message_fts", OLD_WORDS[6]!)).toBe(6);
    expect(consistent()).toEqual({ ok: true, problems: [] });
  });

  it("a failed COMMIT (competing read transaction) leaves the index consistent; re-import completes it", async () => {
    const reader = t.reader();
    let release: (() => Promise<void>) | undefined;
    const r = await importText(V1, {
      writer: t.writer,
      hooks: {
        inTransaction: async (stage, index) => { if (stage === "beforeCommit" && index === 3) release = await holdReadTransaction(reader); },
        beforeFinalize: async () => { await release?.(); },
      },
    });
    expect(r).toMatchObject({ status: "failed", errorCode: "DB_BUSY" });
    expect(indexMatches(t.file, "message_fts", OLD_WORDS[3]!)).toBe(0);
    expect(consistent()).toEqual({ ok: true, problems: [] });
    expect((await importText(V1, { writer: t.writer })).status).toBe("succeeded");
    expect(consistent()).toEqual({ ok: true, problems: [] });
  }, 60_000);

  it("SIGKILL inside a replacement transaction: recovery and re-import leave the index consistent", async () => {
    await importText(V1, { writer: t.writer });
    const exp = `${t.file}.v2.json`;
    const marker = `${t.file}.marker`;
    fs.writeFileSync(exp, V2);
    const child = spawnChild(t.file, { CHILD_TASK: "import", CHILD_EXPORT: exp, CHILD_STOP_AT: "tx:afterInsert:3", CHILD_ACTION: "kill", CHILD_MARKER: marker });
    try {
      await waitForFile(marker);
      expect((await child.exited).signal).toBe("SIGKILL");
    } finally {
      await killChild(child);
      fs.rmSync(exp, { force: true });
      fs.rmSync(marker, { force: true });
    }
    expect(consistent()).toEqual({ ok: true, problems: [] });
    const again = await importText(V2, { writer: t.writer });
    expect(again).toMatchObject({ status: "succeeded", recoveredInterrupted: 1 });
    expect(consistent()).toEqual({ ok: true, problems: [] });
  }, 120_000);

  it("deleting a conversation row removes its messages and title from the index (cascade)", async () => {
    await importText(V1, { writer: t.writer });
    await t.db.conversation.delete({ where: { source_sourceId: { source: "chatgpt", sourceId: ids[4]! } } });
    expect(indexMatches(t.file, "message_fts", OLD_WORDS[4]!)).toBe(0);
    expect(indexMatches(t.file, "conversation_fts", oldTitle(4))).toBe(0);
    expect(consistent()).toEqual({ ok: true, problems: [] });
  });
});

describe("delete-all and storage cleanup", () => {
  it("delete-all empties the index completely and verifies it; no indexed term remains in the file", async () => {
    await importText(V1, { writer: t.writer });
    expect(termsInFile(t.file, OLD_WORDS)).toBe(N);
    const r = await deleteAllImportedData({ writer: t.writer });
    expect(r).toMatchObject({ status: "complete" });
    expect(await searchIndexIsEmpty(t.db)).toBe(true);
    expect(indexDataIds(t.file)).toEqual([1, 10, 1, 10]);
    expect(await checkSearchIndex(t.db)).toBe(true);
    expect(termsInFile(t.file, [...OLD_WORDS, ...ids.map((_, i) => oldTitle(i))])).toBe(0);
    expect(consistent()).toEqual({ ok: true, problems: [] });
  });

  it("the delete transaction itself empties the index, even when cleanup is then blocked", async () => {
    // 50 conversations, each committed separately, with 25 distinct words each: the
    // triggers' own deletes leave index data behind (11 records, measured), and only
    // the explicit clear removes it.
    const words = (i: number) => Array.from({ length: 25 }, (_, j) => {
      let n = i * 25 + j + 1;
      let w = "";
      while (n > 0) { w += "bcdfghjklmnprstvw"[n % 17]; n = Math.floor(n / 17); }
      return `${w}ex`;
    }).join(" ");
    const big = exportText(Array.from({ length: 50 }, (_, i) => syntheticConversation({ id: `big-${i}`, messages: 12, tag: words(i), title: `Big ${words(i + 50).slice(0, 40)}` })));
    await importText(big, { writer: t.writer });
    const reader = t.reader();
    let release: (() => Promise<void>) | undefined;
    const r = await deleteAllImportedData({ writer: t.writer, hooks: { afterCommit: async () => { release = await holdReadTransaction(reader); } } });
    await release?.();
    expect(r).toMatchObject({ status: "deleted_cleanup_incomplete", code: "CLEANUP_DB_BUSY" });
    expect(await searchIndexIsEmpty(t.db)).toBe(true);
    expect(indexDataIds(t.file)).toEqual([1, 10, 1, 10]);
    expect((await getDataState(t.db)).cleanupMayBeIncomplete).toBe(true); // free pages remain until cleanup
  }, 60_000);

  it("leftover index entries are evidence of incomplete cleanup, and Finish storage cleanup removes them", async () => {
    // An index entry whose row does not exist (as a pre-M2.1 or interrupted run could leave).
    const raw = new Database(t.file);
    raw.prepare(`INSERT INTO message_fts(rowid, "contentText") VALUES (999, 'zqleftoverterm')`).run();
    raw.close();
    expect(await searchIndexIsEmpty(t.db)).toBe(false);
    expect((await getDataState(t.db)).cleanupMayBeIncomplete).toBe(true);
    expect(await finishStorageCleanup({ writer: t.writer })).toMatchObject({ status: "complete" });
    expect(await searchIndexIsEmpty(t.db)).toBe(true);
    expect(termsInFile(t.file, ["zqleftoverterm"])).toBe(0);
    expect((await getDataState(t.db)).cleanupMayBeIncomplete).toBe(false);
  });

  it("cleanup reports an unverified index as incomplete, never as complete", async () => {
    const r = await finishStorageCleanup({
      writer: t.writer,
      // After VACUUM: an entry appears that the checks must catch.
      hooks: { afterVacuum: async (db) => { await db.$executeRawUnsafe(`INSERT INTO message_fts(rowid, "contentText") VALUES (5, 'zqlate')`); } },
    });
    expect(r).toMatchObject({ status: "incomplete", code: "CLEANUP_UNVERIFIED" });
  });
});

describe("VACUUM and rebuild (A90)", () => {
  const freePages = async () => Number((await t.db.$queryRawUnsafe<{ freelist_count: bigint }[]>("PRAGMA freelist_count"))[0]!.freelist_count);

  it("vacuumDatabase refuses while conversations exist and changes nothing", async () => {
    await importText(V1, { writer: t.writer });
    await t.db.conversation.delete({ where: { source_sourceId: { source: "chatgpt", sourceId: ids[0]! } } });
    const before = await freePages();
    expect(before).toBeGreaterThan(0);
    await expect(vacuumDatabase(t.db)).rejects.toBeInstanceOf(NonEmptyVacuumError);
    expect(await freePages()).toBe(before); // no VACUUM ran
    expect(consistent()).toEqual({ ok: true, problems: [] });
  });

  it("vacuumDatabase compacts a database whose tables are empty", async () => {
    await importText(V1, { writer: t.writer });
    await deleteAllImportedData({ writer: t.writer });
    await vacuumDatabase(t.db);
    expect(await freePages()).toBe(0);
    expect(await searchIndexIsEmpty(t.db)).toBe(true);
  });

  it("checkSearchIndex detects a stale index, and rebuild repairs it", async () => {
    await importText(V1, { writer: t.writer });
    const raw = new Database(t.file);
    raw.exec(`DROP TRIGGER "message_fts_after_delete"`); // a missed sync
    raw.exec(`DELETE FROM "Message" WHERE rowid = (SELECT MIN(rowid) FROM "Message" WHERE "contentText" <> '')`);
    raw.close();
    expect(await checkSearchIndex(t.db)).toBe(false);
    await rebuildSearchIndex(t.db);
    expect(await checkSearchIndex(t.db)).toBe(true);
  });
});

describe("a database without the search-index migration", () => {
  beforeEach(() => {
    const raw = new Database(t.file);
    for (const tr of SEARCH_INDEX_TRIGGERS) raw.exec(`DROP TRIGGER "${tr}"`);
    raw.exec(`DROP TABLE "message_fts"; DROP TABLE "conversation_fts";`);
    raw.close();
  });

  it("imports still work (the optimize step fails harmlessly)", async () => {
    const results: string[] = [];
    const hooks = { afterIndexOptimize: (r: string) => void results.push(r) };
    expect((await importText(V1, { writer: t.writer, hooks })).status).toBe("succeeded");
    expect((await importText(V2, { writer: t.writer, hooks })).counts.updated).toBe(N);
    expect(results).toEqual(["failed"]);
  });

  it("delete-all deletes nothing and reports that the database needs migrating", async () => {
    await importText(V1, { writer: t.writer });
    expect(await deleteAllImportedData({ writer: t.writer })).toEqual({ status: "not_deleted", code: "DB_NOT_MIGRATED", writerSettingsRestored: true });
    expect(await t.db.conversation.count()).toBe(N);
  });
});
