/**
 * The query inference process for search by meaning (M5.2; plan decision 2). Server-only.
 *
 * One child per server process, kept on `globalThis` (dev reloads reuse it), started by the
 * first search and closed after 5 minutes without one, so the model's memory (about
 * 0.8 GB) is held only while searching. It is the same `InferenceProcess`, entry, model
 * check, drain and watchdogs as indexing, and separate from the indexing child, so search
 * works during indexing. Queries are embedded one at a time. A child that failed is
 * dropped and replaced at the next search. The query text crosses only as an IPC request
 * and is never logged.
 */
import { EmbeddingError } from "../errors.ts";
import { inferenceTarget, modelState } from "../index/service.ts";
import { InferenceProcess } from "../inference-process.ts";

export const QUERY_IDLE_MS = 5 * 60_000;

type Where = { env?: Record<string, string | undefined>; root?: string; idleMs?: number };
type Host = { proc: InferenceProcess | null; starting: Promise<InferenceProcess> | null; queue: Promise<unknown>; idle: NodeJS.Timeout | null };

const holder = globalThis as unknown as { __threadatlasQueryHost?: Host };
const host = (): Host => (holder.__threadatlasQueryHost ??= { proc: null, starting: null, queue: Promise.resolve(), idle: null });

async function ready(where: Where): Promise<InferenceProcess> {
  const h = host();
  if (h.proc && h.proc.state === "ready") return h.proc;
  if (h.proc) {
    const old = h.proc;
    h.proc = null;
    await old.close().catch(() => {});
  }
  h.starting ??= (async () => {
    const env = where.env ?? process.env;
    const root = where.root ?? process.cwd();
    const model = await modelState(env, root);
    if (model.state !== "ok" || !model.dir) throw new EmbeddingError(model.state === "missing" ? "MODEL_MISSING" : "MODEL_INVALID");
    const target = inferenceTarget(env, root);
    return InferenceProcess.start({ entry: target.entry, modelDir: model.dir, testOptions: target.testOptions });
  })().finally(() => {
    host().starting = null;
  });
  h.proc = await h.starting;
  return h.proc;
}

/** Embeds a query; starts the query process if needed. Rejects with an `EmbeddingError`. */
export function embedQueryText(text: string, where: Where = {}): Promise<{ vector: Float32Array; info: InferenceProcess["info"] }> {
  const h = host();
  const run = async () => {
    if (h.idle) clearTimeout(h.idle);
    const proc = await ready(where);
    try {
      return { vector: await proc.embedQuery(text), info: proc.info };
    } catch (e) {
      if (proc.state !== "ready") h.proc = null; // crashed or timed out: replaced next time
      throw e;
    } finally {
      h.idle = setTimeout(() => void closeQueryHost(), where.idleMs ?? QUERY_IDLE_MS);
      h.idle.unref();
    }
  };
  const next = h.queue.then(run, run);
  h.queue = next.catch(() => {});
  return next;
}

/** Closes the query process (idle timeout; tests). */
export async function closeQueryHost(): Promise<void> {
  const h = host();
  if (h.idle) clearTimeout(h.idle);
  h.idle = null;
  const p = h.proc;
  h.proc = null;
  await p?.close().catch(() => {});
}

/** The running query process, if any (tests and diagnostics). */
export function queryProcess(): InferenceProcess | null {
  return host().proc;
}
