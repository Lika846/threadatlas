/**
 * The inference worker's message loop, separate from the entry file so that tests can
 * serve it with a fake pipeline.
 *
 * - Requests are handled strictly one at a time, in arrival order.
 * - `embed` checks its cancel flag before each batch (cooperative cancellation).
 * - `shutdown` is queued like any request, so it runs after the in-flight request has
 *   finished. It releases the pipeline (the ONNX session), replies `closed` and closes
 *   the port; the worker then exits on its own, with no inference running.
 * - Nothing is logged. Failures are reported as codes.
 */
import type { MessagePort } from "node:worker_threads";
import { EMBEDDING_VERSION } from "./model-manifest.ts";
import { CHUNKER_VERSION } from "./chunker.ts";
import { errorCodeOf, EmbeddingError } from "./errors.ts";
import type { EmbeddingPipeline } from "./pipeline.ts";
import { LIMITS, type WorkerRequest, type WorkerResponse } from "./protocol.ts";

type Port = Pick<MessagePort, "on" | "postMessage" | "close">;

const isString = (x: unknown): x is string => typeof x === "string" && x.length <= LIMITS.maxTextLength;

function validate(m: WorkerRequest): void {
  const ok = (() => {
    switch (m.type) {
      case "chunk":
        return (
          Array.isArray(m.messages) &&
          m.messages.length <= LIMITS.maxMessagesPerCall &&
          m.messages.every((x) => x !== null && typeof x === "object" && isString(x.text) && typeof x.sourceNodeId === "string" && x.sourceNodeId !== "")
        );
      case "encode":
        return (m.kind === "query" || m.kind === "passage") && isString(m.text);
      case "embed":
        return (
          (m.kind === "query" || m.kind === "passage") &&
          Array.isArray(m.texts) &&
          m.texts.length <= LIMITS.maxTextsPerCall &&
          m.texts.every(isString) &&
          m.cancel instanceof Int32Array
        );
      default:
        return true;
    }
  })();
  if (!ok) throw new EmbeddingError("INVALID_INPUT");
}

export function serveWorker(port: Port, load: () => Promise<EmbeddingPipeline>): void {
  const post = (r: WorkerResponse, transfer?: ArrayBuffer[]) => port.postMessage(r, transfer);
  let pipeline: EmbeddingPipeline | null = null;
  let chain: Promise<void> = Promise.resolve();

  const started = performance.now();
  const ready = load().then(
    (p) => {
      pipeline = p;
      post({
        type: "ready",
        info: {
          dimensions: p.dimensions,
          embeddingVersion: EMBEDDING_VERSION,
          chunkerVersion: CHUNKER_VERSION,
          loadMs: Math.round(performance.now() - started),
        },
      });
      return true;
    },
    (err: unknown) => {
      post({ type: "init-error", code: errorCodeOf(err, "MODEL_LOAD_FAILED") });
      port.close();
      return false;
    },
  );

  async function handle(m: WorkerRequest): Promise<void> {
    if (!(await ready) || !pipeline) return;
    if (m.type === "shutdown") {
      await pipeline.release().catch(() => {});
      pipeline = null;
      post({ type: "closed" });
      port.close();
      return;
    }
    try {
      validate(m);
      if (m.type === "chunk") {
        post({ type: "chunked", id: m.id, chunks: pipeline.chunk(m.messages) });
      } else if (m.type === "encode") {
        post({ type: "encoded", id: m.id, ids: pipeline.encode(m.kind, m.text) });
      } else {
        const data = await pipeline.embed(m.kind, m.texts, { shouldStop: () => Atomics.load(m.cancel, 0) !== 0 });
        post({ type: "embedded", id: m.id, data }, [data.buffer as ArrayBuffer]);
      }
    } catch (err) {
      post({ type: "error", id: m.id, code: errorCodeOf(err, "INFERENCE_FAILED") });
    }
  }

  port.on("message", (m: WorkerRequest) => {
    chain = chain.then(() => handle(m));
  });
}
