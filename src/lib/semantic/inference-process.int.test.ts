/**
 * The inference child process and its client (M5.1b-2 slice 1; plan §3), with the fake
 * child (`tests/helpers/fake-inference-child.mts`): the real IPC adapter, the real worker
 * loop and, by default, the real `createPipeline` over a backend that blocks the event loop
 * per batch exactly as onnxruntime-node does. Real processes and real signals; no model,
 * no database, synthetic text only.
 */
import { fork, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrtLikePipeline } from "../../../tests/helpers/fake-pipeline.mts";
import { CHUNKER_VERSION } from "./chunker";
import { EMBEDDING_ERRORS, EmbeddingError } from "./errors";
import type { IndexEmbedder } from "./index/indexer";
import { InferenceProcess, type InferenceProcessOptions } from "./inference-process";
import { EMBEDDING_VERSION } from "./model-manifest";
import { LIMITS } from "./protocol";

const ROOT = process.cwd();
const ENTRY = path.join(ROOT, "tests/helpers/fake-inference-child.mts");
const PARENT = path.join(ROOT, "tests/helpers/inference-parent.mts");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let tmp: string;
let n = 0;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "threadatlas-inference-"));
});
afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const logFile = () => path.join(tmp, `events-${++n}.log`);
type Ev = { t: number; name: string };
function events(file: string): Ev[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Ev);
}
const names = (file: string) => events(file).map((e) => e.name);
const pidOf = (file: string) => Number(names(file).find((x) => x.startsWith("pid:"))?.slice(4));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

const words = (i: number, w = 40) => Array.from({ length: w }, (_, k) => `w${(i * 7 + k) % 97}`).join(" ");
const texts = (count: number, w = 40) => Array.from({ length: count }, (_, i) => words(i, w));

function start(testOptions: Record<string, unknown> = {}, opts: Partial<InferenceProcessOptions> = {}) {
  return InferenceProcess.start({ entry: ENTRY, modelDir: "/unused", testOptions, ...opts });
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "resolved";
  } catch (e) {
    return e instanceof EmbeddingError ? e.code : "other";
  }
}

describe("start-up and shutdown", { timeout: 20_000 }, () => {
  it("starts, reports the code's versions, runs requests, and exits 0 after releasing on close()", async () => {
    const log = logFile();
    const p = await start({ eventLog: log });
    const asIndexEmbedder: IndexEmbedder = p; // the indexer's interface, unchanged
    expect(asIndexEmbedder.info).toMatchObject({ dimensions: 384, embeddingVersion: EMBEDDING_VERSION, chunkerVersion: CHUNKER_VERSION });
    expect(alive(p.pid)).toBe(true);
    expect(await p.embedPassages(texts(3))).toHaveLength(3);
    await p.close();
    expect(p.exit).toEqual({ code: 0, signal: null });
    expect(p.state).toBe("closed");
    expect(alive(p.pid)).toBe(false);
    const ev = names(log);
    expect(ev).toContain("env:0"); // empty environment (apart from Node's IPC and macOS's encoding variable)
    expect(ev.indexOf("drain:message")).toBeLessThan(ev.indexOf("released"));
    expect(ev.at(-1)).toBe("exit:0");
    await expect(p.embedPassages(texts(1))).rejects.toMatchObject({ code: "CLOSED" });
  });

  it.each(["MODEL_MISSING", "MODEL_INVALID", "RUNTIME_UNAVAILABLE", "MODEL_LOAD_FAILED"])("passes an init error through (%s); the child exits 0 by itself", async (code) => {
    const log = logFile();
    expect(await codeOf(start({ eventLog: log, initErrorCode: code }))).toBe(code);
    await until(() => names(log).includes("exit:0"), 3_000, "child exit");
    expect(alive(pidOf(log))).toBe(false);
  });

  it("kills a child that does not become ready within the start-up timeout (MODEL_LOAD_FAILED)", async () => {
    const log = logFile();
    const t0 = performance.now();
    expect(await codeOf(start({ eventLog: log, hangOnLoad: true }, { startTimeoutMs: 400 }))).toBe("MODEL_LOAD_FAILED");
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(alive(pidOf(log))).toBe(false);
  });

  it.each([
    ["a relative entry", "tests/helpers/fake-inference-child.mts"],
    ["a missing entry", path.join(ROOT, "tests/helpers/does-not-exist.mts")],
    ["a directory", path.join(ROOT, "tests/helpers")],
    ["a non-TypeScript file", path.join(ROOT, "package.json")],
  ])("refuses %s without forking (RUNTIME_UNAVAILABLE)", async (_label, entry) => {
    expect(await codeOf(InferenceProcess.start({ entry, modelDir: "/unused" }))).toBe("RUNTIME_UNAVAILABLE");
  });

  it("refuses a relative model directory (MODEL_DIR_INVALID)", async () => {
    expect(await codeOf(InferenceProcess.start({ entry: ENTRY, modelDir: "data/models/x" }))).toBe("MODEL_DIR_INVALID");
  });
});

describe("requests and replies", { timeout: 20_000 }, () => {
  it("returns the same chunks and bit-identical vectors as the pipeline in-process, on every call", async () => {
    const opts = { blockMs: 0 };
    const p = await start(opts);
    const local = createOrtLikePipeline(opts, { onCrash: () => {} });
    const input = texts(37, 30);
    const expected = await local.embed("passage", input);
    for (let r = 0; r < 2; r++) {
      const got = await p.embedPassages(input);
      got.forEach((v, i) => expect(Buffer.from(v.buffer, v.byteOffset, v.byteLength).equals(Buffer.from(expected.buffer, i * 384 * 4, 384 * 4))).toBe(true));
    }
    const messages = [
      { sourceNodeId: "n1", text: "First sentence here. Second one follows. A third closes it." },
      { sourceNodeId: "n2", text: "Emoji 🚀 and CJK 東京の朝 stay whole." },
    ];
    expect(await p.chunk(messages)).toEqual(local.chunk(messages));
    await p.close();
  });

  it.each([
    ["too many texts", () => Array.from({ length: LIMITS.maxTextsPerCall + 1 }, () => "a")],
    ["a text over the length limit", () => ["a".repeat(LIMITS.maxTextLength + 1)]],
    ["more characters than one request may carry", () => Array.from({ length: 3 }, () => "a".repeat(LIMITS.maxTextLength))],
    ["a non-string text", () => [1 as unknown as string]],
  ])("refuses %s before sending anything (INVALID_INPUT); the child stays usable", async (_label, make) => {
    const log = logFile();
    const p = await start({ eventLog: log });
    expect(await codeOf(p.embedPassages(make()))).toBe("INVALID_INPUT");
    expect(names(log)).not.toContain("batch-start");
    expect(await p.embedPassages(texts(2))).toHaveLength(2);
    await p.close();
  });

  it("refuses a chunk request over the character bound (INVALID_INPUT)", async () => {
    const p = await start();
    const big = Array.from({ length: 3 }, (_, i) => ({ sourceNodeId: `n${i}`, text: "word ".repeat(LIMITS.maxTextLength / 5) }));
    expect(await codeOf(p.chunk(big))).toBe("INVALID_INPUT");
    await p.close();
  });

  it("allows one request at a time; a concurrent second call is refused", async () => {
    const p = await start({ blockMs: 20 });
    const first = p.embedPassages(texts(40));
    expect(await codeOf(p.embedPassages(texts(1)))).toBe("INVALID_INPUT");
    expect(await first).toHaveLength(40);
    await p.close();
  });

  it("treats a reply with the wrong number of vectors as a protocol violation: WORKER_FAILED, child killed", async () => {
    const p = await start({ shortReply: true });
    expect(await codeOf(p.embedPassages(texts(4)))).toBe("WORKER_FAILED");
    await until(() => p.exit !== null, 3_000, "child exit");
    expect(p.exit?.signal).toBe("SIGKILL");
    expect(p.state).toBe("failed");
    await p.close();
  });

  it("treats a chunk reply that is not a chunk list as WORKER_FAILED", async () => {
    const p = await start({ badChunkReply: true });
    expect(await codeOf(p.chunk([{ sourceNodeId: "n1", text: "Hello." }]))).toBe("WORKER_FAILED");
    await p.close();
  });

  describe("the child's own checks (raw IPC, bypassing the client)", () => {
    let child: ChildProcess;
    let replies: unknown[];
    const rawStart = (log: string) => {
      replies = [];
      child = fork(ENTRY, [], { serialization: "advanced", execArgv: [], env: {} as NodeJS.ProcessEnv, stdio: ["ignore", "ignore", "ignore", "ipc"] });
      child.on("message", (m) => replies.push(m));
      return log;
    };
    const exited = () => new Promise<number | null>((r) => (child.exitCode !== null ? r(child.exitCode) : child.once("exit", (c) => r(c))));

    it("ignores messages before init and answers a malformed init with init-error INVALID_INPUT, then exits 0", async () => {
      rawStart(logFile());
      child.send({ type: "embed", id: 1, kind: "passage", texts: ["early"] });
      child.send({ type: "init", modelDir: "relative/dir", verifyHashes: true });
      expect(await exited()).toBe(0);
      expect(replies).toEqual([{ type: "init-error", code: "INVALID_INPUT" }]);
    });

    it("refuses over-budget and malformed requests, ignores unknown types and bad ids, and keeps serving", async () => {
      const log = rawStart(logFile());
      child.send({ type: "init", modelDir: "/unused", verifyHashes: false, testOptions: { eventLog: log } });
      await until(() => replies.length === 1, 5_000, "ready");
      expect(replies[0]).toMatchObject({ type: "ready" });
      const big = Array.from({ length: 3 }, () => "a".repeat(LIMITS.maxTextLength));
      child.send({ type: "embed", id: 1, kind: "passage", texts: big });
      child.send({ type: "embed", id: 2, kind: "passage", texts: [42] });
      child.send({ type: "chunk", id: 3, messages: "not a list" });
      child.send({ type: "explode", id: 4 });
      child.send({ type: "embed", id: -1, kind: "passage", texts: ["x"] });
      child.send({ type: "embed", id: 5, kind: "passage", texts: ["fine text"] });
      await until(() => replies.length === 5, 5_000, "replies");
      expect(replies.slice(1, 4)).toEqual([
        { type: "error", id: 1, code: "INVALID_INPUT" },
        { type: "error", id: 2, code: "INVALID_INPUT" },
        { type: "error", id: 3, code: "INVALID_INPUT" },
      ]);
      expect(replies[4]).toMatchObject({ type: "embedded", id: 5 });
      child.send({ type: "shutdown" });
      expect(await exited()).toBe(0);
    });
  });
});

describe("cancellation while a batch blocks the event loop (onnxruntime-node behaviour)", { timeout: 30_000 }, () => {
  it.each([1, 2, 4])("a cancel sent during batch %i lets that batch finish and starts no further batch", async (k) => {
    const log = logFile();
    const p = await start({ eventLog: log, blockMs: 150 });
    const ac = new AbortController();
    const call = p.embedPassages(texts(16 * 8), { signal: ac.signal });
    await until(() => names(log).filter((x) => x === "batch-start").length === k, 10_000, `batch ${k}`);
    await sleep(40); // well inside the 150 ms batch
    const sentAt = Date.now();
    ac.abort();
    expect(await codeOf(call)).toBe("CANCELLED");
    const ev = events(log);
    const received = ev.find((e) => e.name === "cancel-received")!;
    const starts = ev.filter((e) => e.name === "batch-start");
    const ends = ev.filter((e) => e.name === "batch-end");
    expect(starts).toHaveLength(k); // no batch started after the cancel
    expect(ends).toHaveLength(k); // the active batch finished
    expect(received.t).toBeGreaterThanOrEqual(sentAt);
    expect(ends.at(-1)!.t).toBeLessThanOrEqual(received.t); // read only once the blocking batch ended
    expect(starts.every((s) => s.t < received.t)).toBe(true);
    expect(await p.embedPassages(texts(2))).toHaveLength(2); // still usable
    await p.close();
    expect(p.exit).toEqual({ code: 0, signal: null });
  });

  it("close() during a batch: the batch finishes, the session is released, the child exits 0", async () => {
    const log = logFile();
    const p = await start({ eventLog: log, blockMs: 200 });
    const call = codeOf(p.embedPassages(texts(16 * 6)));
    await until(() => names(log).includes("batch-start"), 5_000, "first batch");
    await p.close();
    expect(await call).toBe("CANCELLED");
    expect(p.exit).toEqual({ code: 0, signal: null });
    const ev = names(log);
    expect(ev.filter((x) => x === "batch-start")).toHaveLength(1);
    expect(ev.indexOf("batch-end")).toBeLessThan(ev.indexOf("released"));
  });
});

/** Real native aborts leave a macOS crash report each time, so they run only on request. */
const NATIVE_CRASH_TESTS = process.env.THREADATLAS_NATIVE_CRASH_TESTS === "1";

describe("crash isolation and watchdogs", { timeout: 30_000 }, () => {
  async function crashAndRecover(crashMode: "kill" | "abort", signal: NodeJS.Signals) {
    const p = await start({ crashMarker: "boom", crashMode });
    const before = await p.embedPassages(["alpha beta", "gamma delta"]);
    expect(await codeOf(p.embedPassages(["alpha beta", "this one goes boom"]))).toBe("WORKER_FAILED");
    await until(() => p.exit !== null, 3_000, "child exit");
    expect(p.exit?.signal).toBe(signal);
    expect(p.state).toBe("failed");
    expect(await codeOf(p.embedPassages(["x"]))).toBe("WORKER_FAILED");
    await p.close();
    const q = await start({ crashMarker: "boom", crashMode });
    const again = await q.embedPassages(["alpha beta", "gamma delta"]);
    again.forEach((v, i) => expect(Array.from(v)).toEqual(Array.from(before[i]!)));
    await q.close();
  }

  it("an abrupt death of the child (SIGKILL) rejects WORKER_FAILED and leaves this process running; a new child works", () =>
    crashAndRecover("kill", "SIGKILL"));

  it.skipIf(!NATIVE_CRASH_TESTS)(
    "a real native abort in the child (SIGABRT) does the same (opt-in: THREADATLAS_NATIVE_CRASH_TESTS=1)",
    () => crashAndRecover("abort", "SIGABRT"),
  );

  it("a request with no reply within the request timeout kills the child (WORKER_FAILED)", async () => {
    const log = logFile();
    const p = await start({ eventLog: log, hangMarker: "stuck" }, { requestTimeoutMs: 600 });
    const t0 = performance.now();
    expect(await codeOf(p.embedPassages(["this is stuck"]))).toBe("WORKER_FAILED");
    const ms = performance.now() - t0;
    expect(ms).toBeGreaterThanOrEqual(550);
    expect(ms).toBeLessThan(2_000);
    await until(() => p.exit !== null, 3_000, "child exit");
    expect(p.exit?.signal).toBe("SIGKILL");
    expect(alive(p.pid)).toBe(false);
    await p.close();
  });

  it("close() on a hung child is not killed early: it waits for the request timeout, then the child is killed", async () => {
    // The request's own timeout starts before close(). A wide margin between the alive check
    // (about 0.45 s after the request) and that timeout (2 s) keeps late timers on a loaded
    // machine from killing the child before the check (seen once with 0.9 s).
    const p = await start({ hangMarker: "stuck" }, { requestTimeoutMs: 2_000 });
    const call = codeOf(p.embedPassages(["this is stuck"]));
    await sleep(50);
    const t0 = performance.now();
    const closing = p.close();
    await sleep(400);
    expect(alive(p.pid)).toBe(true); // a hang is only declared after the timeout
    await closing;
    const ms = performance.now() - t0;
    expect(ms).toBeGreaterThanOrEqual(1_850);
    expect(ms).toBeLessThan(4_500);
    expect(["WORKER_FAILED", "CLOSED"]).toContain(await call);
    expect(p.exit?.signal).toBe("SIGKILL");
    expect(alive(p.pid)).toBe(false);
  });
});

type Parent = { proc: ChildProcess; out: string[]; childPid: number; log: string };

async function startParent(testOptions: Record<string, unknown>, opts: { detached?: boolean; texts?: number } = {}): Promise<Parent> {
  const log = logFile();
  const readyFile = path.join(tmp, `ready-${n}.json`);
  const args = { entry: ENTRY, modelDir: "/unused", testOptions: { eventLog: log, ...testOptions }, texts: opts.texts ?? 16 * 20, readyFile };
  const proc = spawn(process.execPath, [PARENT, JSON.stringify(args)], { stdio: ["ignore", "pipe", "pipe"], detached: opts.detached ?? false, env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" } });
  const out: string[] = [];
  proc.stdout!.on("data", (d) => out.push(String(d)));
  proc.stderr!.on("data", (d) => out.push(String(d)));
  await until(() => fs.existsSync(readyFile), 10_000, "parent ready");
  const childPid = (JSON.parse(fs.readFileSync(readyFile, "utf8")) as { pid: number }).pid;
  return { proc, out, childPid, log };
}

const exitOf = (proc: ChildProcess) =>
  new Promise<void>((r) => (proc.exitCode !== null || proc.signalCode !== null ? r() : proc.once("exit", () => r())));

describe("the parent dies during inference", { timeout: 60_000 }, () => {
  it.each([
    ["SIGTERM", "SIGTERM", false, "drain:disconnect"],
    ["SIGINT to the process group (terminal Ctrl-C)", "SIGINT", true, "drain:SIGINT"],
    ["SIGKILL", "SIGKILL", false, "drain:disconnect"],
  ] as const)("%s: the child finishes its batch, releases, exits 0; no orphan", async (_label, signal, group, cause) => {
    const parent = await startParent({ blockMs: 120 }, { detached: group });
    await until(() => names(parent.log).includes("batch-start"), 10_000, "a batch");
    const killedAt = Date.now();
    if (group) process.kill(-parent.proc.pid!, signal);
    else parent.proc.kill(signal);
    await exitOf(parent.proc);
    await until(() => !alive(parent.childPid), 5_000, "child exit");
    const ev = events(parent.log);
    const names_ = ev.map((e) => e.name);
    expect(names_.some((x) => x === cause || x === "drain:disconnect" || x === "drain:SIGINT")).toBe(true);
    expect(names_.indexOf("released")).toBeGreaterThan(-1);
    expect(names_.at(-1)).toBe("exit:0");
    const drainMs = ev.at(-1)!.t - killedAt;
    expect(drainMs).toBeLessThan(2_000);
    expect(parent.out.join("")).toBe("");
  });

  it("the parent SIGKILLed at random points (12 runs): every child exits 0, none is left behind", async () => {
    for (let i = 0; i < 12; i++) {
      const parent = await startParent({ blockMs: 25 + (i % 4) * 20 });
      await sleep(Math.floor(Math.random() * 300));
      parent.proc.kill("SIGKILL");
      await exitOf(parent.proc);
      await until(() => !alive(parent.childPid), 5_000, "child exit");
      expect(names(parent.log).at(-1)).toBe("exit:0");
    }
  });
});

describe("orphan backstop (owner's condition 3)", { timeout: 60_000 }, () => {
  it("a hung child whose parent is gone kills itself after the grace period", async () => {
    const parent = await startParent({ hangMarker: "w0", orphanGraceMs: 500 }, { texts: 4 });
    await until(() => names(parent.log).includes("batch-start"), 10_000, "the hung batch");
    const killedAt = Date.now();
    parent.proc.kill("SIGKILL");
    await exitOf(parent.proc);
    await until(() => !alive(parent.childPid), 6_000, "the orphan backstop");
    const ms = Date.now() - killedAt;
    expect(ms).toBeGreaterThanOrEqual(400); // armed by the parent's loss, not earlier
    expect(names(parent.log)).not.toContain("exit:0"); // killed, not drained
  });

  it("a child that drains normally after its parent died is never killed by the backstop", async () => {
    const parent = await startParent({ blockMs: 900, orphanGraceMs: 2_000 });
    await until(() => names(parent.log).includes("batch-start"), 10_000, "a slow batch");
    parent.proc.kill("SIGKILL");
    await exitOf(parent.proc);
    await until(() => !alive(parent.childPid), 6_000, "child exit");
    expect(names(parent.log).at(-1)).toBe("exit:0");
  });

  it("while the parent is alive the backstop never fires, even for a hung child; the request timeout handles it", async () => {
    const log = logFile();
    const p = await start({ eventLog: log, hangMarker: "stuck", orphanGraceMs: 300 }, { requestTimeoutMs: 3_500 });
    const call = codeOf(p.embedPassages(["this is stuck"]));
    await sleep(2_500); // > grace + poll interval
    expect(alive(p.pid)).toBe(true);
    expect(await call).toBe("WORKER_FAILED");
    await until(() => p.exit !== null, 3_000, "child exit");
    expect(p.exit?.signal).toBe("SIGKILL");
    await p.close();
  });
});

describe("privacy", { timeout: 20_000 }, () => {
  it("nothing the child writes to stdout, stderr or the console reaches the parent's output", async () => {
    const canary = "CANARY-7f3a-not-for-logs";
    const parent = await startParent({ stdioCanary: canary, blockMs: 20 });
    await until(() => names(parent.log).includes("batch-start"), 10_000, "a batch");
    parent.proc.kill("SIGTERM");
    await exitOf(parent.proc);
    await until(() => !alive(parent.childPid), 5_000, "child exit");
    expect(parent.out.join("")).not.toContain(canary);
    expect(parent.out.join("")).toBe("");
  });

  it("errors carry static messages only", async () => {
    const p = await start({ crashMarker: "boom" });
    try {
      await p.embedPassages(["secret text that goes boom"]);
    } catch (e) {
      expect((e as Error).message).toBe(EMBEDDING_ERRORS.WORKER_FAILED);
      expect(JSON.stringify(e)).not.toContain("secret");
    }
    await p.close();
  });
});
