/**
 * Server-side client for the inference child process (M5.1b-2; plan §3). Implements the
 * indexer's `IndexEmbedder`, so the indexer is unchanged.
 *
 * - **Start:** `fork` of the child entry with an empty environment, no inherited Node
 *   flags and discarded stdio (native messages never reach the server's logs). The
 *   start-up data travels as the first IPC message, never in argv. The child verifies and
 *   loads the model and replies `ready` or `init-error`. Start-up timeout: 60 s, then the
 *   child is killed (`MODEL_LOAD_FAILED`).
 * - **Requests:** one at a time; bounded by `LIMITS` before anything is sent; every reply
 *   is checked (type, id, data length). A request with no reply within 120 s kills the
 *   child (`WORKER_FAILED`): a hung native call becomes an ordinary crash.
 * - **Cancellation:** a `cancel` message; the child stops before its next batch. A batch
 *   that has started always finishes.
 * - **Shutdown:** `close()` cancels, asks the child to release its session and waits for
 *   it to exit by itself. SIGKILL is used only if the child has not released its session
 *   within the request timeout (a hang), or has not exited 5 s after releasing it.
 * - **Isolation:** killing or losing the child never affects this process. If this
 *   process exits, the child notices the closed channel and drains by itself.
 *
 * Nothing here logs; failures are `EmbeddingError` codes. The Next.js server must import
 * this module, never `embedder.ts`, `worker.ts` or `pipeline.ts` (ONNX Runtime stays out
 * of the server process).
 */
import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Chunk, MessageInput } from "./chunker.ts";
import { EmbeddingError, isEmbeddingErrorCode, type EmbeddingErrorCode } from "./errors.ts";
import { LIMITS, requestChars, type ChildInit, type ChildRequest, type ChildResponse, type WorkerReadyInfo } from "./protocol.ts";

export const START_TIMEOUT_MS = 60_000;
export const REQUEST_TIMEOUT_MS = 120_000;
export const EXIT_TIMEOUT_MS = 5_000;

/** The production child entry, loaded from source (approved for the worker in D124). */
export const CHILD_ENTRY = path.join("src", "lib", "semantic", "inference-child.ts");

export function productionChildEntry(root: string): string {
  return path.resolve(root, CHILD_ENTRY);
}

export type InferenceProcessOptions = {
  /** Absolute path of the child entry (`productionChildEntry(root)` in the app). */
  readonly entry: string;
  /** Absolute path of the local model directory. */
  readonly modelDir: string;
  readonly verifyHashes?: boolean;
  /** Passed to test entries only; the production entry ignores it. */
  readonly testOptions?: Readonly<Record<string, unknown>>;
  readonly startTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly exitTimeoutMs?: number;
};

export type ChildExit = { code: number | null; signal: NodeJS.Signals | null };

type State = "ready" | "closing" | "closed" | "failed";
type Expect = "chunked" | "embedded";
type InFlight = {
  id: number;
  expect: Expect;
  count: number;
  timer: NodeJS.Timeout;
  resolve: (r: ChildResponse) => void;
  reject: (e: EmbeddingError) => void;
};

function checkEntry(entry: string): void {
  let ok = false;
  try {
    ok = path.isAbsolute(entry) && /\.(m?ts)$/.test(entry) && fs.statSync(entry).isFile();
  } catch {
    ok = false;
  }
  if (!ok) throw new EmbeddingError("RUNTIME_UNAVAILABLE");
}

function validInfo(x: unknown): x is WorkerReadyInfo {
  if (x === null || typeof x !== "object") return false;
  const i = x as Record<string, unknown>;
  return (
    Number.isSafeInteger(i.dimensions) &&
    (i.dimensions as number) > 0 &&
    (i.dimensions as number) <= 4096 &&
    typeof i.embeddingVersion === "string" &&
    typeof i.chunkerVersion === "string" &&
    typeof i.loadMs === "number"
  );
}

function validChunks(x: unknown): x is Chunk[] {
  return (
    Array.isArray(x) &&
    x.every(
      (c) =>
        c !== null &&
        typeof c === "object" &&
        typeof c.id === "string" &&
        typeof c.sourceNodeId === "string" &&
        typeof c.text === "string" &&
        Number.isSafeInteger(c.chunkIndex) &&
        Number.isSafeInteger(c.start) &&
        Number.isSafeInteger(c.end) &&
        Number.isSafeInteger(c.tokenCount),
    )
  );
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

export class InferenceProcess {
  readonly info: WorkerReadyInfo;
  readonly pid: number;
  readonly #child: ChildProcess;
  readonly #exited: Promise<ChildExit>;
  readonly #requestTimeoutMs: number;
  readonly #exitTimeoutMs: number;
  #seq = 0;
  #state: State = "ready";
  #inflight: InFlight | null = null;
  #closing: Promise<void> | null = null;
  #released = false;
  #onClosed: (() => void) | null = null;
  #exit: ChildExit | null = null;

  private constructor(child: ChildProcess, info: WorkerReadyInfo, exited: Promise<ChildExit>, opts: InferenceProcessOptions) {
    this.#child = child;
    this.pid = child.pid!;
    this.info = info;
    this.#exited = exited;
    this.#requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.#exitTimeoutMs = opts.exitTimeoutMs ?? EXIT_TIMEOUT_MS;
    child.on("message", (m: unknown) => this.#onMessage(m));
    void exited.then((e) => this.#onExit(e));
  }

  /** Starts the child and waits until the model is verified and loaded. Rejects with an `EmbeddingError`. */
  static async start(opts: InferenceProcessOptions): Promise<InferenceProcess> {
    checkEntry(opts.entry);
    if (typeof opts.modelDir !== "string" || !path.isAbsolute(opts.modelDir)) throw new EmbeddingError("MODEL_DIR_INVALID");
    let child: ChildProcess;
    try {
      child = fork(/* turbopackIgnore: true */ opts.entry, [], {
        serialization: "advanced",
        execArgv: [],
        env: {} as NodeJS.ProcessEnv, // nothing from the server's environment (the cast only satisfies Next's NODE_ENV typing)
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
    } catch {
      throw new EmbeddingError("RUNTIME_UNAVAILABLE");
    }
    let settle!: (e: ChildExit) => void;
    const exited = new Promise<ChildExit>((resolve) => (settle = resolve));
    child.once("exit", (code, signal) => settle({ code, signal }));
    // A spawn failure emits 'error' and may never emit 'exit'.
    child.on("error", () => {
      if (child.pid === undefined) settle({ code: null, signal: null });
    });

    const init: ChildInit = { type: "init", modelDir: opts.modelDir, verifyHashes: opts.verifyHashes !== false, testOptions: opts.testOptions };
    if (child.connected) child.send(init, undefined, undefined, () => {});

    const timeoutMs = opts.startTimeoutMs ?? START_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const first = await new Promise<ChildResponse | "exited" | "timeout">((resolve) => {
      child.once("message", (m: ChildResponse) => resolve(m));
      void exited.then(() => resolve("exited"));
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    }).finally(() => clearTimeout(timer));

    if (first !== "exited" && first !== "timeout" && first?.type === "ready" && validInfo(first.info)) {
      return new InferenceProcess(child, first.info, exited, opts);
    }
    let code: EmbeddingErrorCode = "WORKER_FAILED";
    if (first === "timeout") code = "MODEL_LOAD_FAILED";
    else if (first === "exited") code = child.pid === undefined ? "RUNTIME_UNAVAILABLE" : "WORKER_FAILED";
    else if (first?.type === "init-error" && isEmbeddingErrorCode(first.code)) code = first.code;
    // The child exits by itself after an init error; anything else is killed (never the server).
    if (first === "timeout" || first === "exited" || first?.type !== "init-error") {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    const gone = await Promise.race([exited.then(() => true), delay(opts.exitTimeoutMs ?? EXIT_TIMEOUT_MS).then(() => false)]);
    if (!gone) {
      child.kill("SIGKILL");
      await exited;
    }
    throw new EmbeddingError(code);
  }

  get state(): State {
    return this.#state;
  }

  /** How the child exited (null while it runs). For tests and diagnostics; never logged. */
  get exit(): ChildExit | null {
    return this.#exit;
  }

  /** Chunks the messages of one page (deterministic; see `chunker.ts`). */
  async chunk(messages: readonly MessageInput[]): Promise<Chunk[]> {
    if (
      !Array.isArray(messages) ||
      messages.length > LIMITS.maxMessagesPerCall ||
      !messages.every((m) => m !== null && typeof m === "object" && typeof m.text === "string" && m.text.length <= LIMITS.maxTextLength) ||
      requestChars(messages.map((m) => m.text)) > LIMITS.maxCharsPerCall
    ) {
      throw new EmbeddingError("INVALID_INPUT");
    }
    const r = await this.#call((id) => ({ type: "chunk", id, messages }), "chunked", messages.length);
    if (r.type !== "chunked" || !validChunks(r.chunks)) throw new EmbeddingError("WORKER_FAILED");
    return r.chunks;
  }

  /** Embeds passages (one window of chunk texts). Abort `signal` to cancel before the next batch. */
  async embedPassages(texts: readonly string[], opts: { signal?: AbortSignal } = {}): Promise<Float32Array[]> {
    if (
      !Array.isArray(texts) ||
      texts.length > LIMITS.maxTextsPerCall ||
      !texts.every((t) => typeof t === "string" && t.length <= LIMITS.maxTextLength) ||
      requestChars(texts) > LIMITS.maxCharsPerCall
    ) {
      throw new EmbeddingError("INVALID_INPUT");
    }
    if (opts.signal?.aborted) throw new EmbeddingError("CANCELLED");
    const r = await this.#call((id) => ({ type: "embed", id, kind: "passage", texts }), "embedded", texts.length, opts.signal);
    if (r.type !== "embedded") throw new EmbeddingError("WORKER_FAILED");
    const d = this.info.dimensions;
    return texts.map((_, i) => r.data.subarray(i * d, (i + 1) * d));
  }

  /** Embeds one search query (the `query: ` prefix is added in the child). M5.2. */
  async embedQuery(text: string): Promise<Float32Array> {
    if (typeof text !== "string" || text.length > LIMITS.maxTextLength) throw new EmbeddingError("INVALID_INPUT");
    const r = await this.#call((id) => ({ type: "embed", id, kind: "query", texts: [text] }), "embedded", 1);
    if (r.type !== "embedded") throw new EmbeddingError("WORKER_FAILED");
    return r.data;
  }

  /** Cancels the in-flight request at its next batch boundary. */
  cancel(): void {
    if (this.#inflight) this.#send({ type: "cancel", id: this.#inflight.id });
  }

  /**
   * Graceful shutdown: cancel, release the session, let the child exit by itself. Resolves
   * once the child has exited. Never kills a child that is releasing normally.
   */
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closing = (async () => {
      if (this.#state === "ready") {
        this.#state = "closing";
        this.cancel();
        const closed = new Promise<void>((resolve) => (this.#onClosed = resolve));
        this.#send({ type: "shutdown" });
        // The in-flight batch finishes first; only a child that never releases is a hang.
        const released = await Promise.race([
          closed.then(() => true),
          this.#exited.then(() => true),
          delay(this.#requestTimeoutMs).then(() => false),
        ]);
        if (!released) this.#kill();
      }
      const exited = await Promise.race([this.#exited.then(() => true), delay(this.#exitTimeoutMs).then(() => false)]);
      if (!exited) this.#kill();
      await this.#exited;
      if (this.#state !== "failed") this.#state = "closed";
      this.#rejectInflight("CLOSED");
    })();
    return this.#closing;
  }

  #call(make: (id: number) => ChildRequest, expect: Expect, count: number, signal?: AbortSignal): Promise<ChildResponse> {
    if (this.#state !== "ready") return Promise.reject(new EmbeddingError(this.#state === "failed" ? "WORKER_FAILED" : "CLOSED"));
    // The indexer is sequential; a second concurrent call is a programming error.
    if (this.#inflight) return Promise.reject(new EmbeddingError("INVALID_INPUT"));
    const id = ++this.#seq;
    const onAbort = () => this.#send({ type: "cancel", id });
    signal?.addEventListener("abort", onAbort, { once: true });
    return new Promise<ChildResponse>((resolve, reject) => {
      const timer = setTimeout(() => this.#hung(), this.#requestTimeoutMs);
      timer.unref();
      this.#inflight = { id, expect, count, timer, resolve, reject };
      this.#send(make(id));
    }).finally(() => signal?.removeEventListener("abort", onAbort));
  }

  #onMessage(raw: unknown): void {
    if (raw === null || typeof raw !== "object") return;
    const m = raw as ChildResponse;
    if (m.type === "closed") {
      this.#released = true;
      this.#onClosed?.();
      return;
    }
    if (!("id" in m)) return;
    const p = this.#inflight;
    if (!p || m.id !== p.id) return; // unknown or stale id: ignored
    clearTimeout(p.timer);
    this.#inflight = null;
    if (m.type === "error") {
      p.reject(new EmbeddingError(isEmbeddingErrorCode(m.code) ? m.code : "WORKER_FAILED"));
      return;
    }
    const valid =
      m.type === p.expect &&
      (m.type !== "embedded" || (m.data instanceof Float32Array && m.data.length === p.count * this.info.dimensions));
    if (!valid) {
      // A protocol violation: the child's state is unknown, so it is not used again.
      this.#state = "failed";
      this.#kill();
      p.reject(new EmbeddingError("WORKER_FAILED"));
      return;
    }
    p.resolve(m);
  }

  /** No reply within the request timeout: a hung native call. Ends the child only. */
  #hung(): void {
    if (this.#state === "ready" || this.#state === "closing") this.#state = "failed";
    this.#kill();
    this.#rejectInflight("WORKER_FAILED");
  }

  #onExit(e: ChildExit): void {
    this.#exit = e;
    if (this.#state === "ready") this.#state = "failed";
    this.#rejectInflight(this.#state === "failed" ? "WORKER_FAILED" : "CLOSED");
  }

  #rejectInflight(code: EmbeddingErrorCode): void {
    const p = this.#inflight;
    if (!p) return;
    clearTimeout(p.timer);
    this.#inflight = null;
    p.reject(new EmbeddingError(code));
  }

  #send(m: ChildRequest): void {
    if (this.#child.connected) this.#child.send(m, undefined, undefined, () => {});
  }

  #kill(): void {
    if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill("SIGKILL");
  }

  /** True once the child reported that its session is released. */
  get released(): boolean {
    return this.#released;
  }
}
