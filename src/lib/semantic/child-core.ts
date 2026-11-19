/**
 * The inference child process's side of the IPC channel (M5.1b-2; plan §3).
 *
 * Runs the unchanged worker message loop (`serveWorker`) over the process's IPC channel.
 * ONNX Runtime lives only in this process, so nothing the server does (exit, a signal, a
 * dev restart) can abort the server, and a native crash here ends only this process.
 *
 * **Start:** the first message must be `init` (anything before it is ignored; a malformed
 * `init` gets `init-error INVALID_INPUT`). Nothing comes from argv or the environment.
 *
 * **Requests:** checked again here (types, ids, the per-request size bound) before they
 * reach the loop. `embed` gets a local cancel flag; a `cancel` message sets it. The
 * pipeline yields to the event loop before each batch, so a cancel that arrived during a
 * batch is read before the next one starts.
 *
 * **Drain:** a `shutdown` message, IPC `disconnect` (the parent exited, however it exited),
 * SIGINT/SIGTERM, a channel `error`, an uncaught exception or rejection all lead to the
 * same path: set every cancel flag, queue `shutdown` behind the in-flight request, release
 * the session, exit 0. Sends take an error callback, so a closing channel can never raise
 * an unhandled `error` event that would end this process mid-inference.
 *
 * **Orphan backstop (owner's condition 3):** a watchdog thread arms only after the parent
 * is confirmed gone (this process was re-parented: `process.ppid` changed). A normal drain
 * releases the session well within the grace period and disarms it. Only a child that is
 * still not released `orphanGraceMs` after confirmed parent loss (a hang inside native
 * code, which also blocks this thread's timers) is killed, by itself, with SIGKILL. It
 * never signals any other process.
 *
 * Never logs and never touches the database. Errors cross as codes only.
 */
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { EmbeddingPipeline } from "./pipeline.ts";
import { LIMITS, requestChars, type ChildInit, type ChildRequest, type WorkerRequest, type WorkerResponse } from "./protocol.ts";
import { serveWorker } from "./worker-core.ts";

/** How long a confirmed orphan may take to release its session before it kills itself. */
export const ORPHAN_GRACE_MS = 30_000;
const PPID_POLL_MS = 1_000;
/** After release nothing native runs; exit even if a handle would keep the process alive. */
const EXIT_AFTER_RELEASE_MS = 1_000;

export type ChildSetup = {
  readonly load: () => Promise<EmbeddingPipeline>;
  /** Test entries only (bounded to 100 ms–30 s); production uses `ORPHAN_GRACE_MS`. */
  readonly orphanGraceMs?: number;
  /** Test entries only: static event names for an event log. Never given content. */
  readonly onEvent?: (name: string) => void;
};

type Port = Parameters<typeof serveWorker>[0];

const isId = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) > 0;

function validInit(m: Partial<ChildInit>): m is ChildInit {
  return (
    typeof m.modelDir === "string" &&
    m.modelDir !== "" &&
    path.isAbsolute(m.modelDir) &&
    typeof m.verifyHashes === "boolean" &&
    (m.testOptions === undefined || (typeof m.testOptions === "object" && m.testOptions !== null))
  );
}

/** Watchdog thread source (eval'd, so no file path is involved). Arms only when the parent is gone. */
const WATCHDOG_SOURCE = `
const { parentPort, workerData } = process.getBuiltinModule("node:worker_threads");
const { ppid, graceMs, pollMs } = workerData;
let released = false;
let lostAt = 0;
parentPort.on("message", (m) => { if (m === "released") released = true; });
const timer = setInterval(() => {
  if (released) { clearInterval(timer); parentPort.close(); return; }
  if (lostAt === 0 && process.ppid !== ppid) lostAt = Date.now();
  if (lostAt !== 0 && Date.now() - lostAt >= graceMs) process.kill(process.pid, "SIGKILL");
}, pollMs);
`;

export function serveOverIpc(setup: (init: ChildInit) => ChildSetup): void {
  if (!process.send) process.exit(2);
  const startPpid = process.ppid;
  const listeners: ((m: WorkerRequest) => void)[] = [];
  const flags = new Map<number, Int32Array>();
  let setupResult: ChildSetup | null = null;
  let draining = false;
  let watchdog: Worker | null = null;
  const event = (name: string) => {
    try {
      setupResult?.onEvent?.(name);
    } catch {
      // diagnostics must never affect the child
    }
  };

  const send = (m: WorkerResponse) => {
    if ("id" in m) flags.delete(m.id);
    // The callback receives a send error (closing channel) instead of an 'error' event.
    if (process.connected) process.send!(m, undefined, undefined, () => {});
  };
  const dispatch = (m: WorkerRequest) => {
    for (const l of listeners) l(m);
  };

  const port: Port = {
    on(_event: "message", fn: (m: WorkerRequest) => void) {
      listeners.push(fn);
      return port;
    },
    postMessage(m: WorkerResponse) {
      send(m);
    },
    close() {
      // serveWorker calls this after releasing the session (or after an init error).
      event("released");
      watchdog?.postMessage("released");
      if (process.connected) process.disconnect();
      setTimeout(() => process.exit(0), EXIT_AFTER_RELEASE_MS).unref();
    },
  } as unknown as Port;

  function drain(cause: string): void {
    if (draining) return;
    draining = true;
    event(`drain:${cause}`);
    for (const f of flags.values()) Atomics.store(f, 0, 1);
    if (!setupResult) process.exit(0); // nothing loaded, nothing native running
    dispatch({ type: "shutdown" });
  }

  function startWatchdog(graceMs: number): void {
    try {
      watchdog = new Worker(WATCHDOG_SOURCE, { eval: true, workerData: { ppid: startPpid, graceMs, pollMs: PPID_POLL_MS } });
      watchdog.on("error", () => {});
      watchdog.unref();
    } catch {
      watchdog = null; // the IPC disconnect path still drains; only the hang backstop is lost
    }
  }

  function reject(id: number, code: "INVALID_INPUT" | "CLOSED"): void {
    send({ type: "error", id, code });
  }

  process.on("message", (raw: unknown) => {
    if (raw === null || typeof raw !== "object") return;
    const m = raw as ChildRequest;
    if (!setupResult) {
      if (m.type !== "init") return;
      if (!validInit(m)) {
        send({ type: "init-error", code: "INVALID_INPUT" });
        if (process.connected) process.disconnect();
        setTimeout(() => process.exit(0), EXIT_AFTER_RELEASE_MS).unref();
        return;
      }
      setupResult = setup(m);
      const grace = setupResult.orphanGraceMs;
      startWatchdog(typeof grace === "number" && grace >= 100 && grace <= ORPHAN_GRACE_MS ? grace : ORPHAN_GRACE_MS);
      serveWorker(port, setupResult.load);
      return;
    }
    switch (m.type) {
      case "cancel": {
        if (!isId(m.id)) return;
        event("cancel-received");
        const f = flags.get(m.id);
        if (f) Atomics.store(f, 0, 1);
        return;
      }
      case "shutdown":
        return drain("message");
      case "embed": {
        if (!isId(m.id)) return;
        if (draining) return reject(m.id, "CLOSED");
        if (!Array.isArray(m.texts) || !m.texts.every((t) => typeof t === "string") || requestChars(m.texts) > LIMITS.maxCharsPerCall) {
          return reject(m.id, "INVALID_INPUT");
        }
        const f = new Int32Array(new SharedArrayBuffer(4));
        flags.set(m.id, f);
        return dispatch({ type: "embed", id: m.id, kind: m.kind, texts: m.texts, cancel: f });
      }
      case "chunk": {
        if (!isId(m.id)) return;
        if (draining) return reject(m.id, "CLOSED");
        const ok =
          Array.isArray(m.messages) &&
          m.messages.every((x) => x !== null && typeof x === "object" && typeof x.text === "string") &&
          requestChars(m.messages.map((x) => x.text)) <= LIMITS.maxCharsPerCall;
        if (!ok) return reject(m.id, "INVALID_INPUT");
        return dispatch({ type: "chunk", id: m.id, messages: m.messages });
      }
      default:
        return; // unknown type or a second init: ignored
    }
  });

  process.on("disconnect", () => drain("disconnect"));
  process.on("SIGINT", () => drain("SIGINT"));
  process.on("SIGTERM", () => drain("SIGTERM"));
  process.on("error", () => drain("ipc-error"));
  process.on("uncaughtException", () => drain("uncaught"));
  process.on("unhandledRejection", () => drain("unhandled"));
}
