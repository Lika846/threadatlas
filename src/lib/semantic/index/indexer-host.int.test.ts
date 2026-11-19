/**
 * The indexer with the inference child process (M5.1b-2 slice 2): the indexer lock taken
 * before any inference process starts, its release on every path, and interrupted
 * attempts (owner's condition 2): a normal process exit refunds the claim in progress, a
 * hard death keeps it, and a child crash or request timeout always consumes it, so a
 * conversation that keeps crashing the child becomes `failed` after three Starts.
 *
 * Inference runs in the fake child (`tests/helpers/fake-inference-child.mts`, the indexer
 * pipeline shape); its "crash" is an abrupt SIGKILL of the child (no macOS crash report).
 * Real processes; synthetic data and temporary databases only.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { killChild, spawnChild, waitForFile, type Child } from "../../../../tests/helpers/child/spawn";
import { importText } from "../../../../tests/helpers/import";
import { chunkDumpBySource, conversationId, conversationWithTexts, indexWith, statusOf, statusRows } from "../../../../tests/helpers/semantic-index";
import { exportText, syntheticExport } from "../../../../tests/helpers/synthetic-export";
import { createTestDb, type TestDb } from "../../../../tests/helpers/test-db";
import { runWriterTransaction } from "../../db/transaction-recovery";
import { acquireWriteLock, probeIndexerLock } from "../../db/write-lock";
import { EmbeddingError } from "../errors";
import { InferenceProcess, type InferenceProcessOptions } from "../inference-process";
import { refundClaimSync } from "./exit-refund";
import { runIndexer, type IndexEmbedder, type IndexerDeps, type IndexerResult } from "./indexer";
import { retryFailed, type Claim } from "./store";

const ROOT = process.cwd();
const FAKE_CHILD = path.join(ROOT, "tests/helpers/fake-inference-child.mts");
const EXIT_CHILD = path.join(ROOT, "tests/helpers/exit-refund.child.mts");
const CRASH = "POISONCRASH";
const HANG = "POISONHANG";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let t: TestDb;
let dir: string;
const children: Child[] = [];
beforeEach(() => {
  t = createTestDb();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "threadatlas-index-host-"));
});
afterEach(async () => {
  for (const c of children.splice(0)) await killChild(c);
  await t.cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(cond: () => boolean | Promise<boolean>, ms: number, what: string) {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** Counts every inference process the indexer starts, and keeps their pids. */
function host(testOptions: Record<string, unknown> = {}, startOptions: Partial<InferenceProcessOptions> = {}) {
  const h = {
    opens: 0,
    procs: [] as InferenceProcess[],
    open: async (): Promise<IndexEmbedder> => {
      h.opens++;
      const p = await InferenceProcess.start({ entry: FAKE_CHILD, modelDir: "/unused", testOptions: { pipeline: "index", ...testOptions }, ...startOptions });
      h.procs.push(p);
      return p;
    },
  };
  return h;
}

function run(openEmbedder: IndexerDeps["openEmbedder"], rest: Partial<IndexerDeps> = {}): Promise<IndexerResult> {
  return runIndexer({ writer: t.writer, reader: t.reader(), openEmbedder, writeLockRetryMs: 50, ...rest });
}

async function importConvs(convs: unknown[]) {
  expect((await importText(exportText(convs), { writer: t.writer })).complete).toBe(true);
}
const normal = () => syntheticExport(3, { messages: 4, idPrefix: "ok" });
const poison = (marker: string) => conversationWithTexts("poison", [`This conversation contains ${marker} in its only message.`]);
const row = async (sourceId: string) => (await statusOf(t.db, await conversationId(t.db, sourceId)))!;
const indexRowCount = async () => Number(((await t.db.$queryRawUnsafe<{ n: unknown }[]>(`SELECT COUNT(*) AS n FROM "EmbeddingIndex"`))[0]!.n));

function child(vars: Record<string, string>): Child {
  const c = spawnChild(t.file, { CHILD_OUT: path.join(dir, "out"), CHILD_MARKER: path.join(dir, "marker"), CHILD_GO: path.join(dir, "go"), ...vars });
  children.push(c);
  return c;
}

describe("the indexer lock is taken before any inference process starts", { timeout: 60_000 }, () => {
  it("a competing process holds it: INDEXER_BUSY, no inference process started, nothing written", async () => {
    await importConvs(normal());
    const before = await statusRows(t.db);
    child({ CHILD_TASK: "index-lock-hold" });
    expect(await waitForFile(path.join(dir, "out"))).toBe("ACQUIRED");
    const h = host();
    expect(await run(h.open)).toEqual({ status: "not-started", code: "INDEXER_BUSY" });
    expect(h.opens).toBe(0);
    expect(await statusRows(t.db)).toEqual(before);
    expect(await indexRowCount()).toBe(0); // Reconcile never ran
  });

  it("two indexers in this process at once: one runs, the other is refused before starting a child", async () => {
    await importConvs(normal());
    const h = host();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let held = false;
    // The first run holds the lock (after Reconcile) until the second has been refused; the
    // lock's own retries (about 0.5 s) are spent while it is held.
    const first = run(h.open, { hooks: { afterReconcile: async () => ((held = true), await gate) } });
    await until(() => held, 10_000, "the first run to hold the lock");
    expect(await run(h.open)).toEqual({ status: "not-started", code: "INDEXER_BUSY" });
    expect(h.opens).toBe(1);
    open();
    expect((await first).status).toBe("finished");
  });

  it("a child indexer process with the process host holds it: this process is refused, then indexes after it finishes", async () => {
    await importConvs(normal());
    const c = child({ CHILD_TASK: "index", CHILD_HOST: "process", CHILD_STOP_AT: "hold" });
    await waitForFile(path.join(dir, "marker"));
    const h = host();
    expect(await run(h.open)).toEqual({ status: "not-started", code: "INDEXER_BUSY" });
    expect(h.opens).toBe(0);
    fs.writeFileSync(path.join(dir, "go"), "");
    expect(JSON.parse(await waitForFile(path.join(dir, "out")))).toMatchObject({ status: "finished", stats: { indexed: 3 } });
    await c.exited;
    expect(await run(h.open)).toMatchObject({ status: "finished", stats: { claimed: 0 } });
  });
});

describe("the lock and the exit listener are released on every path", { timeout: 60_000 }, () => {
  const stub = (info: Partial<IndexEmbedder["info"]>): IndexEmbedder => ({
    info: { dimensions: 384, embeddingVersion: "other-version", chunkerVersion: "x", ...info },
    chunk: async () => [],
    embedPassages: async () => [],
    close: async () => {},
  });

  it.each([
    ["model missing (init error)", () => host({ initErrorCode: "MODEL_MISSING" }).open, {}, "not-started", "MODEL_MISSING"],
    ["start-up timeout", () => host({ hangOnLoad: true }, { startTimeoutMs: 300 }).open, {}, "not-started", "MODEL_LOAD_FAILED"],
    ["a configuration mismatch", () => async () => stub({}), {}, "not-started", "INDEX_CONFIG_MISMATCH"],
    ["an unexpected error opening the embedder", () => async () => { throw new Error("synthetic"); }, {}, "not-started", "WORKER_FAILED"],
    ["a child crash mid-run", () => host({ crashMarker: CRASH }).open, { poison: CRASH }, "stopped", "WORKER_FAILED"],
    ["a request timeout mid-run", () => host({ hangMarker: HANG }, { requestTimeoutMs: 600 }).open, { poison: HANG }, "stopped", "WORKER_FAILED"],
    ["a finished run", () => host().open, {}, "finished", undefined],
  ] as const)("%s", async (_label, make, opts, status, code) => {
    await importConvs([...normal(), ...("poison" in opts ? [poison(opts.poison)] : [])]);
    const listeners = process.listenerCount("exit");
    const r = await run(make());
    expect(r.status).toBe(status);
    if (code) expect("code" in r && r.code).toBe(code);
    expect(probeIndexerLock(t.file)).toBe("free");
    expect(process.listenerCount("exit")).toBe(listeners);
  });

  it("a pause mid-run releases the lock and the listener, and the child exits 0", async () => {
    await importConvs(normal());
    const h = host({ batchDelayMs: 40 });
    const ac = new AbortController();
    const listeners = process.listenerCount("exit");
    const r = await run(h.open, { signal: ac.signal, hooks: { afterWindow: () => ac.abort() } });
    expect(r.status).toBe("paused");
    expect(probeIndexerLock(t.file)).toBe("free");
    expect(process.listenerCount("exit")).toBe(listeners);
    expect(h.procs[0]!.exit).toEqual({ code: 0, signal: null });
  });
});

describe("interrupted attempts (owner's condition 2)", { timeout: 60_000 }, () => {
  /** Captures the indexer's exit handler instead of registering it on `process`. */
  function exitTrap() {
    const trap = { handler: null as (() => void) | null, register: (h: () => void) => ((trap.handler = h), () => (trap.handler = null)) };
    return trap;
  }

  it("a normal exit during inference refunds the claimed attempt; the run's own later writes are then stale", async () => {
    await importConvs(normal());
    const trap = exitTrap();
    const ac = new AbortController();
    let claimed: Claim | null = null;
    let seen: Record<string, unknown> | null = null;
    const r = await run(host({ batchDelayMs: 20 }).open, {
      signal: ac.signal,
      registerExitHandler: trap.register,
      hooks: {
        afterClaim: (c) => void (claimed ??= c),
        afterWindow: async (c) => {
          if (c !== claimed || seen) return;
          trap.handler!(); // what process.exit would run
          seen = (await statusOf(t.db, c.conversationId))!;
          ac.abort();
        },
      },
    });
    expect(r.status).toBe("paused");
    expect(seen).toMatchObject({ state: "pending", attempts: 0, claimToken: null });
    expect(await statusOf(t.db, claimed!.conversationId)).toMatchObject({ state: "pending", attempts: 0 }); // never below 0
  });

  it("an exit while this process holds the write lock (its own commit) skips the refund: the attempt is kept, nothing waits", async () => {
    await importConvs(normal());
    let result: string | null = null;
    const r = await run(host().open, {
      hooks: {
        inCommit: (c) => {
          if (result) return;
          const t0 = performance.now();
          result = refundClaimSync(t.file, c);
          expect(performance.now() - t0).toBeLessThan(200);
        },
      },
    });
    expect(result).toBe("busy");
    expect(r.status).toBe("finished");
  });

  it.each([
    ["SIGTERM", "SIGTERM", "refunded"],
    ["SIGINT", "SIGINT", "refunded"],
    ["SIGKILL", "SIGKILL", null],
  ] as const)("a real process ending by %s: refunded only when it exits normally", async (_label, signal, expected) => {
    await importConvs(normal());
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let claimed: Claim | null = null;
    const running = run(host().open, {
      hooks: {
        afterClaim: async (c) => {
          if (claimed) return;
          claimed = c;
          await gate;
        },
      },
    });
    await until(() => claimed !== null, 10_000, "a claim");
    const readyFile = path.join(dir, "ready");
    const resultFile = path.join(dir, "result");
    const args = { dbPath: t.file, conversationId: claimed!.conversationId, token: claimed!.token, readyFile, resultFile };
    const proc = spawn(process.execPath, [EXIT_CHILD, JSON.stringify(args)], { cwd: ROOT, stdio: "ignore", env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" } });
    await until(() => fs.existsSync(readyFile), 10_000, "exit helper ready");
    const exited = new Promise<{ code: number | null; sig: NodeJS.Signals | null }>((r) => proc.once("exit", (code, sig) => r({ code, sig })));
    proc.kill(signal);
    const e = await exited;
    const after = (await statusOf(t.db, claimed!.conversationId))!;
    if (expected) {
      expect(e.code).toBe(signal === "SIGTERM" ? 143 : 130);
      expect(fs.readFileSync(resultFile, "utf8")).toBe(expected);
      expect(after).toMatchObject({ state: "pending", attempts: 0, claimToken: null });
    } else {
      expect(e.sig).toBe("SIGKILL");
      expect(fs.existsSync(resultFile)).toBe(false);
      expect(after).toMatchObject({ state: "running", attempts: 1 });
    }
    open();
    expect((await running).status).toBe("finished");
    // Refunded: the claim's own commit was stale and the row was indexed again later in the run.
    expect(await statusOf(t.db, claimed!.conversationId)).toMatchObject({ state: "indexed", attempts: 1 });
  });

  it("a child crash observed but not yet recorded: a normal exit does not refund it; the attempt counts", async () => {
    await importConvs([poison(CRASH)]);
    const trap = exitTrap();
    let atExit: Record<string, unknown> | null = null;
    const r = await run(host({ crashMarker: CRASH }).open, {
      registerExitHandler: trap.register,
      hooks: {
        afterInference: async (c, outcome) => {
          expect(outcome).toBe("error");
          trap.handler!();
          atExit = (await statusOf(t.db, c.conversationId))!;
        },
      },
    });
    expect(atExit).toMatchObject({ state: "running", attempts: 1 }); // not refunded
    expect(r).toMatchObject({ status: "stopped", code: "WORKER_FAILED" });
    expect(await row("poison")).toMatchObject({ state: "pending", attempts: 1, lastErrorCode: "WORKER_FAILED" });
  });

  it("a child crash observed, then the server is SIGKILLed before recording it: the attempt is kept through the reset", async () => {
    await importConvs([poison(CRASH)]);
    const c = child({ CHILD_TASK: "index", CHILD_HOST: "process", CHILD_HOST_OPTIONS: JSON.stringify({ crashMarker: CRASH }), CHILD_STOP_AT: "after-inference", CHILD_ACTION: "kill" });
    await waitForFile(path.join(dir, "marker"));
    expect((await c.exited).signal).toBe("SIGKILL");
    expect(await row("poison")).toMatchObject({ state: "running", attempts: 1 });
    expect(probeIndexerLock(t.file)).toBe("free");
    const r = await run(host({ crashMarker: CRASH }).open);
    expect(r).toMatchObject({ status: "stopped", code: "WORKER_FAILED" });
    expect(r.status === "stopped" && r.stats.reconcile?.reset).toBe(1);
    expect(await row("poison")).toMatchObject({ state: "pending", attempts: 2 }); // 1 kept + 1 new
  });

  it("a child crash recorded before anything else happens: pending, attempt kept, WORKER_FAILED; a later exit changes nothing", async () => {
    await importConvs([poison(CRASH)]);
    const trap = exitTrap();
    const r = await run(host({ crashMarker: CRASH }).open, { registerExitHandler: (h) => trap.register(h) });
    expect(r).toMatchObject({ status: "stopped", code: "WORKER_FAILED" });
    expect(await row("poison")).toMatchObject({ state: "pending", attempts: 1, lastErrorCode: "WORKER_FAILED" });
    const c = await row("poison");
    expect(refundClaimSync(t.file, { conversationId: String(c.conversationId), token: "any" })).toBe("not-running");
  });

  it("the indexer process SIGKILLed during inference: its child drains and exits 0, the lock is free, Start recovers with the attempt kept", async () => {
    await importConvs(normal());
    const log = path.join(dir, "events.log");
    const c = child({ CHILD_TASK: "index", CHILD_HOST: "process", CHILD_HOST_OPTIONS: JSON.stringify({ eventLog: log, batchDelayMs: 30 }), CHILD_STOP_AT: "inference", CHILD_ACTION: "kill" });
    await waitForFile(path.join(dir, "marker"));
    expect((await c.exited).signal).toBe("SIGKILL");
    await until(() => fs.readFileSync(log, "utf8").includes('"exit:0"'), 5_000, "inference child exit");
    const events = fs.readFileSync(log, "utf8");
    expect(events).toContain('"drain:disconnect"');
    const pid = Number(/"pid:(\d+)"/.exec(events)![1]);
    await until(() => !alive(pid), 5_000, "inference child gone"); // it logs exit:0 just before it ends
    expect(probeIndexerLock(t.file)).toBe("free");
    const running = (await statusRows(t.db)).filter((x) => x.state === "running");
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({ attempts: 1 });
    const r = await run(host().open);
    expect(r).toMatchObject({ status: "finished", stats: { indexed: 3, reconcile: { reset: 1 } } });
    expect((await statusRows(t.db)).map((x) => x.attempts).sort()).toEqual([1, 1, 2]);
    // The same chunks and vectors as the worker-thread host in a fresh database.
    const other = createTestDb();
    try {
      expect((await importText(exportText(normal()), { writer: other.writer })).complete).toBe(true);
      expect((await indexWith(other)).status).toBe("finished");
      expect(await chunkDumpBySource(t.db)).toEqual(await chunkDumpBySource(other.db));
    } finally {
      await other.cleanup();
    }
  });
});

describe("a conversation that keeps crashing the child (owner's condition 2)", { timeout: 120_000 }, () => {
  it.each([
    ["crash", { crashMarker: CRASH }, {}, CRASH],
    ["request timeout", { hangMarker: HANG }, { requestTimeoutMs: 500 }, HANG],
  ] as const)("%s: one attempt per Start, no automatic retry; failed after three Starts; then the others are indexed", async (_label, opts, startOpts, marker) => {
    await importConvs([...normal(), poison(marker)]);
    for (let k = 1; k <= 3; k++) {
      const h = host(opts, startOpts);
      const r = await run(h.open);
      expect(r).toMatchObject({ status: "stopped", code: "WORKER_FAILED" });
      expect(h.opens).toBe(1); // one inference process per Start; never restarted within the run
      expect(await row("poison")).toMatchObject({ state: k < 3 ? "pending" : "failed", attempts: k, lastErrorCode: "WORKER_FAILED" });
    }
    const last = await run(host(opts, startOpts).open);
    expect(last).toMatchObject({ status: "finished" });
    const rows = await statusRows(t.db);
    expect(rows.filter((x) => x.state === "indexed")).toHaveLength(3);
    expect(rows.filter((x) => x.state === "failed")).toHaveLength(1);
    // Further Starts never pick it up again by themselves.
    expect(await run(host(opts, startOpts).open)).toMatchObject({ status: "finished", stats: { claimed: 0 } });
  });

  it("Retry failed gives it three new attempts (the last error code is kept); it fails again only after three more crashes", async () => {
    await importConvs([poison(CRASH)]);
    for (let k = 0; k < 3; k++) await run(host({ crashMarker: CRASH }).open);
    expect(await row("poison")).toMatchObject({ state: "failed", attempts: 3 });
    const lock = await acquireWriteLock(t.file);
    if (!lock.ok) throw new Error("write lock");
    try {
      expect(await runWriterTransaction(t.writer.db, (tx) => retryFailed(tx))).toBe(1);
    } finally {
      lock.lock.release();
    }
    expect(await row("poison")).toMatchObject({ state: "pending", attempts: 0, lastErrorCode: "WORKER_FAILED" });
    for (let k = 1; k <= 3; k++) {
      expect(await run(host({ crashMarker: CRASH }).open)).toMatchObject({ status: "stopped", code: "WORKER_FAILED" });
      expect(await row("poison")).toMatchObject({ state: k < 3 ? "pending" : "failed", attempts: k });
    }
  });

  it("an ordinary failure is unaffected: INFERENCE_FAILED is retried within the run and fails after three attempts", async () => {
    await importConvs([...normal(), conversationWithTexts("poison", ["A message with POISONSOFT inside."])]);
    const r = await run(host({ poisonMarker: "POISONSOFT" }).open);
    expect(r).toMatchObject({ status: "finished", stats: { indexed: 3, failed: 1 } });
    expect(await row("poison")).toMatchObject({ state: "failed", attempts: 3, lastErrorCode: "INFERENCE_FAILED" });
  });
});

describe("errors are codes only", () => {
  it("a crashed child surfaces as a static EmbeddingError code", async () => {
    await importConvs([poison(CRASH)]);
    const h = host({ crashMarker: CRASH });
    const r = await run(h.open);
    expect(JSON.stringify(r)).not.toContain(CRASH);
    expect(r).toMatchObject({ code: "WORKER_FAILED" });
    expect(new EmbeddingError("WORKER_FAILED").message).not.toContain(CRASH);
  });
});
