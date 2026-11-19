/**
 * The inference child process with the REAL model (M5.1b-2 slice 1; opt-in,
 * `npm run test:model`; needs the installed model, `THREADATLAS_MODEL_DIR` or
 * `npm run model:fetch`). Synthetic text only (the M5.0 research set and generated words).
 *
 * - the production entry verifies and loads the model and gives the same chunks and
 *   bit-identical vectors as the worker-thread embedder;
 * - model verification in the child (missing files, a same-size file with other bytes);
 * - cancellation during real native inference: the active batch finishes, no further
 *   batch starts (owner's condition 1);
 * - a native abort in the child with the model loaded leaves this process running (opt-in,
 *   THREADATLAS_NATIVE_CRASH_TESTS=1: each abort leaves a macOS crash report);
 * - the parent killed (SIGTERM, SIGINT to the group, SIGKILL) during real inference: the
 *   child drains and exits 0, no orphan.
 * Set THREADATLAS_HOST_REPORT=<file> to write the measurements as JSON.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Embedder } from "./embedder";
import { EmbeddingError } from "./errors";
import { InferenceProcess, productionChildEntry } from "./inference-process";
import { resolveModelDir } from "./model-files";
import { E5_SMALL_MANIFEST } from "./model-manifest";

const ROOT = process.cwd();
const LOGGED = path.join(ROOT, "tests/helpers/logged-inference-child.mts");
const PARENT = path.join(ROOT, "tests/helpers/inference-parent.mts");
const modelDir = () => resolveModelDir({ env: process.env, root: ROOT });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const report: Record<string, unknown> = {};
let tmp: string;
let n = 0;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "threadatlas-inference-model-"));
});
afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  const out = process.env.THREADATLAS_HOST_REPORT;
  if (out) fs.writeFileSync(out, JSON.stringify(report, null, 1));
});

type Ev = { t: number; name: string };
const logFile = () => path.join(tmp, `events-${++n}.log`);
const events = (f: string): Ev[] =>
  fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Ev) : [];
const names = (f: string) => events(f).map((e) => e.name);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(cond: () => boolean, ms: number, what: string) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "resolved";
  } catch (e) {
    return e instanceof EmbeddingError ? e.code : "other";
  }
}
const rssMiB = (pid: number) => Math.round(Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) / 1024);
const passages = (count: number, words = 60) =>
  Array.from({ length: count }, (_, i) => Array.from({ length: words }, (_, w) => `word${(i * 13 + w) % 211}`).join(" "));

type EvalSet = { conversations: { id: string; messages: string[] }[] };
const v0 = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/spikes/m5.0/eval/dataset.json"), "utf8")) as EvalSet;

describe("the production child entry with the real model", () => {
  it("verifies and loads the model; chunks and vectors are identical to the worker-thread embedder", async () => {
    const t0 = performance.now();
    const p = await InferenceProcess.start({ entry: productionChildEntry(ROOT), modelDir: modelDir() });
    const startMs = Math.round(performance.now() - t0);
    const e = await Embedder.start({ modelDir: modelDir() });
    try {
      expect(p.info).toMatchObject({ dimensions: e.info.dimensions, embeddingVersion: e.info.embeddingVersion, chunkerVersion: e.info.chunkerVersion });
      let compared = 0;
      for (const c of v0.conversations.slice(0, 8)) {
        const messages = c.messages.map((text, k) => ({ sourceNodeId: `n${k + 1}`, text }));
        const [a, b] = [await p.chunk(messages), await e.chunk(messages)];
        expect(a).toEqual(b);
        const [va, vb] = [await p.embedPassages(a.map((x) => x.text)), await e.embedPassages(b.map((x) => x.text))];
        va.forEach((v, i) => expect(Buffer.from(v.buffer, v.byteOffset, v.byteLength).equals(Buffer.from(vb[i]!.buffer, vb[i]!.byteOffset, vb[i]!.byteLength))).toBe(true));
        compared += va.length;
      }
      await p.embedPassages(passages(256));
      const childRss = rssMiB(p.pid);
      const t1 = performance.now();
      await p.close();
      report.production = { startMs, comparedVectors: compared, childRssMiB: childRss, closeMs: Math.round(performance.now() - t1), parentRssMiB: Math.round(process.memoryUsage().rss / 2 ** 20) };
      expect(p.exit).toEqual({ code: 0, signal: null });
      expect(alive(p.pid)).toBe(false);
    } finally {
      await e.close();
      await p.close();
    }
  });

  it("verifies the model in the child: missing files → MODEL_MISSING; a same-size file with other bytes → MODEL_INVALID", async () => {
    const empty = fs.mkdtempSync(path.join(tmp, "empty-"));
    expect(await codeOf(InferenceProcess.start({ entry: productionChildEntry(ROOT), modelDir: empty }))).toBe("MODEL_MISSING");
    const bad = fs.mkdtempSync(path.join(tmp, "altered-"));
    for (const f of E5_SMALL_MANIFEST.files) {
      const target = path.join(bad, f.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (f.path === "config.json") {
        const bytes = fs.readFileSync(path.join(modelDir(), f.path));
        bytes[bytes.length - 2] = bytes[bytes.length - 2] === 0x20 ? 0x09 : 0x20; // same size, other bytes
        fs.writeFileSync(target, bytes);
      } else {
        fs.symlinkSync(path.join(modelDir(), f.path), target);
      }
    }
    expect(await codeOf(InferenceProcess.start({ entry: productionChildEntry(ROOT), modelDir: bad }))).toBe("MODEL_INVALID");
  });
});

describe("cancellation during real native inference (owner's condition 1)", () => {
  it.each([1, 3, 6])("a cancel sent during native batch %i: that batch finishes, no further batch starts", async (k) => {
    const log = logFile();
    const p = await InferenceProcess.start({ entry: LOGGED, modelDir: modelDir(), verifyHashes: false, testOptions: { eventLog: log } });
    try {
      const ac = new AbortController();
      const call = codeOf(p.embedPassages(passages(256), { signal: ac.signal }));
      await until(() => names(log).filter((x) => x === "batch-start").length === k, 60_000, `batch ${k}`);
      const sentAt = Date.now();
      ac.abort();
      expect(await call).toBe("CANCELLED");
      const rejectedMs = Date.now() - sentAt;
      const ev = events(log);
      const starts = ev.filter((x) => x.name === "batch-start");
      const ends = ev.filter((x) => x.name === "batch-end");
      const received = ev.find((x) => x.name === "cancel-received")!;
      expect(received).toBeDefined();
      expect(starts).toHaveLength(k);
      expect(ends).toHaveLength(k);
      expect(starts.every((s) => s.t <= received.t)).toBe(true);
      const batchMs = ends.map((e, i) => e.t - starts[i]!.t);
      (report.cancellation ??= []) as unknown[];
      (report.cancellation as unknown[]).push({ batch: k, cancelToRejectMs: rejectedMs, batchMs, receivedAfterLastBatchEndMs: received.t - ends.at(-1)!.t });
      expect(await p.embedPassages(passages(2))).toHaveLength(2); // still usable
    } finally {
      await p.close();
    }
    expect(p.exit).toEqual({ code: 0, signal: null });
  });
});

/** Real native aborts leave a macOS crash report each time, so they run only on request. */
const NATIVE_CRASH_TESTS = process.env.THREADATLAS_NATIVE_CRASH_TESTS === "1";

describe("a native abort in the child with the model loaded (opt-in: THREADATLAS_NATIVE_CRASH_TESTS=1)", () => {
  it.skipIf(!NATIVE_CRASH_TESTS)("rejects WORKER_FAILED, leaves this process running, and a new child gives the same vectors", async () => {
    const texts = passages(48);
    const ref = await InferenceProcess.start({ entry: productionChildEntry(ROOT), modelDir: modelDir(), verifyHashes: false });
    const expected = await ref.embedPassages(texts);
    await ref.close();
    const log = logFile();
    const p = await InferenceProcess.start({ entry: LOGGED, modelDir: modelDir(), verifyHashes: false, testOptions: { eventLog: log, abortAtBatch: 2 } });
    const t0 = performance.now();
    expect(await codeOf(p.embedPassages(texts))).toBe("WORKER_FAILED");
    const failMs = Math.round(performance.now() - t0);
    await until(() => p.exit !== null, 5_000, "child exit");
    expect(p.exit?.signal).toBe("SIGABRT");
    await p.close();
    const t1 = performance.now();
    const again = await InferenceProcess.start({ entry: productionChildEntry(ROOT), modelDir: modelDir(), verifyHashes: false });
    const restartMs = Math.round(performance.now() - t1);
    const got = await again.embedPassages(texts);
    got.forEach((v, i) => expect(Array.from(v)).toEqual(Array.from(expected[i]!)));
    await again.close();
    report.nativeAbort = { failMs, restartMs };
  });
});

describe("the parent dies during real inference", () => {
  const exitOf = (proc: ChildProcess) =>
    new Promise<void>((r) => (proc.exitCode !== null || proc.signalCode !== null ? r() : proc.once("exit", () => r())));

  it.each([
    ["SIGTERM", "SIGTERM", false],
    ["SIGINT to the process group", "SIGINT", true],
    ["SIGKILL", "SIGKILL", false],
  ] as const)("%s: the child drains and exits 0; no orphan", async (label, signal, group) => {
    const log = logFile();
    const readyFile = path.join(tmp, `ready-${n}.json`);
    const args = { entry: LOGGED, modelDir: modelDir(), verifyHashes: false, testOptions: { eventLog: log }, texts: 256, words: 60, readyFile };
    const proc = spawn(process.execPath, [PARENT, JSON.stringify(args)], { stdio: ["ignore", "pipe", "pipe"], detached: group, env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" } });
    const out: string[] = [];
    proc.stdout!.on("data", (d) => out.push(String(d)));
    proc.stderr!.on("data", (d) => out.push(String(d)));
    await until(() => fs.existsSync(readyFile), 60_000, "parent ready");
    const childPid = (JSON.parse(fs.readFileSync(readyFile, "utf8")) as { pid: number }).pid;
    await until(() => names(log).filter((x) => x === "batch-start").length >= 2, 60_000, "real batches");
    const killedAt = Date.now();
    if (group) process.kill(-proc.pid!, signal);
    else proc.kill(signal);
    await exitOf(proc);
    await until(() => !alive(childPid), 10_000, "child exit");
    const ev = events(log);
    expect(ev.at(-1)!.name).toBe("exit:0");
    expect(ev.some((x) => x.name.startsWith("drain:"))).toBe(true);
    expect(out.join("")).toBe("");
    (report.parentDeath ??= []) as unknown[];
    (report.parentDeath as unknown[]).push({ signal: label, killToChildExitMs: ev.at(-1)!.t - killedAt, cause: ev.find((x) => x.name.startsWith("drain:"))!.name });
  });
});
