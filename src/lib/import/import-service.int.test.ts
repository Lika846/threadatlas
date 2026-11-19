import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import util from "node:util";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_FIXTURES, fixtureText } from "../../../tests/helpers/fixtures";
import { batchRow, dumpConversations, dumpExact, importText, partialConversations, totalChanges } from "../../../tests/helpers/import";
import { BASE_TIME, exportText, syntheticConversation, syntheticExport, type SyntheticOptions } from "../../../tests/helpers/synthetic-export";
import { killChild, spawnChild, waitForFile } from "../../../tests/helpers/child/spawn";
import { checkoutInTempDir, createTestDb, type TestDb } from "../../../tests/helpers/test-db";
import type { DbErrorCode } from "../db/errors";
import { acquireWriteLock, lockPathFor } from "../db/write-lock";
import { accountingSummary, batchAccounting, COMPLETED_STATUSES } from "./persist/batch";
import { nodeFromRow } from "./persist/rows";
import { importAdapterResult, type ImportDeps, type ImportOutcome } from "./import-service";
import type { ImportReport } from "./report";
import { parseExportText, validateExportText } from "./validate-export";

const ROOT = process.cwd();

let t: TestDb;
let deps: ImportDeps;
beforeEach(() => {
  t = createTestDb();
  deps = { writer: t.writer };
});
afterEach(async () => {
  await t.cleanup();
});

const report = async (o: ImportOutcome) => JSON.parse((await batchRow(t.db, o.batchId!)).warningsJson!) as ImportReport;
const sumOf = (c: ImportOutcome["counts"]) => c.added + c.updated + c.unchanged + c.older + c.flagged + c.skipped;
/** Small `updateTime` values are offsets from a realistic base time (tiny epoch values would warn as unusual). */
const conv = (id: string, over: Partial<SyntheticOptions> = {}) =>
  syntheticConversation({ id, ...over, updateTime: typeof over.updateTime === "number" ? BASE_TIME + over.updateTime : over.updateTime });

/** The counter invariant for completed statuses (C4). */
function expectComplete(o: ImportOutcome) {
  expect(COMPLETED_STATUSES).toContain(o.status);
  expect(o.complete).toBe(true);
  expect(sumOf(o.counts)).toBe(o.counts.seen);
  expect(o.notAccounted).toBe(0);
}

describe("fixtures: every stored row reads back exactly as parsed", () => {
  it.each(ALL_FIXTURES)("%s", async (name) => {
    const text = fixtureText(name);
    const parsed = parseExportText(text);
    if (!parsed.ok) return;
    const o = await importText(text, deps);
    expectComplete(o);
    expect(o.counts).toMatchObject({ seen: parsed.conversationsSeen, added: parsed.conversations.length, flagged: parsed.flagged.length, skipped: parsed.skipped.length });
    for (const c of parsed.conversations) {
      const row = await t.db.conversation.findUniqueOrThrow({
        where: { source_sourceId: { source: "chatgpt", sourceId: c.sourceId } },
        include: { messages: { omit: { rawContentJson: false } } },
      });
      expect(row).toMatchObject({
        idSource: c.idSource, title: c.title, createdAtSec: c.createdAt, updatedAtSec: c.updatedAt,
        currentNodeSourceId: c.currentNodeSourceId, pathStrategy: c.pathStrategy, visibleMessageCount: c.visibleMessageCount,
        nodeCount: c.nodeCount, contentHash: c.contentHash, parserVersion: c.parserVersion,
        firstImportBatchId: o.batchId, lastImportBatchId: o.batchId,
      });
      const byKey = new Map(row.messages.map((m) => [m.sourceNodeId, nodeFromRow(m)]));
      expect(byKey.size).toBe(c.nodes.length);
      for (const n of c.nodes) expect(byKey.get(n.sourceNodeId)).toEqual(n);
    }
    expect(await partialConversations(t.db)).toBe(0);
  });
});

describe("idempotency", () => {
  it.each(ALL_FIXTURES)("re-importing %s changes nothing but the new batch row", async (name) => {
    const text = fixtureText(name);
    if (!validateExportText(text).ok) return;
    const first = await importText(text, deps);
    const before = await dumpExact(t.db);
    const changes0 = await totalChanges(t.db);
    const second = await importText(text, deps);
    // Exactly two row changes: the batch insert and its finalisation. No conversation or message writes.
    expect((await totalChanges(t.db)) - changes0).toBe(2);
    expectComplete(second);
    expect(second.counts).toEqual({ ...first.counts, added: 0, unchanged: first.counts.added });
    const after = JSON.parse(await dumpExact(t.db)) as { batches: { id: string }[] };
    const prev = JSON.parse(before) as { batches: { id: string }[] };
    expect(after.batches.filter((b) => b.id !== second.batchId)).toEqual(prev.batches);
    expect(JSON.stringify({ ...after, batches: [] })).toBe(JSON.stringify({ ...prev, batches: [] }));
  });
});

describe("state transitions and statuses", () => {
  it("succeeded: new conversations, no issues", async () => {
    const o = await importText(exportText(syntheticExport(3)), deps);
    expect(o).toMatchObject({ status: "succeeded", errorCode: null, counts: { seen: 3, added: 3 }, recoveredInterrupted: 0 });
    expectComplete(o);
    expect((await report(o)).complete).toBe(true);
  });

  it("succeeded_with_warnings: older and ambiguous copies keep the stored data", async () => {
    await importText(exportText([conv("a", { updateTime: 200 }), conv("b", { updateTime: 200 }), conv("c", { updateTime: 200 })]), deps);
    const stored = await dumpConversations(t.db);
    const o = await importText(
      exportText([conv("a", { updateTime: 100, tag: "old" }), conv("b", { updateTime: 200, tag: "tie" }), conv("c", { updateTime: null, tag: "untimed" })]),
      deps,
    );
    expect(o).toMatchObject({ status: "succeeded_with_warnings", counts: { seen: 3, older: 1, flagged: 2 } });
    expectComplete(o);
    expect(await dumpConversations(t.db)).toBe(stored);
    const r = await report(o);
    expect(r.counts).toMatchObject({ CONVERSATION_OLDER: 1, CONVERSATION_VERSION_AMBIGUOUS: 2 });
    expect(r.samples.find((s) => s.code === "CONVERSATION_VERSION_AMBIGUOUS" && "field" in s)).toMatchObject({ sourceId: "c", field: "update_time" });
  });

  it("C9: a stored conversation without a valid update_time is never overwritten by a changed copy", async () => {
    await importText(exportText([conv("x", { updateTime: null })]), deps);
    const o = await importText(exportText([conv("x", { updateTime: 999, tag: "changed" })]), deps);
    expect(o.counts).toMatchObject({ flagged: 1, updated: 0 });
    expect((await t.db.message.findFirstOrThrow({ where: { sourceNodeId: "n1" } })).contentText).toMatch(/^v1 /);
  });

  it("updated: a newer copy replaces the stored one", async () => {
    const first = await importText(exportText([conv("a", { updateTime: 100, messages: 4 })]), deps);
    const o = await importText(exportText([conv("a", { updateTime: 200, messages: 2, tag: "v2" })]), deps);
    expect(o).toMatchObject({ status: "succeeded", counts: { updated: 1 } });
    expect(await t.db.conversation.findFirstOrThrow()).toMatchObject({ firstImportBatchId: first.batchId, lastImportBatchId: o.batchId, nodeCount: 3 });
    expect(await t.db.message.count()).toBe(3);
  });

  it("parser upgrade: identical source re-written, counted as updated with an info code (status stays succeeded)", async () => {
    await importText(exportText([conv("a"), conv("b")]), deps);
    await t.db.conversation.updateMany({ where: { sourceId: "a" }, data: { parserVersion: "0.2.9" } });
    const o = await importText(exportText([conv("a"), conv("b")]), deps);
    expect(o).toMatchObject({ status: "succeeded", counts: { updated: 1, unchanged: 1 } });
    expect((await report(o)).counts).toEqual({ CONVERSATION_REPROCESSED: 1 });
    expect((await t.db.conversation.findFirstOrThrow({ where: { sourceId: "a" } })).parserVersion).toBe("0.3.0");
  });

  it("parser downgrade: a newer copy is flagged, an identical one unchanged, never regressing stored output", async () => {
    await importText(exportText([conv("a", { updateTime: 100 }), conv("b", { updateTime: 100 })]), deps);
    await t.db.conversation.updateMany({ data: { parserVersion: "9.0.0" } });
    const stored = await dumpConversations(t.db);
    const o = await importText(exportText([conv("a", { updateTime: 200, tag: "v2" }), conv("b", { updateTime: 100 })]), deps);
    expect(o.counts).toMatchObject({ flagged: 1, unchanged: 1, updated: 0 });
    expect((await report(o)).counts).toEqual({ CONVERSATION_PARSER_DOWNGRADE: 1 });
    expect(await dumpConversations(t.db)).toBe(stored);
  });

  it.each([
    ["unknown hash version (hash-version mismatch)", { contentHash: `v2:${"a".repeat(64)}` }],
    ["malformed hash", { contentHash: "v1:xyz" }],
    ["malformed parser version", { parserVersion: "0.3.0-beta" }],
  ])("unrecognised stored state (%s) is flagged and kept", async (_l, data) => {
    await importText(exportText([conv("a", { updateTime: 100 })]), deps);
    await t.db.conversation.updateMany({ data });
    const stored = await dumpConversations(t.db);
    for (const copy of [conv("a", { updateTime: 100 }), conv("a", { updateTime: 500, tag: "v2" })]) {
      const o = await importText(exportText([copy]), deps);
      expect(o.counts).toMatchObject({ flagged: 1 });
      expect((await report(o)).counts).toEqual({ CONVERSATION_STATE_UNRECOGNISED: 1 });
    }
    expect(await dumpConversations(t.db)).toBe(stored);
  });

  it("adapter-level skipped and flagged entries are counted at batch creation", async () => {
    const o = await importText(exportText([conv("a"), 42, conv("dup", { updateTime: 5 }), conv("dup", { updateTime: 5, tag: "x" })]), deps);
    expect(o).toMatchObject({ status: "succeeded_with_warnings", counts: { seen: 4, added: 1, skipped: 1, flagged: 2 } });
    expectComplete(o);
  });

  it("completed_with_errors: one failed conversation is rolled back and the rest continue", async () => {
    await importText(exportText([conv("a", { updateTime: 100, messages: 3 })]), deps);
    const storedA = await dumpConversations(t.db);
    const o = await importText(exportText([conv("a", { updateTime: 200, messages: 5, tag: "v2" }), conv("b"), conv("c")]), {
      ...deps,
      hooks: { inTransaction: (stage, index) => { if (stage === "afterDelete" && index === 0) throw new Error("injected"); } },
    });
    expect(o).toMatchObject({ status: "completed_with_errors", errorCode: null, counts: { seen: 3, added: 2, skipped: 1, updated: 0 } });
    expectComplete(o);
    const a = JSON.parse(storedA) as { sourceId: string }[];
    const now = JSON.parse(await dumpConversations(t.db)) as { sourceId: string }[];
    expect(now.find((c) => c.sourceId === "a")).toEqual(a[0]);
    const r = await report(o);
    expect(r.samples).toContainEqual({ code: "CONVERSATION_PERSIST_FAILED", index: 0, sourceId: "a", errorCode: "IMPORT_INTERNAL_ERROR" });
    expect(await partialConversations(t.db)).toBe(0);
  });

  type Step = (file: string) => void | Promise<void>;
  it.each<[string, DbErrorCode, Step, Step]>([
    ["missing table", "DB_NOT_MIGRATED", (file: string) => { const d = new Database(file); d.exec('DROP TABLE "Message"'); d.close(); }, () => {}],
    // A database not yet migrated to M5.1b: I2 (status queueing) needs the semantic tables.
    ["missing semantic tables", "DB_NOT_MIGRATED", (file: string) => { const d = new Database(file); d.exec('DROP TABLE "EmbeddingChunk"; DROP TABLE "EmbeddingStatus"'); d.close(); }, () => {}],
    ["read-only", "DB_READ_ONLY", async () => void (await t.db.$executeRawUnsafe("PRAGMA query_only = ON")), async () => void (await t.db.$executeRawUnsafe("PRAGMA query_only = OFF"))],
    ["disk full", "DB_DISK_FULL", async () => {
      const [pc] = await t.db.$queryRawUnsafe<{ page_count: bigint }[]>("PRAGMA page_count");
      await t.db.$queryRawUnsafe(`PRAGMA max_page_count = ${Number(pc!.page_count)}`);
    }, async () => void (await t.db.$queryRawUnsafe("PRAGMA max_page_count = 1000000"))],
  ])("failed: a systemic error (%s) stops the import, keeps earlier commits and reports unfinished work", async (_l, code, breakIt, repair) => {
    const o = await importText(exportText(syntheticExport(5, { textLength: 3000 })), {
      ...deps,
      hooks: {
        afterConversation: async (index) => { if (index === 1) await breakIt(t.file); },
        beforeFinalize: () => repair(t.file),
      },
    });
    expect(o).toMatchObject({ status: "failed", errorCode: code, complete: false, counts: { seen: 5, added: 2 }, accounted: 2, notAccounted: 3 });
    const b = await batchRow(t.db, o.batchId!);
    expect(b).toMatchObject({ status: "failed", errorCode: code, conversationsAdded: 2 });
    expect(accountingSummary(batchAccounting(b))).toBe("Accounted for 2 of 5; 3 not accounted for.");
    expect((JSON.parse(b.warningsJson!) as ImportReport).complete).toBe(false);
    if (_l !== "missing table") {
      expect(await t.db.conversation.count()).toBe(2);
      expect(await partialConversations(t.db)).toBe(0);
    }
  });

  it("interrupted: a batch whose finalisation failed is recovered by the next import", async () => {
    const o = await importText(exportText(syntheticExport(3)), {
      ...deps,
      hooks: { beforeFinalize: async () => void (await t.db.$executeRawUnsafe("PRAGMA query_only = ON")) },
    });
    // Neither finalisation nor the fallback could be written: the row stays running.
    expect(o).toMatchObject({ status: "running", errorCode: "DB_READ_ONLY", complete: false, counts: { added: 3 } });
    await t.db.$executeRawUnsafe("PRAGMA query_only = OFF");
    const next = await importText(exportText(syntheticExport(3)), deps);
    expect(next).toMatchObject({ recoveredInterrupted: 1, status: "succeeded", counts: { unchanged: 3 } });
    const b = await batchRow(t.db, o.batchId!);
    expect(b).toMatchObject({ status: "interrupted", errorCode: "IMPORT_INTERRUPTED" });
    expect(b.finishedAt).toBeInstanceOf(Date);
    expect(accountingSummary(batchAccounting(b))).toBe("Accounted for 3 of 3; 0 not accounted for.");
  });

  it("finalisation failure with a working fallback ends failed, with the error code recorded", async () => {
    const o = await importText(exportText(syntheticExport(2)), {
      ...deps,
      hooks: {
        // Rejects only the full finalisation (it writes the report), not the small fallback update.
        beforeFinalize: async () =>
          void (await t.db.$executeRawUnsafe(
            `CREATE TEMP TRIGGER reject_report BEFORE UPDATE OF "warningsJson" ON main."ImportBatch" BEGIN SELECT RAISE(ABORT, 'synthetic'); END`,
          )),
      },
    });
    await t.db.$executeRawUnsafe("DROP TRIGGER temp.reject_report");
    expect(o).toMatchObject({ status: "failed", errorCode: "DB_CONSTRAINT", complete: false, counts: { added: 2 } });
    const b = await batchRow(t.db, o.batchId!);
    expect(b).toMatchObject({ status: "failed", errorCode: "DB_CONSTRAINT", conversationsAdded: 2 });
    expect(b.finishedAt).toBeInstanceOf(Date);
    // Not presented as complete even though all conversations were written.
    expect(batchAccounting(b).complete).toBe(false);
  });
});

describe("finalisation and fallback both fail", () => {
  const CANARY = "synthetic-finalise-canary-3c8e";
  // Fails every write that ends a batch (status leaves "running"), with a canary in SQLite's error text.
  const BLOCK = `CREATE TEMP TRIGGER block_finish BEFORE UPDATE ON main."ImportBatch" WHEN NEW."status" <> 'running' BEGIN SELECT RAISE(ABORT, '${CANARY}'); END`;

  it("leaves the batch running with accurate durable counters, then recovery marks it interrupted", async () => {
    // Pre-state: s1, s2 stored. The file adds a0 and repeats s1, s2 unchanged, so
    // the two unchanged outcomes are only tallied (no checkpoint) when finalisation fails.
    await importText(exportText([conv("s1"), conv("s2")]), deps);
    const lockIno = fs.statSync(lockPathFor(t.file)).ino;
    const file = exportText([conv("a0"), conv("s1"), conv("s2")]);

    // The injected failure really does carry the canary in its raw error.
    await t.db.$executeRawUnsafe(BLOCK);
    const probe = await t.db.importBatch.create({ data: { status: "running", adapter: "chatgpt", adapterVersion: "0.3.0", sourceFilename: "p", sourceSha256: "0", sourceBytes: 1 } });
    const raw = await t.db.importBatch.update({ where: { id: probe.id }, data: { status: "failed" } }).catch((e: unknown) => e);
    expect(util.inspect(raw, { depth: 10 })).toContain(CANARY);
    await t.db.$executeRawUnsafe("DROP TRIGGER temp.block_finish");
    await t.db.importBatch.delete({ where: { id: probe.id } });

    const out: string[] = [];
    const spies = [
      ...(["log", "info", "warn", "error", "debug", "trace"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a) => void out.push(util.format(...a)))),
      vi.spyOn(process.stdout, "write").mockImplementation((c) => (out.push(String(c)), true)),
      vi.spyOn(process.stderr, "write").mockImplementation((c) => (out.push(String(c)), true)),
    ];
    let o: ImportOutcome;
    try {
      o = await importText(file, { ...deps, checkpointEvery: 1_000, checkpointIntervalMs: 60_000, hooks: { beforeFinalize: async () => void (await t.db.$executeRawUnsafe(BLOCK)) } });
    } finally {
      for (const sp of spies) sp.mockRestore();
      await t.db.$executeRawUnsafe("DROP TRIGGER IF EXISTS temp.block_finish");
    }

    // Outcome: honest, sanitised, not complete.
    expect(o).toMatchObject({ status: "running", errorCode: "DB_CONSTRAINT", complete: false, accounted: 1, notAccounted: 2, counts: { seen: 3, added: 1, unchanged: 0 } });
    expect(JSON.stringify(o)).not.toContain(CANARY);
    expect(out).toEqual([]);

    // Stored batch: still running; counters are exactly the durable outcomes (a0's write).
    const b = await batchRow(t.db, o.batchId!);
    expect(b).toMatchObject({ status: "running", errorCode: null, finishedAt: null, conversationsSeen: 3, conversationsAdded: 1, conversationsUnchanged: 0, conversationsUpdated: 0, conversationsOlder: 0, conversationsFlagged: 0, conversationsSkipped: 0 });
    expect(b.warningsJson ?? "").not.toContain(CANARY);
    expect((JSON.parse(b.warningsJson!) as ImportReport).complete).toBe(false);

    // Committed data intact: a0 complete, s1/s2 untouched, no partial rows.
    const [ic] = await t.db.$queryRawUnsafe<{ integrity_check: string }[]>("PRAGMA integrity_check");
    expect(ic!.integrity_check).toBe("ok");
    expect(await partialConversations(t.db)).toBe(0);
    const ref = createTestDb();
    try {
      await importText(exportText([conv("s1"), conv("s2")]), { writer: ref.writer });
      await importText(file, { writer: ref.writer });
      expect(await dumpConversations(t.db)).toBe(await dumpConversations(ref.db));
    } finally {
      await ref.cleanup();
    }

    // Recovery by the next import.
    const next = await importText(file, deps);
    expect(next).toMatchObject({ recoveredInterrupted: 1, status: "succeeded", complete: true, counts: { unchanged: 3 } });
    const rec = await batchRow(t.db, o.batchId!);
    expect(rec).toMatchObject({ status: "interrupted", errorCode: "IMPORT_INTERRUPTED", conversationsAdded: 1 });
    expect(rec.finishedAt).toBeInstanceOf(Date);
    expect(accountingSummary(batchAccounting(rec))).toBe("Accounted for 1 of 3; 2 not accounted for.");
    for (const row of await t.db.importBatch.findMany()) expect(JSON.stringify(row)).not.toContain(CANARY);

    // The lock file was never replaced or removed across these outcomes.
    expect(fs.statSync(lockPathFor(t.file)).ino).toBe(lockIno);
  });

  it("keeps the same lock file across success, busy, systemic failure and finalisation failure", async () => {
    await importText(exportText([conv("x")]), deps);
    const ino = fs.statSync(lockPathFor(t.file)).ino;
    const held = await acquireWriteLock(t.file);
    if (!held.ok) throw new Error("lock");
    expect((await importText(exportText([conv("y")]), deps)).errorCode).toBe("IMPORT_BUSY");
    held.lock.release();
    await importText(exportText(syntheticExport(3)), { ...deps, hooks: { afterConversation: async (i) => { if (i === 0) await t.db.$executeRawUnsafe("PRAGMA query_only = ON"); }, beforeFinalize: async () => void (await t.db.$executeRawUnsafe("PRAGMA query_only = OFF")) } });
    await importText(exportText([conv("z")]), { ...deps, hooks: { beforeFinalize: async () => void (await t.db.$executeRawUnsafe(BLOCK)) } });
    await t.db.$executeRawUnsafe("DROP TRIGGER temp.block_finish");
    await importText(exportText([conv("z")]), deps);
    const st = fs.statSync(lockPathFor(t.file));
    expect(st.ino).toBe(ino);
    expect(st.size).toBe(0);
    expect(st.mode & 0o777).toBe(0o600);
  });
});

describe("import-level outcomes write nothing", () => {
  it("IMPORT_BUSY while another holder has the lock (no batch, no recovery)", async () => {
    const held = await acquireWriteLock(t.file);
    if (!held.ok) throw new Error("lock");
    await t.db.importBatch.create({ data: { status: "running", adapter: "chatgpt", adapterVersion: "0.3.0", sourceFilename: "s", sourceSha256: "0", sourceBytes: 1 } });
    const before = await dumpExact(t.db);
    try {
      const o = await importText(exportText(syntheticExport(2)), deps);
      expect(o).toEqual({ batchId: null, status: null, errorCode: "IMPORT_BUSY", counts: { seen: 0, added: 0, updated: 0, unchanged: 0, older: 0, flagged: 0, skipped: 0 }, accounted: 0, notAccounted: 0, complete: false, recoveredInterrupted: 0 });
      expect(await dumpExact(t.db)).toBe(before); // the running batch was not touched
    } finally {
      held.lock.release();
    }
  });

  it("IMPORT_LOCK_FAILED when the lock file cannot be used", async () => {
    fs.mkdirSync(lockPathFor(t.file));
    try {
      const o = await importText(exportText(syntheticExport(1)), deps);
      expect(o).toMatchObject({ batchId: null, errorCode: "IMPORT_LOCK_FAILED" });
      expect(await t.db.importBatch.count()).toBe(0);
    } finally {
      fs.rmdirSync(lockPathFor(t.file));
    }
  });

  it("IMPORT_PARSER_VERSION_INVALID for a result from another parser version", async () => {
    const parsed = validateExportText(exportText(syntheticExport(1)));
    if (!parsed.ok) throw new Error("parse");
    const o = await importAdapterResult({ ...parsed, adapterVersion: "0.3" }, { filename: "s.json", sha256: "0", byteLength: 1 }, deps);
    expect(o).toMatchObject({ batchId: null, errorCode: "IMPORT_PARSER_VERSION_INVALID" });
    expect(await t.db.importBatch.count()).toBe(0);
  });

  it("IMPORT_INTERNAL_ERROR if the adapter's counts do not add up", async () => {
    const parsed = validateExportText(exportText(syntheticExport(2)));
    if (!parsed.ok) throw new Error("parse");
    const o = await importAdapterResult({ ...parsed, conversationsSeen: 5 }, { filename: "s.json", sha256: "0", byteLength: 1 }, deps);
    expect(o).toMatchObject({ batchId: null, errorCode: "IMPORT_INTERNAL_ERROR" });
  });

  it.skipIf(checkoutInTempDir(ROOT))("fails closed with DB_CONFIG under test without an injected, isolated database", async () => {
    // A path outside the temp directory stands in for any non-isolated database (the real
    // one is never targeted; that the default path is refused is covered in path.test.ts
    // and schema.int.test.ts with a decoy root). Nothing is created there.
    const parsed = validateExportText(exportText(syntheticExport(1)));
    if (!parsed.ok) throw new Error("parse");
    const outside = path.join(ROOT, "test-results", `never-created-${process.pid}.db`);
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = `file:${outside}`;
    try {
      const o = await importAdapterResult(parsed, { filename: "s.json", sha256: "0", byteLength: 1 });
      expect(o).toMatchObject({ batchId: null, errorCode: "DB_CONFIG" });
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
      else delete process.env.DATABASE_URL;
    }
    expect(fs.existsSync(outside)).toBe(false);
  });
});

describe("a write held by another process (M5.1b-1, final verification item 3)", () => {
  it("an import that starts during a 500 ms hold (the indexer's T2 budget) waits and completes", async () => {
    const out = path.join(path.dirname(t.file), "holder-out");
    const holder = spawnChild(t.file, { CHILD_TASK: "lock-try", CHILD_OUT: out, CHILD_HOLD_MS: "500" });
    try {
      expect(await waitForFile(out)).toBe("ACQUIRED");
      const o = await importText(exportText(syntheticExport(2)), deps);
      expect(o).toMatchObject({ complete: true, errorCode: null });
      expect(await t.db.conversation.count()).toBe(2);
    } finally {
      await killChild(holder);
    }
  }, 60_000);
});

describe("newer data is never replaced by older data (property test)", () => {
  it("over random version sequences, the stored copy is always the model's", async () => {
    let seed = 12345;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    // Model: the stored version (time, tag), or null.
    let model: { time: number | null; tag: string } | null = null;
    for (let step = 0; step < 40; step++) {
      const time = rand(5) === 0 ? null : 100 + rand(6) * 10; // includes equal and missing times
      const tag = `t${rand(4)}`; // includes identical content
      const o = await importText(exportText([conv("p", { updateTime: time, tag })]), deps);
      if (model === null) model = { time, tag };
      else if (model.tag === tag && model.time === time) {
        expect(o.counts.unchanged).toBe(1);
      } else if (model.time === null || time === null || model.time === time) {
        expect(o.counts.flagged).toBe(1);
      } else if (time < model.time) {
        expect(o.counts.older).toBe(1);
      } else {
        expect(o.counts.updated).toBe(1);
        model = { time, tag };
      }
      const row = await t.db.conversation.findFirstOrThrow({ include: { messages: { where: { sourceNodeId: "n1" } } } });
      expect(row.updatedAtSec).toBe(model.time === null ? null : BASE_TIME + model.time);
      expect(row.messages[0]!.contentText.startsWith(`${model.tag} `)).toBe(true);
    }
  });
});

describe("privacy", () => {
  const TEXT_CANARY = "synthetic-text-canary-91b2";
  const ID_CANARY = "synthetic-id-canary-44e7";

  it("raw Prisma errors carrying content never reach the outcome, batch row, report or console", async () => {
    const out: string[] = [];
    const spies = [
      ...(["log", "info", "warn", "error", "debug", "trace"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a) => void out.push(util.format(...a)))),
      vi.spyOn(process.stdout, "write").mockImplementation((c) => (out.push(String(c)), true)),
      vi.spyOn(process.stderr, "write").mockImplementation((c) => (out.push(String(c)), true)),
    ];
    const raw: unknown[] = [];
    let o: ImportOutcome;
    try {
      o = await importText(
        exportText([conv(ID_CANARY, { tag: TEXT_CANARY }), conv(`${ID_CANARY}-2`, { tag: TEXT_CANARY }), conv("plain")]),
        {
          ...deps,
          hooks: {
            inTransaction: async (stage, index, tx) => {
              if (stage !== "afterInsert") return;
              try {
                if (index === 0) {
                  // Validation error: Prisma quotes the arguments, including the canary.
                  await tx.message.create({ data: { conversationId: "x", sourceNodeId: TEXT_CANARY, siblingIndex: TEXT_CANARY as unknown as number } });
                }
                if (index === 1) {
                  // Constraint error on a row carrying the canaries.
                  await tx.conversation.create({ data: { source: "chatgpt", sourceId: `${ID_CANARY}-2`, idSource: "id", pathStrategy: "none", visibleMessageCount: 0, nodeCount: 0, contentHash: TEXT_CANARY, parserVersion: "0.3.0", title: TEXT_CANARY } });
                }
              } catch (e) {
                raw.push(e);
                throw e;
              }
            },
          },
        },
      );
    } finally {
      for (const s of spies) s.mockRestore();
    }
    // The test is meaningful: the raw validation error does contain the canary.
    expect(raw).toHaveLength(2);
    expect(util.inspect(raw[0], { depth: 10 })).toContain(TEXT_CANARY);
    expect((raw[1] as { code?: string }).code).toBe("P2002");

    expect(o).toMatchObject({ status: "completed_with_errors", counts: { added: 1, skipped: 2 } });
    const b = await batchRow(t.db, o.batchId!);
    const r = JSON.parse(b.warningsJson!) as ImportReport;
    expect(r.samples.filter((s) => s.code === "CONVERSATION_PERSIST_FAILED").map((s) => ("errorCode" in s ? s.errorCode : null))).toEqual(["DB_INVALID_QUERY", "DB_CONSTRAINT"]);
    for (const text of [JSON.stringify(o), b.errorCode ?? "", b.warningsJson!, out.join("\n")]) expect(text).not.toContain(TEXT_CANARY);
    // Source IDs may appear in the bounded local report, never in errors or output.
    for (const text of [JSON.stringify(o), b.errorCode ?? "", out.join("\n")]) expect(text).not.toContain(ID_CANARY);
    expect(out).toEqual([]);
  });

  it("no raw export is stored: unknown fields and rejected entries never reach the database file", async () => {
    const canaries = ["synthetic-file-entry-canary-1", "synthetic-conv-field-canary-2", "synthetic-node-field-canary-3", "synthetic-message-meta-canary-4"];
    const dir = path.dirname(t.file);
    const dirBefore = new Set(fs.readdirSync(dir));
    const tmpBefore = new Set(fs.readdirSync(os.tmpdir()));
    const o = await importText(
      exportText([
        canaries[0],
        conv("k", {
          tag: "stored-text-marker",
          extra: { unknown_field: canaries[1] },
          nodeExtra: { node_unknown: canaries[2] },
          messageExtra: { metadata: { private_note: canaries[3] } },
        }),
      ]),
      deps,
    );
    expect(o.counts).toMatchObject({ added: 1, skipped: 1 });
    await t.db.$disconnect();
    const bytes = fs.readFileSync(t.file);
    expect(bytes.includes(Buffer.from("stored-text-marker"))).toBe(true); // the scan works
    for (const c of canaries) expect(bytes.includes(Buffer.from(c))).toBe(false);
    // Only this database's own files: other test files create databases in the
    // same directory in parallel. While held, the lock has a transient
    // `.lock-journal`, removed on release.
    const own = path.basename(t.file);
    const added = fs.readdirSync(dir).filter((f) => !dirBefore.has(f) && f.startsWith(own));
    expect(added).toEqual([path.basename(lockPathFor(t.file))]);
    expect(fs.statSync(lockPathFor(t.file)).size).toBe(0);
    // Other test files create their own `threadatlas-<purpose>-XXXXXX` directories (mkdtemp) in
    // parallel; those are not this import's. Anything else matching is.
    const otherTestDir = (f: string) => /^threadatlas-[a-z0-9-]+-[A-Za-z0-9]{6}$/.test(f) && fs.statSync(path.join(os.tmpdir(), f), { throwIfNoEntry: false })?.isDirectory() !== false;
    const tmpAdded = fs.readdirSync(os.tmpdir()).filter((f) => !tmpBefore.has(f) && /threadatlas|prisma|sqlite|etilqs/i.test(f) && !otherTestDir(f));
    expect(tmpAdded).toEqual([]);
  });

  it("stores only a sanitised base name for the upload", async () => {
    const parsed = validateExportText(exportText(syntheticExport(1)));
    if (!parsed.ok) throw new Error("parse");
    const o = await importAdapterResult(parsed, { filename: "/Users/someone/Exports/conv\u0007ersations‮.json", sha256: "a".repeat(64), byteLength: 9 }, deps);
    expect((await batchRow(t.db, o.batchId!)).sourceFilename).toBe("conversations.json");
  });
});

describe("event-loop responsiveness", () => {
  // These tests assert event-loop gaps and reader latency, not total duration.
  // Under the full parallel suite (and lsof sampling) the 5,000-message import
  // took up to 5.4 s after M2.1 added the index triggers (1.65 s on its own), so
  // Vitest's 5 s default timeout is replaced with an explicit one.
  it("many small conversations do not starve timers or other requests", async () => {
    const reader = t.reader();
    await reader.conversation.count();
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    let done = false;
    let readerQueries = 0;
    const poll = (async () => {
      while (!done) {
        await reader.conversation.count();
        readerQueries++;
        await new Promise((r) => setTimeout(r, 1));
      }
    })();
    const o = await importText(exportText(syntheticExport(300, { messages: 3 })), deps);
    done = true;
    clearInterval(timer);
    await poll;
    expect(o.counts.added).toBe(300);
    // Without a yield per conversation both stay at 0-1: every query settles synchronously.
    expect(ticks).toBeGreaterThanOrEqual(20);
    expect(readerQueries).toBeGreaterThanOrEqual(20);
  }, 30_000);

  it("other requests proceed between insertion chunks of a large conversation", async () => {
    const reader = t.reader();
    await reader.conversation.count(); // open its connection first
    let done = false;
    let readerQueries = 0;
    let maxReaderMs = 0;
    const poll = (async () => {
      while (!done) {
        const t0 = performance.now();
        await reader.message.count();
        maxReaderMs = Math.max(maxReaderMs, performance.now() - t0);
        readerQueries++;
        await new Promise((r) => setTimeout(r, 5));
      }
    })();
    let last = performance.now();
    let maxGapMs = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      maxGapMs = Math.max(maxGapMs, now - last);
      last = now;
    }, 5);
    const o = await importText(exportText([conv("big", { messages: 5_000, textLength: 400 })]), deps);
    done = true;
    clearInterval(timer);
    await poll;
    expect(o.counts.added).toBe(1);
    // 5,001 rows in 11 chunks: the reader must get through between chunks.
    expect(readerQueries).toBeGreaterThanOrEqual(3);
    expect(maxReaderMs).toBeLessThan(1_000);
    expect(maxGapMs).toBeLessThan(2_000); // generous; measured values are in the M1.4 report
  }, 30_000);
});
