import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { killChild, spawnChild, waitForFile, type Child } from "../../../tests/helpers/child/spawn";
import { batchRow, dumpConversations, importText, partialConversations } from "../../../tests/helpers/import";
import { BASE_TIME, exportText, syntheticConversation } from "../../../tests/helpers/synthetic-export";
import { createTestDb, type TestDb } from "../../../tests/helpers/test-db";
import { accountingSummary, batchAccounting } from "./persist/batch";
import type { ImportOutcome } from "./import-service";

/**
 * Crash recovery with a real SIGKILL (safeguard B): a child process imports
 * into a temporary database and kills itself at a chosen point. The parent
 * then checks integrity, the durable-prefix accounting, recovery to
 * `interrupted`, and that re-importing reaches the same state as one clean
 * import.
 */

// Pre-state: u0–u3 and s4–s7 stored. The file updates u*, repeats s*
// unchanged and adds a*. Runs of two unchanged conversations trigger a
// checkpoint (every 2 non-write outcomes in the child); single ones are
// flushed with the next write.
const ORDER = ["u0", "s4", "s5", "a8", "u1", "s6", "s7", "a9", "u2", "a10", "u3", "a11"] as const;
const OUTCOME = (id: string) => (id[0] === "u" ? "updated" : id[0] === "s" ? "unchanged" : "added");
const v1 = (id: string) => syntheticConversation({ id, messages: 30, textLength: 200, tag: "v1", updateTime: BASE_TIME });
// 601 nodes: two message chunks per write.
const v2 = (id: string) => syntheticConversation({ id, messages: 600, textLength: 100, tag: "v2", updateTime: BASE_TIME + 100 });
const PRE = exportText(ORDER.filter((id) => id[0] !== "a").map(v1));
const FILE = exportText(ORDER.map((id) => (id[0] === "s" ? v1(id) : v2(id))));
const idx = (id: (typeof ORDER)[number]) => ORDER.indexOf(id);

let t: TestDb;
let dir: string;
const children: Child[] = [];
beforeEach(async () => {
  t = createTestDb();
  dir = fs.mkdtempSync(path.join(path.dirname(t.file), "crash-"));
  await importText(PRE, { writer: t.writer });
});
afterEach(async () => {
  for (const c of children.splice(0)) await killChild(c);
  await t.cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});

let reference: string | undefined;
async function referenceState(): Promise<string> {
  if (reference !== undefined) return reference;
  const ref = createTestDb();
  try {
    await importText(PRE, { writer: ref.writer });
    await importText(FILE, { writer: ref.writer });
    reference = await dumpConversations(ref.db);
    return reference;
  } finally {
    await ref.cleanup();
  }
}

function runChild(vars: Record<string, string>): Child {
  const exportFile = path.join(dir, `export-${children.length}.json`);
  fs.writeFileSync(exportFile, FILE);
  const c = spawnChild(t.file, { CHILD_TASK: "import", CHILD_EXPORT: exportFile, CHILD_CHECKPOINT_EVERY: "2", ...vars });
  children.push(c);
  return c;
}

/** Tag of every message text of a stored conversation ("v1", "v2", or "mixed"). */
async function versions(): Promise<Map<string, string>> {
  const rows = await t.db.conversation.findMany({ include: { messages: { where: { isStructural: false }, select: { contentText: true } } } });
  return new Map(
    rows.map((r) => {
      const tags = new Set(r.messages.map((m) => m.contentText.slice(0, 2)));
      return [r.sourceId, tags.size === 1 ? [...tags][0]! : "mixed"];
    }),
  );
}

describe("SIGKILL at transaction and checkpoint boundaries", () => {
  it.each([
    ["right after the batch is created", "batch"],
    ["inside an update, after its messages were deleted", `tx:afterDelete:${idx("u1")}`],
    ["inside an add, after the first message chunk", `tx:afterChunk:${idx("a9")}`],
    ["inside an update, just before commit", `tx:beforeCommit:${idx("u2")}`],
    ["after a non-write outcome was tallied, before any checkpoint", `after:${idx("s4")}`],
    ["after a non-write outcome following a write", `after:${idx("s6")}`],
    ["right after a write committed", `after:${idx("a9")}`],
    ["right after the first checkpoint", "checkpoint:1"],
    ["right after the second checkpoint", "checkpoint:2"],
    ["just before finalisation", "finalize"],
  ])("%s", async (_label, stopAt) => {
    const marker = path.join(dir, "marker");
    const child = runChild({ CHILD_STOP_AT: stopAt, CHILD_ACTION: "kill", CHILD_MARKER: marker });
    const { signal } = await child.exited;
    expect(signal).toBe("SIGKILL");
    expect(fs.existsSync(marker)).toBe(true);

    // 1. Integrity: no partial conversation, no mixed versions.
    const [ic] = await t.db.$queryRawUnsafe<{ integrity_check: string }[]>("PRAGMA integrity_check");
    expect(ic!.integrity_check).toBe("ok");
    expect(await partialConversations(t.db)).toBe(0);
    const tags = await versions();
    expect([...tags.values()].filter((v) => v === "mixed")).toEqual([]);

    // 2. The batch was left running; its counters describe an unbroken prefix.
    const crashed = await t.db.importBatch.findFirstOrThrow({ where: { status: "running" } });
    const a = batchAccounting(crashed);
    expect(a.seen).toBe(ORDER.length);
    const k = a.accounted;
    const prefix = ORDER.slice(0, k);
    expect({
      added: crashed.conversationsAdded, updated: crashed.conversationsUpdated, unchanged: crashed.conversationsUnchanged,
    }).toEqual({
      added: prefix.filter((id) => OUTCOME(id) === "added").length,
      updated: prefix.filter((id) => OUTCOME(id) === "updated").length,
      unchanged: prefix.filter((id) => OUTCOME(id) === "unchanged").length,
    });
    // Every committed write lies inside the prefix; nothing after it changed stored data.
    ORDER.forEach((id, i) => {
      const expected = i < k ? (OUTCOME(id) === "unchanged" ? "v1" : "v2") : id[0] === "a" ? undefined : "v1";
      expect([id, tags.get(id)]).toEqual([id, expected]);
    });
    // Writes are never lost from the counters (only non-write tallies may lag).
    const lastWrite = ORDER.map((id, i) => ({ id, i })).filter(({ id }) => tags.get(id) === "v2").pop();
    if (lastWrite) expect(k).toBeGreaterThan(lastWrite.i);

    // 3. Recovery under the lock, then re-import to finish.
    const again = await importText(FILE, { writer: t.writer });
    expect(again).toMatchObject({ recoveredInterrupted: 1, complete: true });
    const recovered = await batchRow(t.db, crashed.id);
    expect(recovered).toMatchObject({ status: "interrupted", errorCode: "IMPORT_INTERRUPTED" });
    expect(accountingSummary(batchAccounting(recovered))).toBe(`Accounted for ${k} of ${ORDER.length}; ${ORDER.length - k} not accounted for.`);
    expect(await dumpConversations(t.db)).toBe(await referenceState());
    expect(await partialConversations(t.db)).toBe(0);
  }, 90_000);
});

describe("simultaneous imports from independent processes", () => {
  it("a second process gets IMPORT_BUSY while the first holds the lock, then succeeds", async () => {
    const marker = path.join(dir, "paused");
    const go = path.join(dir, "go");
    const outA = path.join(dir, "a.json");
    const a = runChild({ CHILD_STOP_AT: `after:${idx("a8")}`, CHILD_ACTION: "pause", CHILD_MARKER: marker, CHILD_GO: go, CHILD_OUT: outA });
    await waitForFile(marker);

    const outB = path.join(dir, "b.json");
    const b = runChild({ CHILD_OUT: outB });
    const busy = JSON.parse(await waitForFile(outB)) as ImportOutcome;
    expect(busy).toMatchObject({ batchId: null, errorCode: "IMPORT_BUSY" });
    await b.exited;
    // In-process too, and the paused batch is not "recovered" while it is live.
    expect(await importText(FILE, { writer: t.writer })).toMatchObject({ errorCode: "IMPORT_BUSY", recoveredInterrupted: 0 });
    expect(await t.db.importBatch.count({ where: { status: "running" } })).toBe(1);

    fs.writeFileSync(go, "");
    const done = JSON.parse(await waitForFile(outA)) as ImportOutcome;
    expect(done).toMatchObject({ status: "succeeded", complete: true, counts: { added: 4, updated: 4, unchanged: 4 } });
    await a.exited;

    const outC = path.join(dir, "c.json");
    runChild({ CHILD_OUT: outC });
    expect(JSON.parse(await waitForFile(outC))).toMatchObject({ status: "succeeded", counts: { unchanged: 12 } });
    expect(await dumpConversations(t.db)).toBe(await referenceState());
  }, 90_000);

  it("two processes started together: one import wins, the data equals one clean import", async () => {
    const outs = [path.join(dir, "x.json"), path.join(dir, "y.json")];
    const kids = outs.map((o) => runChild({ CHILD_OUT: o }));
    const results = (await Promise.all(outs.map((o) => waitForFile(o)))).map((s) => JSON.parse(s) as ImportOutcome);
    await Promise.all(kids.map((k) => k.exited));
    const succeeded = results.filter((r) => r.status === "succeeded");
    expect(succeeded.length, JSON.stringify(results.map((r) => [r.status, r.errorCode]))).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      if (r.status !== "succeeded") expect(r).toMatchObject({ batchId: null, errorCode: "IMPORT_BUSY" });
    }
    if (succeeded.length === 2) {
      // They ran one after the other: the second found everything unchanged.
      expect(succeeded.map((r) => r.counts.unchanged).sort((x, y) => x - y)).toEqual([4, 12]);
    }
    expect(await t.db.importBatch.count({ where: { status: "running" } })).toBe(0);
    expect(await dumpConversations(t.db)).toBe(await referenceState());
    expect(await partialConversations(t.db)).toBe(0);
  }, 90_000);
});
