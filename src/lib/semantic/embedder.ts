/**
 * Main-thread client for the inference worker (ADR 0002 decision 3).
 *
 * - **Isolation:** the model runs only in a worker thread, so inference never blocks the
 *   server's event loop and ONNX Runtime is never loaded on the main thread.
 * - **Cancellation:** cooperative, between batches. `cancel()` or an aborted `signal`
 *   sets the request's shared flag; the worker stops before its next batch and the
 *   call rejects with `CANCELLED`. A batch that has started always finishes.
 * - **Shutdown:** `close()` refuses new work, cancels pending work (unless asked to
 *   finish it), waits for the in-flight batch, asks the worker to release the session
 *   and lets it exit by itself. `worker.terminate()` is only a last resort once the
 *   session has been released, never while inference is running.
 * - **Privacy:** failures are `EmbeddingError` codes; nothing here logs.
 */
import { Worker } from "node:worker_threads";
import type { Chunk, MessageInput } from "./chunker.ts";
import { EmbeddingError, isEmbeddingErrorCode, type EmbeddingErrorCode } from "./errors.ts";
import type { TextKind } from "./pipeline.ts";
import { LIMITS, type WorkerInit, type WorkerReadyInfo, type WorkerRequest, type WorkerResponse } from "./protocol.ts";

export type EmbedderOptions = {
  /** Absolute path of the local model directory (see `resolveModelDir`). */
  readonly modelDir: string;
  /** Verify SHA-256 of every model file at start-up (default true; sizes are always checked). */
  readonly verifyHashes?: boolean;
  /** Worker entry; defaults to `./worker.ts`. Tests use a fake-pipeline entry. */
  readonly workerUrl?: URL;
  /** Extra start-up data for a custom worker entry (tests). */
  readonly workerData?: Readonly<Record<string, unknown>>;
  /** How long to wait for the worker to exit after releasing its session (default 5 s). */
  readonly exitTimeoutMs?: number;
};

type Pending = {
  resolve: (r: WorkerResponse) => void;
  reject: (e: EmbeddingError) => void;
  cancel?: Int32Array;
};

type State = "starting" | "ready" | "closing" | "closed" | "failed";

export class Embedder {
  readonly info: WorkerReadyInfo;
  readonly #worker: Worker;
  readonly #pending = new Map<number, Pending>();
  readonly #exitTimeoutMs: number;
  #seq = 0;
  #state: State = "ready";
  #closing: Promise<void> | null = null;
  #exited: Promise<void>;
  #closedReply: (() => void) | null = null;

  private constructor(worker: Worker, info: WorkerReadyInfo, exited: Promise<void>, exitTimeoutMs: number) {
    this.#worker = worker;
    this.info = info;
    this.#exited = exited;
    this.#exitTimeoutMs = exitTimeoutMs;
    worker.on("message", (m: WorkerResponse) => this.#onMessage(m));
    void exited.then(() => this.#fail());
  }

  /** Starts the worker and waits until the model is loaded. Rejects with an `EmbeddingError`. */
  static async start(opts: EmbedderOptions): Promise<Embedder> {
    const init: WorkerInit = { modelDir: opts.modelDir, verifyHashes: opts.verifyHashes !== false };
    const workerData = { ...opts.workerData, ...init };
    const worker = new Worker(opts.workerUrl ?? new URL("./worker.ts", import.meta.url), { workerData });
    let onExit!: () => void;
    const exited = new Promise<void>((resolve) => (onExit = resolve));
    worker.once("exit", () => onExit());
    // An uncaught error ends the worker; the "exit" event follows.
    worker.on("error", () => {});
    const first = await new Promise<WorkerResponse | null>((resolve) => {
      worker.once("message", (m: WorkerResponse) => resolve(m));
      void exited.then(() => resolve(null));
    });
    if (first?.type === "ready") return new Embedder(worker, first.info, exited, opts.exitTimeoutMs ?? 5_000);
    const code: EmbeddingErrorCode = first?.type === "init-error" && isEmbeddingErrorCode(first.code) ? first.code : "WORKER_FAILED";
    await exited; // the worker closes its port after an init error and exits by itself
    throw new EmbeddingError(code);
  }

  get state(): State {
    return this.#state;
  }

  /** Chunks the messages of one conversation (deterministic; see `chunker.ts`). */
  async chunk(messages: readonly MessageInput[]): Promise<Chunk[]> {
    if (!Array.isArray(messages) || messages.length > LIMITS.maxMessagesPerCall) throw new EmbeddingError("INVALID_INPUT");
    const r = await this.#call((id) => ({ type: "chunk", id, messages }));
    if (r.type !== "chunked") throw new EmbeddingError("WORKER_FAILED");
    return r.chunks;
  }

  /** Model input ids for a text (prefix, special tokens, truncation). For diagnostics and tests. */
  async encode(kind: TextKind, text: string): Promise<number[]> {
    const r = await this.#call((id) => ({ type: "encode", id, kind, text }));
    if (r.type !== "encoded") throw new EmbeddingError("WORKER_FAILED");
    return r.ids;
  }

  /**
   * Embeds passages (chunk texts, without the `passage: ` prefix). Pass one
   * conversation's chunks per call: batching is per call (see `pipeline.ts`).
   */
  embedPassages(texts: readonly string[], opts: { signal?: AbortSignal } = {}): Promise<Float32Array[]> {
    return this.#embed("passage", texts, opts.signal);
  }

  async embedQuery(text: string, opts: { signal?: AbortSignal } = {}): Promise<Float32Array> {
    const [v] = await this.#embed("query", [text], opts.signal);
    if (!v) throw new EmbeddingError("WORKER_FAILED");
    return v;
  }

  /** Cancels every embedding request submitted so far, at its next batch boundary. */
  cancel(): void {
    for (const p of this.#pending.values()) if (p.cancel) Atomics.store(p.cancel, 0, 1);
  }

  /**
   * Graceful shutdown. By default pending embedding requests are cancelled (each stops
   * at its next batch boundary); with `{ finishPending: true }` they run to completion.
   * Resolves once the worker has released the session and exited.
   */
  close(opts: { finishPending?: boolean } = {}): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closing = (async () => {
      if (this.#state === "ready") this.#state = "closing";
      if (!opts.finishPending) this.cancel();
      if (this.#state === "closing") {
        const closed = new Promise<void>((resolve) => (this.#closedReply = resolve));
        this.#worker.postMessage({ type: "shutdown" } satisfies WorkerRequest);
        await Promise.race([closed, this.#exited]); // in-flight work completes first
      }
      // The session is released (or the worker is gone): no inference can be running.
      const timedOut = await Promise.race([
        this.#exited.then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), this.#exitTimeoutMs).unref()),
      ]);
      if (timedOut) await this.#worker.terminate();
      this.#state = "closed";
      this.#rejectAll("CLOSED");
    })();
    return this.#closing;
  }

  async #embed(kind: TextKind, texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]> {
    if (!Array.isArray(texts) || texts.length > LIMITS.maxTextsPerCall) throw new EmbeddingError("INVALID_INPUT");
    if (signal?.aborted) throw new EmbeddingError("CANCELLED");
    const cancel = new Int32Array(new SharedArrayBuffer(4));
    const onAbort = () => Atomics.store(cancel, 0, 1);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const r = await this.#call((id) => ({ type: "embed", id, kind, texts, cancel }), cancel);
      if (r.type !== "embedded") throw new EmbeddingError("WORKER_FAILED");
      const d = this.info.dimensions;
      if (r.data.length !== texts.length * d) throw new EmbeddingError("WORKER_FAILED");
      return texts.map((_, i) => r.data.subarray(i * d, (i + 1) * d));
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  #call(make: (id: number) => WorkerRequest, cancel?: Int32Array): Promise<WorkerResponse> {
    if (this.#state !== "ready") return Promise.reject(new EmbeddingError(this.#state === "failed" ? "WORKER_FAILED" : "CLOSED"));
    const id = ++this.#seq;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, cancel });
      this.#worker.postMessage(make(id));
    });
  }

  #onMessage(m: WorkerResponse): void {
    if (m.type === "closed") {
      this.#closedReply?.();
      return;
    }
    if (!("id" in m)) return;
    const p = this.#pending.get(m.id);
    if (!p) return;
    this.#pending.delete(m.id);
    if (m.type === "error") p.reject(new EmbeddingError(isEmbeddingErrorCode(m.code) ? m.code : "WORKER_FAILED"));
    else p.resolve(m);
  }

  #fail(): void {
    if (this.#state === "ready" || this.#state === "closing") this.#state = this.#state === "closing" ? "closed" : "failed";
    this.#rejectAll(this.#state === "failed" ? "WORKER_FAILED" : "CLOSED");
  }

  #rejectAll(code: EmbeddingErrorCode): void {
    for (const p of this.#pending.values()) p.reject(new EmbeddingError(code));
    this.#pending.clear();
  }
}
