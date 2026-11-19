/**
 * The indexing session (M5.1b-1; design §5, decisions D123 and D124).
 *
 * **Start:**
 * 1. take the indexer lock (`INDEXER_BUSY`), so a second process is refused before it starts
 *    an inference process or loads the model (M5.1b-2);
 * 2. open the embedder (model check, inference start); its reported versions and dimensions
 *    must equal the code's (`INDEX_CONFIG_MISMATCH`). Nothing is written on failure, and the
 *    lock is released on every path;
 * 3. Reconcile (one transaction under the write lock).
 *
 * **Loop, one conversation at a time:**
 * - T1 (write lock, short transaction): claim the oldest pending row and list the ids
 *   and lengths of its visible messages;
 * - inference, with no lock and no transaction: pages of message text (≤ 200 messages,
 *   ≤ 1,000,000 characters) read on the reader connection with the claim re-checked in
 *   the same statement; chunks embedded in windows of ≤ 256; each window quantised to
 *   int8 at once, the floats dropped (I8);
 * - T2 (write lock, one transaction): the compare-and-set of I4, then all chunks.
 *
 * **Failures (§5.6):** recoverable → retried, `failed` after 3 attempts; permanent
 * (`CONVERSATION_TOO_LARGE`, `INVALID_INPUT`) → `failed` at once; run-level (model,
 * runtime, configuration, database, lock) → the run stops and the attempt is refunded;
 * worker crash → the run stops and the attempt is kept. Pause, stale discards and a busy
 * write lock are not failures.
 *
 * **Interrupted runs (M5.1b-2, owner's condition 2):** while a claim's inference is in
 * progress, a normal process exit (`process.exit`, as Next.js does on SIGTERM/SIGINT)
 * refunds its attempt synchronously (`exit-refund.ts`). A hard death (SIGKILL, a crash)
 * keeps it, and Reconcile resets the row at the next Start (I5, unchanged). Once a child
 * crash, a request timeout or an inference failure is observed, the claim is no longer
 * refunded at exit, so a crashing conversation always uses up its attempts.
 *
 * **Pause:** abort `signal`. The in-flight batch finishes, the claimed row goes back to
 * `pending` (attempt refunded), the embedder is closed (drained, never terminated
 * mid-batch), then the indexer lock is released.
 *
 * Lock order: indexer lock, then write lock. Writes after a claim wait for the write
 * lock (an import holds it for its own duration only); waiting never counts as an
 * attempt. Nothing here logs; results carry static codes only.
 */
import { configureWriterConnection, type DbClient, type WriterDb } from "../../db/client";
import { sanitizeDbError, type DbErrorCode } from "../../db/errors";
import { isWriterUnusable, runWriterTransaction } from "../../db/transaction-recovery";
import { acquireIndexerLock, acquireWriteLock, type WriteLock } from "../../db/write-lock";
import type { Chunk, MessageInput } from "../chunker.ts";
import { EmbeddingError, type EmbeddingErrorCode } from "../errors.ts";
import { LIMITS } from "../protocol.ts";
import { onProcessExit, refundClaimSync } from "./exit-refund.ts";
import { quantizedByteLength, quantizeInt8 } from "../quantize.ts";
import {
  CODE_INDEX_CONFIG,
  MAX_ATTEMPTS,
  MAX_CHUNKS_PER_CONVERSATION,
  PAGE_MAX_CHARS,
  PAGE_MAX_MESSAGES,
  WINDOW_CHUNKS,
  WRITE_LOCK_RETRY_MS,
  type IndexConfig,
} from "./config.ts";
import {
  claimNext,
  commitClaim,
  listEligibleMessages,
  readPage,
  reconcile,
  releaseClaim,
  setRunError,
  validChunkRows,
  type ChunkRow,
  type Claim,
  type ClaimOutcome,
  type EligibleMessage,
  type ReconcileResult,
  type Sql,
} from "./store.ts";

/** What the indexer needs from an embedder. `Embedder` (worker thread) implements it; M5.1b-2 adds the server host. */
export interface IndexEmbedder {
  readonly info: { readonly dimensions: number; readonly embeddingVersion: string; readonly chunkerVersion: string };
  chunk(messages: readonly MessageInput[]): Promise<Chunk[]>;
  embedPassages(texts: readonly string[], opts?: { signal?: AbortSignal }): Promise<Float32Array[]>;
  /** Drains the in-flight batch and releases the model; never terminates inference. */
  close(): Promise<void>;
}

/** Test-only seams (fault injection, crash points, timing). Production callers never pass them. */
export type IndexerHooks = {
  afterReconcile?: (r: ReconcileResult) => void | Promise<void>;
  /** Inside T1, after the claim (crash point "inside T1"). */
  inClaim?: (claim: Claim) => void | Promise<void>;
  afterClaim?: (claim: Claim) => void | Promise<void>;
  beforePage?: (claim: Claim, page: number) => void | Promise<void>;
  afterWindow?: (claim: Claim, window: number) => void | Promise<void>;
  /** After inference for a claim ended (any outcome), before the outcome is recorded. */
  afterInference?: (claim: Claim, outcome: "commit" | "stale" | "too-large" | "paused" | "error") => void | Promise<void>;
  /** After inference, before T2 takes the write lock. */
  beforeCommit?: (claim: Claim) => void | Promise<void>;
  /** Inside T2, after the inserts (crash point "inside T2"). */
  inCommit?: (claim: Claim) => void | Promise<void>;
  afterCommit?: (claim: Claim, outcome: "committed" | "stale") => void | Promise<void>;
  onWriteLockBusy?: () => void;
};

/** What this process's indexer is doing (for the status, §5.8). */
export type LiveIndexerState = "running" | "waiting-for-import" | "pausing";

export type IndexerDeps = {
  /** The writer connection; used only while holding the write lock. */
  readonly writer: WriterDb;
  /** A reader connection for page reads (never the writer: an import may have a transaction open on it). */
  readonly reader: DbClient;
  readonly openEmbedder: () => Promise<IndexEmbedder>;
  /** Abort to pause. */
  readonly signal?: AbortSignal;
  readonly onState?: (s: LiveIndexerState) => void;
  readonly hooks?: IndexerHooks;
  /** Test-only: shorter wait for a busy write lock. */
  readonly writeLockRetryMs?: number;
  /**
   * Test-only: how the normal-exit refund is registered (default: a `process` `exit`
   * listener, `onProcessExit`). Returns the removal.
   */
  readonly registerExitHandler?: (handler: () => void) => () => void;
};

export type IndexerRunCode =
  | EmbeddingErrorCode
  | DbErrorCode
  | "INDEX_CONFIG_MISMATCH"
  | "INDEXER_BUSY"
  | "INDEXER_LOCK_FAILED"
  | "WRITE_LOCK_FAILED";

export type IndexerStats = {
  claimed: number;
  indexed: number;
  /** Chunks committed in this run. */
  chunks: number;
  /** Conversations that became `failed` in this run (including too large). */
  failed: number;
  tooLarge: number;
  /** Recoverable failures that went back to `pending`. */
  retried: number;
  /** Claims discarded because the conversation changed or was deleted (I4, pages). */
  staleDiscards: number;
  /** Longest write-lock hold of a T2 commit, in ms. */
  maxCommitMs: number;
  reconcile: ReconcileResult | null;
};

export type IndexerResult =
  | { status: "finished"; stats: IndexerStats }
  | { status: "paused"; stats: IndexerStats }
  | { status: "stopped"; code: IndexerRunCode; stats: IndexerStats }
  | { status: "not-started"; code: IndexerRunCode };

const T_OPTIONS = { maxWait: 10_000, timeout: 120_000 } as const;
const ABORTED = Symbol("aborted");

class RunLevelError extends Error {
  constructor(readonly code: IndexerRunCode) {
    super("indexing stopped");
  }
}

export type Page = { readonly from: number; readonly to: number; readonly messages: readonly EligibleMessage[] };

/** Pages at message boundaries: at most `PAGE_MAX_MESSAGES` messages and `PAGE_MAX_CHARS` characters. */
export function planPages(messages: readonly EligibleMessage[]): Page[] {
  const pages: Page[] = [];
  let cur: EligibleMessage[] = [];
  let chars = 0;
  const flush = () => {
    if (cur.length > 0) pages.push({ from: cur[0]!.pathIndex, to: cur[cur.length - 1]!.pathIndex, messages: cur });
    cur = [];
    chars = 0;
  };
  for (const m of messages) {
    if (cur.length >= PAGE_MAX_MESSAGES || (cur.length > 0 && chars + m.chars > PAGE_MAX_CHARS)) flush();
    cur.push(m);
    chars += m.chars;
  }
  flush();
  return pages;
}

type Work =
  | { kind: "commit"; chunks: ChunkRow[] }
  | { kind: "stale" }
  | { kind: "too-large" }
  | { kind: "paused" }
  | { kind: "error"; error: unknown };

function emptyStats(): IndexerStats {
  return { claimed: 0, indexed: 0, chunks: 0, failed: 0, tooLarge: 0, retried: 0, staleDiscards: 0, maxCommitMs: 0, reconcile: null };
}

function workerConfig(info: IndexEmbedder["info"], code: IndexConfig): IndexConfig {
  return { ...code, embeddingVersion: info.embeddingVersion, chunkerVersion: info.chunkerVersion, dimensions: info.dimensions };
}

/** The claim a normal process exit may refund (null once a failure that keeps the attempt was observed). */
type ExitClaim = { claim: Claim | null };

/** Failures that consume the attempt (§5.6): never refunded at exit, even before they are recorded. */
function keepsAttempt(e: unknown): boolean {
  return e instanceof EmbeddingError && (e.code === "WORKER_FAILED" || e.code === "INFERENCE_FAILED" || e.code === "INVALID_INPUT");
}

export async function runIndexer(deps: IndexerDeps): Promise<IndexerResult> {
  const config = CODE_INDEX_CONFIG;
  // The indexer lock first (M5.1b-2): a second process is refused before it starts an
  // inference process or loads the model. The lock order is unchanged: indexer lock, then
  // write lock.
  const l = await acquireIndexerLock(deps.writer.dbPath);
  if (!l.ok) return { status: "not-started", code: l.code };
  const lock: WriteLock = l.lock;
  // A normal process exit during inference refunds the claimed row's attempt (exit-refund.ts).
  const exit: ExitClaim = { claim: null };
  const unregister = (deps.registerExitHandler ?? onProcessExit)(() => {
    if (exit.claim) refundClaimSync(deps.writer.dbPath, exit.claim);
  });
  try {
    let embedder: IndexEmbedder;
    try {
      embedder = await deps.openEmbedder();
    } catch (e) {
      return { status: "not-started", code: e instanceof EmbeddingError ? e.code : "WORKER_FAILED" };
    }
    try {
      const worker = workerConfig(embedder.info, config);
      if (worker.embeddingVersion !== config.embeddingVersion || worker.chunkerVersion !== config.chunkerVersion || worker.dimensions !== config.dimensions) {
        return { status: "not-started", code: "INDEX_CONFIG_MISMATCH" };
      }
      return await session(deps, embedder, config, worker, exit);
    } finally {
      // Drain first (never terminate mid-batch), then let another process index.
      await embedder.close().catch(() => {});
    }
  } finally {
    exit.claim = null;
    unregister();
    lock.release();
  }
}

async function session(
  deps: IndexerDeps,
  embedder: IndexEmbedder,
  config: IndexConfig,
  worker: IndexConfig,
  exit: ExitClaim,
): Promise<IndexerResult> {
  const { writer, reader, signal, hooks } = deps;
  const retryMs = deps.writeLockRetryMs ?? WRITE_LOCK_RETRY_MS;
  const stats = emptyStats();
  const setState = (s: LiveIndexerState) => deps.onState?.(signal?.aborted ? "pausing" : s);
  let holdMs = 0;

  /** One transaction under the write lock; waits while it is busy (abortable only when nothing is claimed). */
  async function writeTx<T>(fn: (tx: Sql) => Promise<T>, abortable: boolean): Promise<T | typeof ABORTED> {
    for (;;) {
      if (isWriterUnusable(writer.db)) throw new RunLevelError("DB_WRITER_UNUSABLE");
      if (abortable && signal?.aborted) return ABORTED;
      const r = await acquireWriteLock(writer.dbPath);
      if (r.ok) {
        const t0 = performance.now();
        try {
          await configureWriterConnection(writer.db);
          return await runWriterTransaction(writer.db, (tx) => fn(tx), T_OPTIONS);
        } finally {
          r.lock.release();
          holdMs = performance.now() - t0;
        }
      }
      if (r.code !== "IMPORT_BUSY") throw new RunLevelError("WRITE_LOCK_FAILED");
      setState("waiting-for-import");
      hooks?.onWriteLockBusy?.();
      await sleep(retryMs, abortable ? signal : undefined);
      setState("running");
    }
  }

  /** Applies an outcome to the claimed row (guarded by its token). */
  const release = (claim: Claim, outcome: ClaimOutcome, code: string | null) =>
    writeTx((tx) => releaseClaim(tx, claim, outcome, code), false);

  /** Run-level stop: refund (or keep) the attempt and record the code, best effort. */
  async function stop(code: IndexerRunCode, claim: Claim | null, outcome: ClaimOutcome = "refund"): Promise<IndexerResult> {
    try {
      await writeTx(async (tx) => {
        if (claim) await releaseClaim(tx, claim, outcome, code);
        await setRunError(tx, code);
      }, false);
    } catch {
      // The database itself failed: the row stays `running`, is shown as interrupted and
      // is reset at the next Start (I5).
    }
    return { status: "stopped", code, stats };
  }

  setState("running");
  let claim: Claim | null = null;
  try {
    const rec = await writeTx((tx) => reconcile(tx, config), true);
    if (rec === ABORTED) return { status: "paused", stats };
    stats.reconcile = rec;
    await hooks?.afterReconcile?.(rec);

    for (;;) {
      claim = null;
      exit.claim = null;
      if (signal?.aborted) return { status: "paused", stats };
      const t1 = await writeTx(async (tx) => {
        const c = await claimNext(tx);
        if (!c) return null;
        const messages = await listEligibleMessages(tx, c.conversationId);
        await hooks?.inClaim?.(c);
        return { claim: c, messages };
      }, true);
      if (t1 === ABORTED) return { status: "paused", stats };
      if (t1 === null) return { status: "finished", stats };
      claim = t1.claim;
      exit.claim = claim;
      stats.claimed++;
      await hooks?.afterClaim?.(claim);

      const work = await embedClaim(claim, t1.messages);
      // From here a child crash, a request timeout or an inference failure counts, even if
      // the process exits before the outcome is recorded below.
      if (work.kind === "error" && keepsAttempt(work.error)) exit.claim = null;
      await hooks?.afterInference?.(claim, work.kind);
      if (work.kind === "commit" && signal?.aborted) {
        await release(claim, "refund", null);
        return { status: "paused", stats };
      }
      switch (work.kind) {
        case "commit": {
          await hooks?.beforeCommit?.(claim);
          const c = claim;
          const outcome = await writeTx(async (tx) => {
            const r = await commitClaim(tx, c, work.chunks, worker);
            if (r === "committed") await hooks?.inCommit?.(c);
            return r;
          }, false);
          if (outcome === ABORTED) throw new Error("unreachable");
          stats.maxCommitMs = Math.max(stats.maxCommitMs, Math.round(holdMs));
          if (outcome === "committed") {
            stats.indexed++;
            stats.chunks += work.chunks.length;
          } else {
            stats.staleDiscards++;
          }
          await hooks?.afterCommit?.(claim, outcome);
          break;
        }
        case "stale":
          // A re-import already requeued the row (or delete-all removed it): no attempt counted.
          await release(claim, "refund", null);
          stats.staleDiscards++;
          break;
        case "too-large":
          await release(claim, "permanent", "CONVERSATION_TOO_LARGE");
          stats.failed++;
          stats.tooLarge++;
          break;
        case "paused":
          await release(claim, "refund", null);
          return { status: "paused", stats };
        case "error": {
          const e = work.error;
          if (e instanceof EmbeddingError) {
            if (e.code === "CANCELLED") {
              await release(claim, "refund", null);
              return { status: "paused", stats };
            }
            if (e.code === "INFERENCE_FAILED" || e.code === "INVALID_INPUT") {
              const permanent = e.code === "INVALID_INPUT";
              await release(claim, permanent ? "permanent" : "recoverable", e.code);
              if (permanent || claim.attempts >= MAX_ATTEMPTS) stats.failed++;
              else stats.retried++;
              break;
            }
            if (e.code === "WORKER_FAILED") return stop("WORKER_FAILED", claim, "worker-crash");
            // Model, runtime, configuration or a closed embedder: run-level, the attempt is refunded.
            return stop(e.code, claim);
          }
          if (e instanceof RunLevelError) return stop(e.code, claim);
          return stop(sanitizeDbError(e), claim);
        }
      }
    }
  } catch (e) {
    return stop(e instanceof RunLevelError ? e.code : sanitizeDbError(e), claim);
  }

  /** Inference for one claim (no lock, no transaction). */
  async function embedClaim(claim: Claim, messages: readonly EligibleMessage[]): Promise<Work> {
    try {
      // A message over the worker's input limit can never be embedded (characters ≤ UTF-16 units).
      if (messages.some((m) => m.chars > LIMITS.maxTextLength)) return { kind: "too-large" };
      const pages = planPages(messages);
      const out: ChunkRow[] = [];
      let window = 0;
      for (let p = 0; p < pages.length; p++) {
        if (signal?.aborted) return { kind: "paused" };
        await hooks?.beforePage?.(claim, p);
        const page = pages[p]!;
        const rows = await readPage(reader, claim, page.from, page.to);
        if (!rows || rows.length !== page.messages.length || rows.some((r, i) => r.sourceNodeId !== page.messages[i]!.sourceNodeId)) {
          return { kind: "stale" };
        }
        if (rows.some((r) => r.text.length > LIMITS.maxTextLength)) return { kind: "too-large" };
        const chunks = await embedder.chunk(rows.map((r) => ({ sourceNodeId: r.sourceNodeId, text: r.text })));
        if (out.length + chunks.length > MAX_CHUNKS_PER_CONVERSATION) return { kind: "too-large" };
        // The worker's reply must describe exact substrings of the text just read (chunker.ts).
        const texts = new Map(rows.map((r) => [r.sourceNodeId, r.text]));
        if (!chunks.every((c) => exactSubstring(texts.get(c.sourceNodeId), c))) throw new EmbeddingError("INFERENCE_FAILED");
        for (let w = 0; w < chunks.length; w += WINDOW_CHUNKS) {
          const win = chunks.slice(w, w + WINDOW_CHUNKS);
          const vectors = await embedder.embedPassages(win.map((c) => c.text), { signal });
          if (vectors.length !== win.length) throw new EmbeddingError("INFERENCE_FAILED");
          win.forEach((c, i) => {
            const v = vectors[i]!;
            if (v.length !== config.dimensions) throw new EmbeddingError("INFERENCE_FAILED");
            let q: Uint8Array;
            try {
              q = quantizeInt8(v);
            } catch {
              throw new EmbeddingError("INFERENCE_FAILED"); // a non-finite value
            }
            out.push({ sourceNodeId: c.sourceNodeId, chunkIndex: c.chunkIndex, start: c.start, end: c.end, tokenCount: c.tokenCount, chunkKey: c.id, vector: q });
          });
          await hooks?.afterWindow?.(claim, window++);
        }
      }
      if (!validChunkRows(out, quantizedByteLength(config.dimensions))) throw new EmbeddingError("INFERENCE_FAILED");
      return { kind: "commit", chunks: out };
    } catch (error) {
      return { kind: "error", error };
    }
  }
}

function exactSubstring(text: string | undefined, c: Chunk): boolean {
  return (
    text !== undefined &&
    Number.isSafeInteger(c.start) &&
    Number.isSafeInteger(c.end) &&
    c.start >= 0 &&
    c.start < c.end &&
    c.end <= text.length &&
    typeof c.text === "string" &&
    text.slice(c.start, c.end) === c.text
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
