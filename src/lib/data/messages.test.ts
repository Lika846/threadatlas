import { describe, expect, it } from "vitest";
import { DB_ERROR_DEFINITIONS } from "../db/errors";
import type { CleanupResult, DeleteAllResult } from "./delete-all";
import { cleanupResultState, deleteResultState, deletedSummary } from "./messages";

const deleted = { conversations: 2, messages: 1, imports: 1 };

describe("deleteResultState", () => {
  it("reports full success only for a verified cleanup", () => {
    const s = deleteResultState({ status: "complete", deleted, writerSettingsRestored: true }, 1);
    expect(s).toMatchObject({ outcome: "complete", tone: "success", code: null, seq: 1 });
    expect(s.message).toBe("All imported data was deleted: 2 conversations, 1 message and 1 import record. Storage cleanup finished and its checks passed.");
  });

  it.each(["CLEANUP_DB_BUSY", "CLEANUP_FAILED", "CLEANUP_UNVERIFIED"] as const)("separates deletion from an incomplete cleanup (%s)", (code) => {
    const s = deleteResultState({ status: "deleted_cleanup_incomplete", deleted, code, writerSettingsRestored: true }, 2);
    expect(s).toMatchObject({ outcome: "deleted_cleanup_incomplete", tone: "warning", code });
    expect(s.message).toMatch(/^All imported data was deleted: .*Storage cleanup is incomplete or unverified/);
    expect(s.message).toMatch(/Finish storage cleanup/);
    expect(s.message).not.toMatch(/finished/);
  });

  it.each(["WRITE_BUSY", "WRITE_LOCK_FAILED", "WRITER_SETTINGS_UNAVAILABLE", ...Object.keys(DB_ERROR_DEFINITIONS)])("says nothing was deleted (%s)", (code) => {
    const s = deleteResultState({ status: "not_deleted", code, writerSettingsRestored: true } as DeleteAllResult, 3);
    expect(s).toMatchObject({ outcome: "not_deleted", tone: "error", code });
    expect(s.message).toMatch(/^Nothing was deleted\. \S/);
  });

  it("adds a note when the writer settings could not be restored, without changing the outcome", () => {
    const s = deleteResultState({ status: "complete", deleted, writerSettingsRestored: false }, 4);
    expect(s.outcome).toBe("complete");
    expect(s.message).toMatch(/could not be reset afterwards/);
  });
});

describe("cleanupResultState", () => {
  it("never mentions deleting records, and reports success only when complete", () => {
    const results: CleanupResult[] = [
      { status: "complete", writerSettingsRestored: true },
      { status: "incomplete", code: "CLEANUP_UNVERIFIED", writerSettingsRestored: true },
      { status: "not_run", code: "IMPORTED_DATA_PRESENT", writerSettingsRestored: true },
      { status: "not_run", code: "WRITE_BUSY", writerSettingsRestored: true },
    ];
    const states = results.map((r, i) => cleanupResultState(r, i));
    expect(states.map((s) => s.tone)).toEqual(["success", "warning", "error", "error"]);
    expect(states[0]!.message).toBe("Storage cleanup finished and its checks passed. No records were deleted.");
    expect(states[1]!.message).toMatch(/No records were deleted/);
    expect(states[2]!.message).toMatch(/^Storage cleanup did not run\. Imported data exists again/);
  });
});

describe("deletedSummary", () => {
  it("pluralises and groups digits", () => {
    expect(deletedSummary({ conversations: 1, messages: 12_345, imports: 0 })).toBe("1 conversation, 12,345 messages and 0 import records");
  });
});
