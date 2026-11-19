/**
 * Inference child process (M5.1b shutdown comparison; spike, not app code).
 *
 * Runs the unchanged M5.1a worker loop (`serveWorker`) over the IPC channel instead of a
 * worker MessagePort. ONNX Runtime lives only in this process, so nothing the server
 * process does (process.exit, SIGKILL, a dev restart) can abort it mid-inference.
 *
 * Shutdown: a `shutdown` message, SIGINT/SIGTERM, or loss of the parent (IPC
 * disconnect) all lead to the same drain: set the cancel flags, let the current batch
 * finish, release the session, exit. Nothing is ever logged except, in this spike,
 * static event names and timings to the file named in the init data.
 */
import fs from "node:fs";
import { loadE5Pipeline } from "../../../../src/lib/semantic/pipeline.ts";
import type { WorkerRequest, WorkerResponse } from "../../../../src/lib/semantic/protocol.ts";
import { serveWorker } from "../../../../src/lib/semantic/worker-core.ts";

type Init = { modelDir: string; verifyHashes: boolean; log?: string; fakeCrashAfterMs?: number };
const init = JSON.parse(process.argv[2] ?? "{}") as Init;
const t0 = performance.now();
const event = (name: string, extra: Record<string, unknown> = {}) => {
  if (init.log) fs.appendFileSync(init.log, JSON.stringify({ pid: process.pid, role: "child", t: Math.round(performance.now() - t0), name, ...extra }) + "\n");
};
if (!process.send) process.exit(2);

const listeners: ((m: WorkerRequest) => void)[] = [];
const flags = new Map<number, Int32Array>();
const dispatch = (m: WorkerRequest) => listeners.forEach((l) => l(m));

const port = {
  on(_event: "message", fn: (m: WorkerRequest) => void) {
    listeners.push(fn);
    return port;
  },
  postMessage(m: WorkerResponse) {
    if ("id" in m) flags.delete(m.id);
    // A send on a closing channel reports its error to the callback instead of an
    // unhandled 'error' event, which would end this process mid-inference (found in the spike).
    if (process.connected) process.send!(m, undefined, undefined, () => {});
  },
  close() {
    // Called by serveWorker after the session is released (or after an init error).
    event("released");
    if (process.connected) process.disconnect();
    // The session is released, so exiting can no longer abort native code.
    setTimeout(() => {
      event("exit-forced-after-release");
      process.exit(0);
    }, 1_000).unref();
  },
};

let draining = false;
function drain(cause: string) {
  if (draining) return;
  draining = true;
  event("drain", { cause });
  for (const f of flags.values()) Atomics.store(f, 0, 1);
  dispatch({ type: "shutdown" });
}

process.on("message", (raw) => {
  const m = raw as WorkerRequest | { type: "cancel"; id: number };
  if (m.type === "cancel") {
    const f = flags.get(m.id);
    if (f) Atomics.store(f, 0, 1);
    return;
  }
  if (m.type === "shutdown") return drain("message");
  if (m.type === "embed") {
    const f = new Int32Array(new SharedArrayBuffer(4));
    flags.set(m.id, f);
    return dispatch({ ...m, cancel: f });
  }
  dispatch(m);
});
process.on("disconnect", () => drain("disconnect"));
process.on("SIGINT", () => drain("SIGINT"));
process.on("SIGTERM", () => drain("SIGTERM"));
process.on("exit", (code) => event("exit", { code }));
// Any other channel error (the parent vanished): drain instead of crashing.
process.on("error", () => drain("ipc-error"));
process.on("uncaughtException", () => drain("uncaught"));

serveWorker(port as unknown as Parameters<typeof serveWorker>[0], () => loadE5Pipeline(init.modelDir, { verifyHashes: init.verifyHashes }));
event("started");
