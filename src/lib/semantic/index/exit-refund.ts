/**
 * Refund of an interrupted claim when the server process exits normally (M5.1b-2 slice 2;
 * owner's condition 2).
 *
 * The attempt is counted at claim (T1). A normal stop or restart of the server (Next.js's
 * default SIGTERM/SIGINT handling, a dev restart) ends in `process.exit`, which runs
 * `exit` listeners synchronously. The indexer registers one for the duration of a run; it
 * calls this function for a claim whose inference was still in progress, and the row goes
 * back to `pending` with its attempt refunded, exactly as a pause would.
 *
 * Synchronous on purpose (an `exit` listener cannot await): a non-blocking try of the
 * write lock, then one guarded UPDATE on a fresh connection with no busy wait. Anything
 * that is not immediately possible (the write lock is held, by an import or by this
 * process's own commit in progress; the database is busy; any error) is skipped and the
 * row stays `running`. Reconcile then resets it at the next Start with the attempt kept:
 * the conservative default, today's rule (I5).
 *
 * A hard death (SIGKILL, a crash, OOM) runs no code, so the attempt is kept. A crash of the
 * inference child, or a request timeout, is observed by the live server and recorded with
 * the attempt kept (`worker-crash`); the indexer stops offering the claim for a refund as
 * soon as it observes such a failure, even if the server then exits before recording it.
 *
 * Never logs. Imports only the write lock and SQLite, so it runs in any Node process.
 */
import Database, { type SqliteDatabase } from "better-sqlite3";
import { tryAcquireWriteLock } from "../../db/write-lock.ts";
import { dbTimestamp, type Claim } from "./store.ts";

export type ExitRefundResult = "refunded" | "not-running" | "busy" | "failed";

const REFUND_SQL = `UPDATE "EmbeddingStatus" SET "state" = 'pending', "claimToken" = NULL, "attempts" = MAX("attempts" - 1, 0), "updatedAt" = ?
  WHERE "conversationId" = ? AND "state" = 'running' AND "claimToken" = ?`;

const busy = (e: unknown) => {
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof code === "string" && (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"));
};

/** Refunds the claim if it is still running with this token. Never throws, never waits. */
export function refundClaimSync(dbPath: string, claim: Pick<Claim, "conversationId" | "token">): ExitRefundResult {
  let lock: { release(): void };
  try {
    const r = tryAcquireWriteLock(dbPath);
    if (!r.ok) return r.code === "IMPORT_BUSY" ? "busy" : "failed";
    lock = r.lock;
  } catch {
    return "failed";
  }
  let db: SqliteDatabase | null = null;
  try {
    db = new Database(dbPath, { fileMustExist: true, timeout: 0 });
    const r = db.prepare(REFUND_SQL).run(dbTimestamp(), claim.conversationId, claim.token);
    return r.changes === 1 ? "refunded" : "not-running";
  } catch (e) {
    return busy(e) ? "busy" : "failed";
  } finally {
    try {
      db?.close();
    } catch {
      // nothing to do while exiting
    }
    lock.release();
  }
}

/** The default registration: a `process` `exit` listener; returns its removal. */
export function onProcessExit(handler: () => void): () => void {
  process.on("exit", handler);
  return () => process.off("exit", handler);
}
