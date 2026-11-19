import { dbErrorMessage, DB_ERROR_DEFINITIONS, type DbErrorCode } from "../db/errors";
import { IMPORT_ERROR_DEFINITIONS } from "../import/errors";
import type { CleanupCode, CleanupResult, DataCounts, DeleteAllResult } from "./delete-all";
import { DELETE_CONFIRMATION_PHRASE } from "./confirmation";

/**
 * Fixed, content-free messages for the Settings actions (M1.7). Logical
 * deletion and storage cleanup are always reported separately, and "finished"
 * is said only for a verified cleanup (A78, A80).
 */

export type SettingsActionState = {
  /** What happened, for the UI and tests. */
  outcome: "complete" | "deleted_cleanup_incomplete" | "not_deleted" | "cleanup_complete" | "cleanup_incomplete" | "cleanup_not_run" | "rejected";
  tone: "success" | "warning" | "error";
  message: string;
  /** A fixed code (never a message from an error object), or null on success. */
  code: string | null;
  /** Distinguishes repeated identical results, so the UI can move focus again. */
  seq: number;
} | null;

export const REQUEST_REJECTED_MESSAGE = "Nothing was changed: the request did not come from this app's own Settings page.";
export const CONFIRMATION_REQUIRED_MESSAGE = `Nothing was deleted. Type ${DELETE_CONFIRMATION_PHRASE} in capital letters to confirm.`;
export const INTERNAL_ERROR_MESSAGE = "The result is unknown: an unexpected internal error occurred. Reload the page to see the current state.";
const NOT_RESTORED =
  " The database connection settings could not be reset afterwards; they are reset again before the next import.";

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

export function deletedSummary(c: DataCounts): string {
  return `${plural(c.conversations, "conversation", "conversations")}, ${plural(c.messages, "message", "messages")} and ${plural(c.imports, "import record", "import records")}`;
}

const CLEANUP_REASONS: Record<CleanupCode, string> = {
  CLEANUP_DB_BUSY: "another program kept the database busy for more than 5 seconds",
  CLEANUP_FAILED: "the database could not be compacted",
  CLEANUP_UNVERIFIED: "the checks after compaction did not pass",
};

const isDbCode = (code: string): code is DbErrorCode => Object.hasOwn(DB_ERROR_DEFINITIONS, code);

function stopReason(code: string): string {
  switch (code) {
    case "WRITE_BUSY":
      return IMPORT_ERROR_DEFINITIONS.IMPORT_BUSY.message;
    case "WRITE_LOCK_FAILED":
      return "The write lock could not be acquired safely.";
    case "WRITER_SETTINGS_UNAVAILABLE":
      return "SQLite did not confirm the secure-deletion settings.";
    case "IMPORTED_DATA_PRESENT":
      return "Imported data exists again, and cleanup only runs when there is none. Use Delete all imported data to remove it.";
    default:
      return isDbCode(code) ? dbErrorMessage(code) : "An unexpected internal error occurred.";
  }
}

export function deleteResultState(r: DeleteAllResult, seq: number): NonNullable<SettingsActionState> {
  const tail = r.writerSettingsRestored ? "" : NOT_RESTORED;
  switch (r.status) {
    case "complete":
      return {
        outcome: "complete",
        tone: "success",
        code: null,
        seq,
        message: `All imported data was deleted: ${deletedSummary(r.deleted)}. Storage cleanup finished and its checks passed.${tail}`,
      };
    case "deleted_cleanup_incomplete":
      return {
        outcome: "deleted_cleanup_incomplete",
        tone: "warning",
        code: r.code,
        seq,
        message: `All imported data was deleted: ${deletedSummary(r.deleted)}. Storage cleanup is incomplete or unverified (${CLEANUP_REASONS[r.code]}), so deleted text may remain in the database files. Use Finish storage cleanup to try again.${tail}`,
      };
    case "not_deleted":
      return { outcome: "not_deleted", tone: "error", code: r.code, seq, message: `Nothing was deleted. ${stopReason(r.code)}${tail}` };
  }
}

export function cleanupResultState(r: CleanupResult, seq: number): NonNullable<SettingsActionState> {
  const tail = r.writerSettingsRestored ? "" : NOT_RESTORED;
  switch (r.status) {
    case "complete":
      return { outcome: "cleanup_complete", tone: "success", code: null, seq, message: `Storage cleanup finished and its checks passed. No records were deleted.${tail}` };
    case "incomplete":
      return {
        outcome: "cleanup_incomplete",
        tone: "warning",
        code: r.code,
        seq,
        message: `Storage cleanup is incomplete or unverified (${CLEANUP_REASONS[r.code]}). No records were deleted. Try again.${tail}`,
      };
    case "not_run":
      return { outcome: "cleanup_not_run", tone: "error", code: r.code, seq, message: `Storage cleanup did not run. ${stopReason(r.code)}${tail}` };
  }
}
