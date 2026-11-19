import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { killChild, spawnChild, waitForFile, type Child } from "../../../tests/helpers/child/spawn";
import { dumpConversations, importText } from "../../../tests/helpers/import";
import { exportText, syntheticExport } from "../../../tests/helpers/synthetic-export";
import { createTestDb, testEnv, type TestDb } from "../../../tests/helpers/test-db";
import { createPrismaClient, type DbClient } from "../db/client";
import { acquireWriteLock } from "../db/write-lock";
import { deleteAllImportedData, finishStorageCleanup, getDataState, getImportedDataCounts } from "./delete-all";

/**
 * Delete-all crash recovery with a real SIGKILL (M1.7): a child process runs
 * delete-all on a temporary database holding the real write lock and is
 * killed inside the transaction, after the commit, or during VACUUM. The
 * parent then checks what a restarted app would see and that recovery
 * (delete again, or Finish storage cleanup) reaches a verified state.
 */

const CANARY = "ZQXCRASHCANARY3391";
const SEED = exportText(syntheticExport(40, { messages: 8, tag: CANARY, textLength: 1200, title: `${CANARY} title` }));

function canaryCount(file: string): number {
  if (!fs.existsSync(file)) return 0;
  const b = fs.readFileSync(file);
  let n = 0;
  for (let i = b.indexOf(CANARY); i !== -1; i = b.indexOf(CANARY, i + 1)) n++;
  return n;
}

let t: TestDb;
let dir: string;
const children: Child[] = [];
const clients: DbClient[] = [];
beforeEach(async () => {
  t = createTestDb();
  dir = fs.mkdtempSync(path.join(path.dirname(t.file), "delete-crash-"));
  expect((await importText(SEED, { writer: t.writer })).complete).toBe(true);
  // The child is the only writer; the parent reconnects only after the kill.
  await t.db.$disconnect();
});
afterEach(async () => {
  for (const c of children.splice(0)) await killChild(c);
  for (const c of clients.splice(0)) await c.$disconnect();
  await t.cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A fresh connection, as after an app restart. */
function reopen(): DbClient {
  const db = createPrismaClient({ env: testEnv(t.file), root: process.cwd() });
  clients.push(db);
  return db;
}

function run(stop: "tx" | "after-commit" | "vacuum", action: "kill" | "wait"): { child: Child; marker: string; out: string } {
  const marker = path.join(dir, `marker-${stop}`);
  const out = path.join(dir, `out-${stop}`);
  const child = spawnChild(t.file, {
    CHILD_TASK: "delete-all",
    CHILD_STOP_AT: stop,
    CHILD_MARKER: marker,
    CHILD_OUT: out,
    CHILD_ACTION: action,
    CHILD_GO: path.join(dir, "never"),
  });
  children.push(child);
  return { child, marker, out };
}

describe("SIGKILL during delete-all", () => {
  it("inside the transaction: everything is rolled back on restart, and deleting again succeeds", async () => {
    const before = await dumpConversations(reopen());
    const { child, marker } = run("tx", "kill");
    await waitForFile(marker);
    expect((await child.exited).signal).toBe("SIGKILL");
    expect(fs.existsSync(`${t.file}-journal`)).toBe(true); // hot journal: the original pages

    const lock = await acquireWriteLock(t.file); // released by the OS
    expect(lock.ok).toBe(true);
    if (lock.ok) lock.lock.release();

    const db = reopen();
    expect(await dumpConversations(db)).toBe(before);
    expect((await getDataState(db)).counts.conversations).toBe(40);
    // The rolled-back journal file can stay (not hot) until the next write.

    const again = await deleteAllImportedData({ writer: { db, dbPath: t.file } });
    expect(again.status).toBe("complete");
    expect(canaryCount(t.file)).toBe(0);
    expect(fs.existsSync(`${t.file}-journal`)).toBe(false);
  }, 120_000);

  it("after the commit, before cleanup: records are gone, cleanup is flagged, and Finish storage cleanup completes", async () => {
    const { child, marker } = run("after-commit", "kill");
    await waitForFile(marker);
    expect((await child.exited).signal).toBe("SIGKILL");

    const db = reopen();
    const state = await getDataState(db);
    expect(state).toEqual({ counts: { conversations: 0, messages: 0, imports: 0 }, cleanupMayBeIncomplete: true });
    // secure_delete zeroes freed cells and pages, but fragments can remain in
    // live pages (as in step 0) until VACUUM rewrites the file.
    const residue = canaryCount(t.file);

    expect(await finishStorageCleanup({ writer: { db, dbPath: t.file } })).toEqual({ status: "complete", writerSettingsRestored: true });
    expect(canaryCount(t.file)).toBe(0);
    expect(residue).toBeLessThan(10); // a few fragments at most, not the content
    expect((await getDataState(db)).cleanupMayBeIncomplete).toBe(false);
    expect(await finishStorageCleanup({ writer: { db, dbPath: t.file } })).toEqual({ status: "complete", writerSettingsRestored: true });
  }, 120_000);

  it("during VACUUM: the journal holds at most leftover fragments, records stay deleted, and cleanup can be repeated to completion", async () => {
    const seeded = canaryCount(t.file);
    const { child, marker, out } = run("vacuum", "wait");
    await waitForFile(marker); // filler written; VACUUM starts now
    const journal = `${t.file}-journal`;
    const t0 = Date.now();
    while (!fs.existsSync(journal)) {
      if (Date.now() - t0 > 30_000) throw new Error("VACUUM's journal never appeared");
      await new Promise((r) => setImmediate(r));
    }
    await new Promise((r) => setTimeout(r, 30));
    const copy = path.join(dir, "journal-copy");
    try {
      fs.copyFileSync(journal, copy);
    } catch {
      // VACUUM may finish and remove its journal in between
    }
    child.proc.kill("SIGKILL");
    expect((await child.exited).signal).toBe("SIGKILL");
    expect(fs.existsSync(out)).toBe(false); // killed before delete-all returned: VACUUM was still running
    // VACUUM journals the pages it rewrites: after secure_delete those hold
    // only the few fragments left in live pages, not the deleted content.
    expect(seeded).toBeGreaterThan(1_000);
    expect(canaryCount(copy)).toBeLessThan(10);
    expect(canaryCount(journal)).toBeLessThan(10);

    const db = reopen();
    expect(await getImportedDataCounts(db)).toEqual({ conversations: 0, messages: 0, imports: 0 });
    expect(await db.$queryRawUnsafe("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    // Whatever the evidence says, cleanup is offered and completes.
    expect(await finishStorageCleanup({ writer: { db, dbPath: t.file } })).toEqual({ status: "complete", writerSettingsRestored: true });
    expect(fs.existsSync(journal)).toBe(false);
    expect(canaryCount(t.file)).toBe(0);
    expect((await getDataState(db)).cleanupMayBeIncomplete).toBe(false);
  }, 180_000);
});
