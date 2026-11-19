import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Embedder } from "./embedder";
import { EmbeddingError } from "./errors";

// Real worker threads. The fake entry runs the real message loop with a fake pipeline;
// the real entry is only started against an empty model directory (no model, no ONNX).
const FAKE = new URL("../../../tests/helpers/fake-embed-worker.mts", import.meta.url);

type Mode = "ok" | "init-fail" | "crash" | "infer-fail";
const open: Embedder[] = [];

async function fake(mode: Mode = "ok", batchDelayMs = 40) {
  const log = new Int32Array(new SharedArrayBuffer(4 * 5));
  const e = await Embedder.start({
    modelDir: "/unused",
    workerUrl: FAKE,
    workerData: { mode, batchDelayMs, log },
  });
  open.push(e);
  return { e, log };
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((e) => e.close()));
});

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (err) {
    expect(err).toBeInstanceOf(EmbeddingError);
    expect((err as Error).message).not.toMatch(/secret|private|user text/);
    return (err as EmbeddingError).code;
  }
}

describe("Embedder (fake pipeline in a real worker)", () => {
  it("starts, chunks and embeds in input order", async () => {
    const { e } = await fake();
    expect(e.info.dimensions).toBe(3);
    expect(e.info.chunkerVersion).toBe("sentence-pack-v1");
    const chunks = await e.chunk([{ sourceNodeId: "n1", text: "a b c d e. f." }]);
    expect(chunks.map((c) => c.text)).toEqual(["a b c d", "e. f."]);
    const v = await e.embedPassages(["x", "yy", "zzz"]);
    expect(v.map((x) => Array.from(x))).toEqual([
      [1, 0, 0],
      [2, 0, 1],
      [3, 0, 2],
    ]);
    expect(Array.from(await e.embedQuery("qq"))).toEqual([2, 1, 0]);
    expect(await e.encode("query", "A")).toEqual([0, 65, 2]);
  });

  it("handles requests one at a time", async () => {
    const { e, log } = await fake("ok", 10);
    const results = await Promise.all([e.embedPassages(["a", "b", "c"]), e.embedPassages(["dd"]), e.embedQuery("e")]);
    expect(results.map((r) => (Array.isArray(r) ? r.length : 1))).toEqual([3, 1, 1]);
    expect(log[4]).toBe(1); // never two batches at once
  });

  it("cancels between batches and never interrupts a running batch", async () => {
    const { e, log } = await fake("ok", 40);
    const pending = e.embedPassages(Array.from({ length: 10 }, (_, i) => `t${i}`)); // 5 batches
    await new Promise((r) => setTimeout(r, 60));
    e.cancel();
    expect(await codeOf(pending)).toBe("CANCELLED");
    expect(log[0]).toBeLessThan(5);
    expect(log[0]).toBe(log[1]); // every started batch finished
    // The worker stays usable.
    expect((await e.embedPassages(["ok"])).length).toBe(1);
  });

  it("cancels through an AbortSignal, and immediately when already aborted", async () => {
    const { e, log } = await fake("ok", 40);
    const ac = new AbortController();
    const pending = e.embedPassages(Array.from({ length: 10 }, (_, i) => `t${i}`), { signal: ac.signal });
    setTimeout(() => ac.abort(), 60);
    expect(await codeOf(pending)).toBe("CANCELLED");
    expect(log[0]).toBe(log[1]);
    const before = log[0];
    expect(await codeOf(e.embedQuery("x", { signal: AbortSignal.abort() }))).toBe("CANCELLED");
    expect(log[0]).toBe(before);
  });

  it("close() cancels pending work, drains the running batch, releases, then the worker exits", async () => {
    const { e, log } = await fake("ok", 40);
    const pending = e.embedPassages(Array.from({ length: 10 }, (_, i) => `t${i}`));
    await new Promise((r) => setTimeout(r, 60));
    const closing = e.close();
    expect(e.close()).toBe(closing); // idempotent
    expect(await codeOf(pending)).toBe("CANCELLED");
    await closing;
    expect(e.state).toBe("closed");
    expect(log[2]).toBe(1); // released
    expect(log[3]).toBe(0); // no batch was running when the session was released
    expect(log[0]).toBe(log[1]);
    expect(await codeOf(e.embedQuery("late"))).toBe("CLOSED");
  });

  it("close({ finishPending: true }) lets pending work complete", async () => {
    const { e, log } = await fake("ok", 20);
    const pending = e.embedPassages(Array.from({ length: 6 }, (_, i) => `t${i}`));
    await new Promise((r) => setTimeout(r, 10));
    await e.close({ finishPending: true });
    expect((await pending).length).toBe(6);
    expect(log[0]).toBe(3);
    expect(log[3]).toBe(0);
  });

  it("reports an initialisation failure by code and leaves no worker running", async () => {
    expect(await codeOf(fake("init-fail"))).toBe("MODEL_INVALID");
  });

  it("maps inference failures to INFERENCE_FAILED without their message", async () => {
    const { e } = await fake("infer-fail");
    expect(await codeOf(e.embedPassages(["x"]))).toBe("INFERENCE_FAILED");
  });

  it("rejects invalid input and stays usable", async () => {
    const { e } = await fake();
    expect(await codeOf(e.embedPassages([42 as unknown as string]))).toBe("INVALID_INPUT");
    expect(await codeOf(e.chunk([{ sourceNodeId: "", text: "x" }]))).toBe("INVALID_INPUT");
    expect((await e.embedPassages(["fine"])).length).toBe(1);
  });

  it("fails pending and later calls with WORKER_FAILED when the worker crashes", async () => {
    const { e } = await fake("crash");
    expect(await codeOf(e.embedPassages(["x"]))).toBe("WORKER_FAILED");
    expect(e.state).toBe("failed");
    expect(await codeOf(e.embedQuery("y"))).toBe("WORKER_FAILED");
    await e.close();
  });
});

describe("Embedder (real worker entry)", () => {
  it("reports MODEL_MISSING for an empty model directory without loading the runtime", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-embedder-"));
    try {
      expect(await codeOf(Embedder.start({ modelDir: dir }))).toBe("MODEL_MISSING");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
