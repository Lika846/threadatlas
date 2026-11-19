import { configureWriterConnection, getWriterDb, type WriterDb } from "../db/client";
import { isSystemicDbError, sanitizeDbError, type DbErrorCode } from "../db/errors";
import { isWriterUnusable } from "../db/transaction-recovery";
import { acquireWriteLock, IMPORT_LOCK_WAIT_MS } from "../db/write-lock";
import { optimizeSearchIndex } from "../search/fts-index";
import { ADAPTER_VERSION, parseChatGptExport } from "./chatgpt/adapter";
import { normalizeConversation } from "./chatgpt/normalize";
import type { FileErrorCode, ImportErrorCode } from "./errors";
import {
  addCounters,
  batchAccounting,
  checkpointBatch,
  createBatch,
  finalizeBatch,
  markBatchFailed,
  recoverInterruptedBatches,
  sumCounters,
  zeroCounters,
  type ImportStatus,
  type OutcomeCounters,
} from "./persist/batch";
import { outcomeOf, persistConversation, yieldToEventLoop, type ConversationHooks } from "./persist/conversation";
import { parseParserVersion } from "./persist/versions";
import { parseJsonText, readUploadStream } from "./read-upload";
import { ReportBuilder } from "./report";
import type { AdapterResult, ConversationCandidate, ImportIssue } from "./types";

/**
 * M1.4 import service: persists a parsed ChatGPT export (state table in
 * docs/import-format.md, "Persistence").
 *
 *   lock → recover stale batches → create batch → per conversation, in file
 *   order: normalise just in time → one transaction (decide, write, count)
 *   → checkpoints → finalise → release lock
 *
 * Never throws and never logs. Every exception goes through
 * `sanitizeDbError`; results carry codes and counts only.
 */

export type ImportFileMeta = { filename: string; sha256: string; byteLength: number };

export type ImportOutcomeCode = FileErrorCode | ImportErrorCode | DbErrorCode;

export type ImportCounts = OutcomeCounters & { seen: number };

export type ImportOutcome = {
  /** null when nothing was written (file error, busy, lock or configuration failure). */
  batchId: string | null;
  /** The batch's stored status; null without a batch. */
  status: ImportStatus | null;
  errorCode: ImportOutcomeCode | null;
  /** Durably committed counters (what the database says), never in-memory tallies. */
  counts: ImportCounts;
  accounted: number;
  notAccounted: number;
  /** True only if every discovered conversation has a committed outcome. */
  complete: boolean;
  /** Stale `running` batches marked `interrupted` before this import started. */
  recoveredInterrupted: number;
};

export type ImportHooks = ConversationHooks & {
  afterBatchCreated?: (batchId: string) => void | Promise<void>;
  /** After a conversation's outcome is recorded (`durable`: committed now, not just tallied). */
  afterConversation?: (index: number, durable: boolean) => void | Promise<void>;
  afterCheckpoint?: () => void | Promise<void>;
  beforeFinalize?: () => void | Promise<void>;
  /** After the search-index maintenance that follows a replacing import (still under the lock). */
  afterIndexOptimize?: (result: "optimized" | "failed") => void | Promise<void>;
};

export type ImportDeps = {
  /** Injected in tests; the app uses the process-wide writer. */
  writer?: WriterDb;
  now?: () => Date;
  /** Test-only fault-injection seam; production code never passes it. */
  hooks?: ImportHooks;
  /** Checkpoint after this many conversations without a durable write (default 250). */
  checkpointEvery?: number;
  /** ...or after this many milliseconds (default 1000). */
  checkpointIntervalMs?: number;
};

export const CHECKPOINT_EVERY = 250;
export const CHECKPOINT_INTERVAL_MS = 1_000;
export const MAX_FILENAME_LENGTH = 255;

/** Basename only, control and bidi-override characters removed, at most 255 code points. Never logged. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, "").trim();
  const limited = Array.from(clean).slice(0, MAX_FILENAME_LENGTH).join("");
  return limited === "" ? "upload.json" : limited;
}

const emptyCounts = (seen = 0): ImportCounts => ({ seen, ...zeroCounters() });

function noBatch(errorCode: ImportOutcomeCode, recoveredInterrupted = 0, seen = 0): ImportOutcome {
  return { batchId: null, status: null, errorCode, counts: emptyCounts(seen), accounted: 0, notAccounted: seen, complete: false, recoveredInterrupted };
}

/** Reads, parses and imports an upload stream. The upload text is released before persisting. */
export async function importExportStream(
  stream: ReadableStream<Uint8Array> | null,
  opts: { maxBytes: number; declaredLength?: number | null; filename: string },
  deps: ImportDeps = {},
): Promise<ImportOutcome> {
  const prepared = await prepareUpload(stream, opts);
  if (!prepared.ok) return noBatch(prepared.code);
  return importAdapterResult(prepared.result, prepared.file, deps);
}

/**
 * Keeps the upload text and parsed JSON root inside this function, so that
 * only the adapter's accepted candidates outlive it (just-in-time release).
 */
async function prepareUpload(
  stream: ReadableStream<Uint8Array> | null,
  opts: { maxBytes: number; declaredLength?: number | null; filename: string },
): Promise<{ ok: true; result: Extract<AdapterResult, { ok: true }>; file: ImportFileMeta } | { ok: false; code: FileErrorCode }> {
  const read = await readUploadStream(stream, opts);
  if (!read.ok) return { ok: false, code: read.error.code };
  const parsed = parseJsonText(read.text);
  if (!parsed.ok) return { ok: false, code: parsed.error.code };
  const result = parseChatGptExport(parsed.data);
  if (!result.ok) return { ok: false, code: result.error.code };
  return { ok: true, result, file: { filename: opts.filename, sha256: read.sha256, byteLength: read.byteLength } };
}

export async function importAdapterResult(
  result: Extract<AdapterResult, { ok: true }>,
  file: ImportFileMeta,
  deps: ImportDeps = {},
): Promise<ImportOutcome> {
  // The running parser must have a valid version, or nothing can be compared.
  if (!parseParserVersion(ADAPTER_VERSION) || result.adapterVersion !== ADAPTER_VERSION) {
    return noBatch("IMPORT_PARSER_VERSION_INVALID");
  }
  if (result.accepted.length + result.flagged.length + result.skipped.length !== result.conversationsSeen) {
    return noBatch("IMPORT_INTERNAL_ERROR");
  }

  let writer: WriterDb;
  try {
    writer = deps.writer ?? getWriterDb();
  } catch (e) {
    return noBatch(sanitizeDbError(e));
  }

  if (isWriterUnusable(writer.db)) return noBatch("DB_WRITER_UNUSABLE");
  const lock = await acquireWriteLock(writer.dbPath, { waitMs: IMPORT_LOCK_WAIT_MS });
  if (!lock.ok) return noBatch(lock.code);
  try {
    const outcome = await runLocked(writer, result, file, deps);
    await optimizeAfterReplacement(writer.db, outcome, deps.hooks);
    return outcome;
  } catch (e) {
    // runLocked handles its own errors; this is a last line of defence.
    return noBatch(sanitizeDbError(e));
  } finally {
    lock.lock.release();
  }
}

/**
 * Search-index maintenance (M2.1, A88): after an import that durably replaced
 * conversations, merge the index while the write lock is still held. This
 * drops the replaced text's terms from the index and keeps it compact
 * (measured in M2.0: about 0.3 s for 52,000 messages, blocking the event loop
 * that long). Never through an unusable writer. A failure changes nothing: the
 * index stays correct, only unmerged, and the import's outcome is unaffected.
 */
async function optimizeAfterReplacement(db: WriterDb["db"], outcome: ImportOutcome, hooks: ImportHooks | undefined): Promise<void> {
  if (outcome.batchId === null || outcome.counts.updated === 0 || isWriterUnusable(db)) return;
  let result: "optimized" | "failed" = "optimized";
  try {
    await optimizeSearchIndex(db);
  } catch {
    result = "failed";
  }
  await hooks?.afterIndexOptimize?.(result);
}

async function runLocked(
  { db }: WriterDb,
  result: Extract<AdapterResult, { ok: true }>,
  file: ImportFileMeta,
  deps: ImportDeps,
): Promise<ImportOutcome> {
  const now = deps.now ?? (() => new Date());
  const hooks = deps.hooks;
  const checkpointEvery = deps.checkpointEvery ?? CHECKPOINT_EVERY;
  const checkpointIntervalMs = deps.checkpointIntervalMs ?? CHECKPOINT_INTERVAL_MS;
  const seen = result.conversationsSeen;

  // ---- Recovery, under the lock: no other import can be live. -----------
  let recovered: number;
  try {
    await configureWriterConnection(db);
    recovered = await recoverInterruptedBatches(db, now());
  } catch (e) {
    return noBatch(sanitizeDbError(e), 0, seen);
  }

  // ---- Batch row with the adapter's (file-pass) outcomes. ---------------
  const report = new ReportBuilder();
  report.addAll(result.issues);
  const adapterCounters: OutcomeCounters = { ...zeroCounters(), flagged: result.flagged.length, skipped: result.skipped.length };
  let durable = adapterCounters;
  let pending = zeroCounters();
  let batchId: string;
  try {
    batchId = await createBatch(db, {
      adapter: result.adapter,
      adapterVersion: result.adapterVersion,
      sourceFilename: sanitizeFilename(file.filename),
      sourceSha256: file.sha256,
      sourceBytes: file.byteLength,
      conversationsSeen: seen,
      adapterCounters,
      warningsJson: report.toJson({ complete: false, accountedConversations: sumCounters(adapterCounters) }),
      startedAt: now(),
    });
    await hooks?.afterBatchCreated?.(batchId);
  } catch (e) {
    return noBatch(sanitizeDbError(e), recovered, seen);
  }

  const outcome = (status: ImportStatus, errorCode: ImportOutcomeCode | null): ImportOutcome => {
    const counts = { seen, ...durable };
    const a = batchAccounting({
      status,
      conversationsSeen: seen,
      conversationsAdded: durable.added,
      conversationsUpdated: durable.updated,
      conversationsUnchanged: durable.unchanged,
      conversationsOlder: durable.older,
      conversationsFlagged: durable.flagged,
      conversationsSkipped: durable.skipped,
    });
    return { batchId, status, errorCode, counts, accounted: a.accounted, notAccounted: a.notAccounted, complete: a.complete, recoveredInterrupted: recovered };
  };

  // ---- Per conversation. -----------------------------------------------
  let systemic: DbErrorCode | null = null;
  /** The writer could not be shown to be outside a transaction: write nothing more through it. */
  let writerUnusable = false;
  let persistFailures = 0;
  let sinceDurable = 0;
  let lastDurableAt = Date.now();
  // Released one by one as they are processed (the service owns this copy).
  const candidates: (ConversationCandidate | undefined)[] = [...result.accepted];
  const nowMs = now().getTime();

  for (let i = 0; i < candidates.length; i++) {
    // Let other requests run between conversations. Prisma's SQLite adapter
    // settles every query synchronously, so without this the loop would run
    // entirely in microtasks and starve timers and I/O for the whole import
    // (measured in M1.4: 0 timer ticks during a 21 s import).
    await yieldToEventLoop();
    const candidate = candidates[i]!;
    candidates[i] = undefined;
    const issues: ImportIssue[] = [];
    let wroteNow = false;
    try {
      const { conversation, issues: own } = normalizeConversation(candidate, { nowMs });
      issues.push(...own);
      // Normalising a very large conversation is synchronous CPU work (about
      // 0.4 s at 20,000 nodes); yield before its transaction starts too.
      await yieldToEventLoop();
      const r = await persistConversation(db, { batchId, conversation, pending, hooks });
      if (r.wrote) {
        durable = addCounters(durable, addCounters(pending, r.outcome));
        pending = zeroCounters();
        wroteNow = true;
        if (r.decision.kind === "replace" && r.decision.case === 7) {
          issues.push({ code: r.decision.code, index: candidate.index, sourceId: candidate.sourceId });
        }
      } else {
        pending = addCounters(pending, outcomeOf(r.decision));
        const d = r.decision;
        if (d.kind !== "unchanged") {
          issues.push({ code: d.code, index: candidate.index, sourceId: candidate.sourceId, ...("field" in d && d.field ? { field: d.field } : {}) });
        }
      }
    } catch (e) {
      const code = sanitizeDbError(e);
      writerUnusable = isWriterUnusable(db);
      if (writerUnusable || isSystemicDbError(code)) {
        // This conversation stays unaccounted: its transaction rolled back
        // (explicitly, if its COMMIT failed). The original code is reported.
        systemic = code;
        break;
      }
      persistFailures++;
      pending = addCounters(pending, { ...zeroCounters(), skipped: 1 });
      issues.push({ code: "CONVERSATION_PERSIST_FAILED", index: candidate.index, sourceId: candidate.sourceId, errorCode: code });
    }
    report.addAll(issues);
    await hooks?.afterConversation?.(candidate.index, wroteNow);

    if (wroteNow) {
      sinceDurable = 0;
      lastDurableAt = Date.now();
    } else {
      sinceDurable++;
    }
    // Checkpoint: bounds how far the durable counters lag after a crash.
    if (sumCounters(pending) > 0 && (sinceDurable >= checkpointEvery || Date.now() - lastDurableAt >= checkpointIntervalMs)) {
      try {
        const next = addCounters(durable, pending);
        await checkpointBatch(db, batchId, pending, report.toJson({ complete: false, accountedConversations: sumCounters(next) }));
        durable = next;
        pending = zeroCounters();
        sinceDurable = 0;
        lastDurableAt = Date.now();
        await hooks?.afterCheckpoint?.();
      } catch (e) {
        systemic = sanitizeDbError(e);
        break;
      }
    }
  }

  // ---- Finalise. ---------------------------------------------------------
  // Never through an unusable writer: the batch stays `running`, and the next
  // import after a restart marks it `interrupted` (existing recovery).
  if (writerUnusable) return outcome("running", systemic);
  const stoppedEarly = systemic !== null;
  const final = addCounters(durable, pending);
  let status: Exclude<ImportStatus, "running" | "interrupted">;
  if (stoppedEarly) status = "failed";
  else if (persistFailures > 0) status = "completed_with_errors";
  else if (final.skipped + final.flagged + final.older > 0 || report.hasWarnings()) status = "succeeded_with_warnings";
  else status = "succeeded";

  try {
    await hooks?.beforeFinalize?.();
    await finalizeBatch(db, batchId, {
      pending,
      status,
      errorCode: systemic,
      warningsJson: report.toJson({ complete: !stoppedEarly && sumCounters(final) === seen, accountedConversations: sumCounters(final) }),
      finishedAt: now(),
    });
    durable = final;
    pending = zeroCounters();
    return outcome(status, systemic);
  } catch (e) {
    const code = systemic ?? sanitizeDbError(e);
    try {
      await markBatchFailed(db, batchId, code, now());
      return outcome("failed", code);
    } catch {
      // The batch stays `running`; the next import marks it `interrupted`.
      return outcome("running", code);
    }
  }
}
