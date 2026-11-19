/**
 * The indexer across processes (M5.1b-1): SIGKILL of a child indexer at every crash
 * point of design §5.9 and recovery, a second live process, the indexer lock and its
 * liveness probe, and vector determinism in a fresh process. Separate OS processes run
 * the real code (tests/helpers/child). Synthetic data and temporary databases only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { killChild, spawnChild, waitForFile, type Child } from "../../../../tests/helpers/child/spawn";
import { importText } from "../../../../tests/helpers/import";
import { chunkCount, chunkDumpBySource, indexWith, statusRows } from "../../../../tests/helpers/semantic-index";
import { exportText, syntheticExport } from "../../../../tests/helpers/synthetic-export";
import { createTestDb, type TestDb } from "../../../../tests/helpers/test-db";
import { acquireIndexerLock, indexLockPathFor, probeIndexerLock } from "../../db/write-lock";
import { computeIndexStatus } from "./status";

const EXPORT = exportText(syntheticExport(4, { messages: 8, textLength: 600 }));

let t: TestDb;
let dir: string;
const children: Child[] = [];
beforeEach(() => {
  t = createTestDb();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "threadatlas-index-child-"));
});
afterEach(async () => {
  for (const c of children.splice(0)) await killChild(c);
  await t.cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});

function child(vars: Record<string, string>, db: TestDb = t): Child {
  const c = spawnChild(db.file, { CHILD_OUT: path.join(dir, "out"), CHILD_MARKER: path.join(dir, "marker"), CHILD_GO: path.join(dir, "go"), ...vars });
  children.push(c);
  return c;
}

const status = () => computeIndexStatus(t.db, { live: null, probe: () => probeIndexerLock(t.file) });

async function integrity(): Promise<string> {
  const [r] = await t.db.$queryRawUnsafe<{ integrity_check: string }[]>("PRAGMA integrity_check");
  return r!.integrity_check;
}

/** The chunk set of a full rebuild of the same export in a fresh database (in-process indexer). */
async function fullRebuild(): Promise<string[]> {
  const other = createTestDb();
  try {
    expect((await importText(EXPORT, { writer: other.writer })).complete).toBe(true);
    expect((await indexWith(other)).status).toBe("finished");
    return await chunkDumpBySource(other.db);
  } finally {
    await other.cleanup();
  }
}

describe("SIGKILL of a child indexer at every crash point, then recovery (§5.9)", () => {
  it.each([
    ["claim", "inside T1: rolled back, nothing to recover", 0],
    ["inference", "during inference: a running row, shown as interrupted, reset at the next Start", 1],
    ["commit", "inside T2: rolled back, the row stays running and is shown as interrupted", 1],
    ["after-commit", "after T2: committed", 0],
  ] as const)("%s — %s", async (point, _label, runningAfterCrash) => {
    expect((await importText(EXPORT, { writer: t.writer })).complete).toBe(true);
    const c = child({ CHILD_TASK: "index", CHILD_STOP_AT: point, CHILD_ACTION: "kill" });
    await waitForFile(path.join(dir, "marker"));
    expect((await c.exited).signal).toBe("SIGKILL");

    const rows = await statusRows(t.db);
    expect(rows.filter((r) => r.state === "running")).toHaveLength(runningAfterCrash);
    const s = await status();
    expect(s.state).toBe(runningAfterCrash > 0 ? "interrupted" : "waiting"); // never "indexing"
    expect(probeIndexerLock(t.file)).toBe("free"); // the OS released the dead process's lock
    expect(await integrity()).toBe("ok");
    if (point === "after-commit") expect(rows.filter((r) => r.state === "indexed")).toHaveLength(1);
    else expect(await chunkCount(t.db)).toBe(0);

    const r = await indexWith(t);
    expect(r.status).toBe("finished");
    expect(r.status === "finished" && r.stats.reconcile?.reset).toBe(runningAfterCrash);
    const after = await statusRows(t.db);
    expect(after.map((x) => x.state)).toEqual(Array(4).fill("indexed"));
    // A crash during the claimed conversation's work counts as an attempt (§5.6).
    expect(after.map((x) => x.attempts).sort()).toEqual(runningAfterCrash ? [1, 1, 1, 2] : [1, 1, 1, 1]);
    // No duplicates, and exactly the chunk set of a full rebuild.
    expect(await chunkCount(t.db)).toBe(after.reduce((n, x) => n + (x.chunkCount as number), 0));
    expect(await chunkDumpBySource(t.db)).toEqual(await fullRebuild());
    expect(await integrity()).toBe("ok");
    expect((await status()).state).toBe("up-to-date");
  }, 120_000);
});

describe("a second live process", () => {
  it("is shown as indexing in another process, refuses a second Start, and finishes on its own", async () => {
    expect((await importText(EXPORT, { writer: t.writer })).complete).toBe(true);
    const c = child({ CHILD_TASK: "index", CHILD_STOP_AT: "hold" });
    await waitForFile(path.join(dir, "marker"));
    expect((await status()).state).toBe("indexing-elsewhere");
    expect(await indexWith(t)).toEqual({ status: "not-started", code: "INDEXER_BUSY" });
    fs.writeFileSync(path.join(dir, "go"), "");
    expect(JSON.parse(await waitForFile(path.join(dir, "out")))).toMatchObject({ status: "finished", stats: { indexed: 4 } });
    await c.exited;
    expect((await status()).state).toBe("up-to-date");
  }, 120_000);

  it("vectors are bit-identical when indexed in a fresh process", async () => {
    expect((await importText(EXPORT, { writer: t.writer })).complete).toBe(true);
    const c = child({ CHILD_TASK: "index" });
    expect(JSON.parse(await waitForFile(path.join(dir, "out")))).toMatchObject({ status: "finished" });
    await c.exited;
    expect(await chunkDumpBySource(t.db)).toEqual(await fullRebuild());
  }, 120_000);
});

describe("the indexer lock across processes", () => {
  it("is exclusive between processes, probed without being taken, and released by the OS on SIGKILL", async () => {
    expect(probeIndexerLock(t.file)).toBe("free");
    expect(fs.existsSync(indexLockPathFor(t.file))).toBe(false); // the probe never creates the file
    const c = child({ CHILD_TASK: "index-lock-hold" });
    expect(await waitForFile(path.join(dir, "out"))).toBe("ACQUIRED");
    expect(await acquireIndexerLock(t.file)).toEqual({ ok: false, code: "INDEXER_BUSY" });
    expect(probeIndexerLock(t.file)).toBe("held");
    expect(fs.statSync(indexLockPathFor(t.file)).mode & 0o777).toBe(0o600);
    c.proc.kill("SIGKILL");
    await c.exited;
    expect(probeIndexerLock(t.file)).toBe("free");
    const r = await acquireIndexerLock(t.file);
    expect(r.ok).toBe(true);
    if (r.ok) r.lock.release();
  }, 60_000);

  it("a probe from another process never makes a concurrent Start fail (repeated race)", async () => {
    fs.closeSync(fs.openSync(indexLockPathFor(t.file), "a", 0o600));
    const c = child({ CHILD_TASK: "index-probe-loop" });
    let acquired = 0;
    const failures: string[] = [];
    // Start racing only once the child has begun probing (its marker), and stop it only after
    // this loop (the go-file), so the whole loop overlaps the child's probes whatever the load.
    expect(await waitForFile(path.join(dir, "marker"))).toBe("probing");
    const until = Date.now() + 2_500;
    while (Date.now() < until) {
      const r = await acquireIndexerLock(t.file);
      if (r.ok) {
        acquired++;
        await new Promise((res) => setTimeout(res, Math.random() * 3));
        r.lock.release();
      } else {
        failures.push(r.code);
      }
      await new Promise((res) => setTimeout(res, Math.random() * 2));
    }
    fs.writeFileSync(path.join(dir, "go"), "");
    const seen = JSON.parse(await waitForFile(path.join(dir, "out"))) as { held: number; free: number; unknown: number };
    await c.exited;
    expect(failures).toEqual([]);
    expect(acquired).toBeGreaterThan(50);
    expect(seen.held).toBeGreaterThan(0); // the race really happened
    expect(seen.unknown).toBe(0);
  }, 60_000);
});
