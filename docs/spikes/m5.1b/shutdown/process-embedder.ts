/**
 * Client for the inference child process (M5.1b shutdown comparison; spike).
 * Same surface and rules as `src/lib/semantic/embedder.ts`, with a child process
 * instead of a worker thread:
 * - cancellation is a `cancel` message (a SharedArrayBuffer cannot cross processes);
 *   the child sets its own flag, checked before each batch;
 * - `close()` drains like the worker version; SIGKILL is used only after the child
 *   reported that its session is released, never while it may be inferring;
 * - if this process dies, the child notices the closed IPC channel and drains itself.
 */
import { fork, type ChildProcess } from "node:child_process";
import { EmbeddingError, isEmbeddingErrorCode, type EmbeddingErrorCode } from "../../../../src/lib/semantic/errors.ts";
import type { WorkerReadyInfo, WorkerResponse } from "../../../../src/lib/semantic/protocol.ts";

export type ProcessEmbedderOptions = {
  modelDir: string;
  verifyHashes?: boolean;
  /** Absolute path of the child entry. */
  entry: string;
  /** Spike only: an event log for the child; "inherit" shows native error output. */
  log?: string;
  stderr?: "ignore" | "inherit";
  exitTimeoutMs?: number;
};

type Pending = { resolve: (r: WorkerResponse) => void; reject: (e: EmbeddingError) => void };

export class ProcessEmbedder {
  readonly info: WorkerReadyInfo;
  readonly pid: number;
  readonly #child: ChildProcess;
  readonly #pending = new Map<number, Pending>();
  readonly #exited: Promise<void>;
  readonly #exitTimeoutMs: number;
  #seq = 0;
  #state: "ready" | "closing" | "closed" | "failed" = "ready";
  #closing: Promise<void> | null = null;
  #released = false;

  private constructor(child: ChildProcess, info: WorkerReadyInfo, exited: Promise<void>, exitTimeoutMs: number) {
    this.#child = child;
    this.pid = child.pid!;
    this.info = info;
    this.#exited = exited;
    this.#exitTimeoutMs = exitTimeoutMs;
    child.on("message", (m: WorkerResponse) => this.#onMessage(m));
    void exited.then(() => this.#fail());
  }

  static async start(opts: ProcessEmbedderOptions): Promise<ProcessEmbedder> {
    const child = fork(/* turbopackIgnore: true */ opts.entry, [JSON.stringify({ modelDir: opts.modelDir, verifyHashes: opts.verifyHashes !== false, log: opts.log })], {
      serialization: "advanced",
      execArgv: [],
      env: {} as NodeJS.ProcessEnv, // nothing from the server's environment
      stdio: ["ignore", "ignore", opts.stderr ?? "ignore", "ipc"],
    });
    let onExit!: () => void;
    const exited = new Promise<void>((resolve) => (onExit = resolve));
    child.once("exit", () => onExit());
    child.on("error", () => {});
    const first = await new Promise<WorkerResponse | null>((resolve) => {
      child.once("message", (m: WorkerResponse) => resolve(m));
      void exited.then(() => resolve(null));
    });
    if (first?.type === "ready") return new ProcessEmbedder(child, first.info, exited, opts.exitTimeoutMs ?? 5_000);
    const code: EmbeddingErrorCode = first?.type === "init-error" && isEmbeddingErrorCode(first.code) ? first.code : "WORKER_FAILED";
    await exited;
    throw new EmbeddingError(code);
  }

  get state() {
    return this.#state;
  }

  async embedPassages(texts: readonly string[], opts: { signal?: AbortSignal } = {}): Promise<Float32Array[]> {
    if (opts.signal?.aborted) throw new EmbeddingError("CANCELLED");
    const r = await this.#call((id) => ({ type: "embed", id, kind: "passage", texts }), opts.signal);
    if (r.type !== "embedded") throw new EmbeddingError("WORKER_FAILED");
    const d = this.info.dimensions;
    return texts.map((_, i) => r.data.subarray(i * d, (i + 1) * d));
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const r = await this.#call((id) => ({ type: "embed", id, kind: "query", texts: [text] }));
    if (r.type !== "embedded") throw new EmbeddingError("WORKER_FAILED");
    return r.data;
  }

  cancel(): void {
    for (const id of this.#pending.keys()) this.#send({ type: "cancel", id });
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closing = (async () => {
      if (this.#state === "ready") this.#state = "closing";
      this.cancel();
      if (this.#state === "closing") {
        const closed = new Promise<void>((resolve) => (this.#onClosed = resolve));
        this.#send({ type: "shutdown" });
        await Promise.race([closed, this.#exited]);
      }
      const timedOut = await Promise.race([
        this.#exited.then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), this.#exitTimeoutMs).unref()),
      ]);
      // Only reached after the child released its session (or exited): never mid-inference.
      if (timedOut && this.#released) this.#child.kill("SIGKILL");
      this.#state = "closed";
      this.#rejectAll("CLOSED");
    })();
    return this.#closing;
  }

  #onClosed: (() => void) | null = null;

  #send(m: unknown) {
    if (this.#child.connected) this.#child.send(m as never);
  }

  #call(make: (id: number) => unknown, signal?: AbortSignal): Promise<Extract<WorkerResponse, { id: number }>> {
    if (this.#state !== "ready") return Promise.reject(new EmbeddingError(this.#state === "failed" ? "WORKER_FAILED" : "CLOSED"));
    const id = ++this.#seq;
    const onAbort = () => this.#send({ type: "cancel", id });
    signal?.addEventListener("abort", onAbort, { once: true });
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as Pending["resolve"], reject });
      this.#send(make(id));
    }).finally(() => signal?.removeEventListener("abort", onAbort)) as Promise<Extract<WorkerResponse, { id: number }>>;
  }

  #onMessage(m: WorkerResponse): void {
    if (m.type === "closed") {
      this.#released = true;
      this.#onClosed?.();
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
