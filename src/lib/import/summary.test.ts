import { describe, expect, it } from "vitest";
import { DB_ERROR_DEFINITIONS } from "../db/errors";
import { IMPORT_ERROR_DEFINITIONS, ISSUE_DEFINITIONS } from "./errors";
import { ReportBuilder } from "./report";
import { batchSummary, codeMessage, errorBody, REQUEST_ERROR_DEFINITIONS, type BatchRow } from "./summary";

const T = new Date("2026-11-05T12:00:00.000Z");
const row = (over: Partial<BatchRow> = {}): BatchRow => ({
  id: "b1", status: "succeeded", errorCode: null, startedAt: T, finishedAt: T,
  conversationsSeen: 3, conversationsAdded: 3, conversationsUpdated: 0, conversationsUnchanged: 0,
  conversationsOlder: 0, conversationsFlagged: 0, conversationsSkipped: 0, warningsJson: null, ...over,
});
const report = (issues: Parameters<ReportBuilder["add"]>[0][], complete = true) => {
  const r = new ReportBuilder();
  r.addAll(issues);
  return r.toJson({ complete, accountedConversations: 0 });
};

describe("batchSummary", () => {
  it("a completed batch: counts, no accounting text", () => {
    const s = batchSummary(row({ warningsJson: report([]) }));
    expect(s).toMatchObject({ status: "succeeded", complete: true, seen: 3, accounted: 3, notAccounted: 0, accountingText: null, errorCode: null, reportAvailable: true, warnings: [] });
    expect(s.counts).toEqual({ added: 3, updated: 0, unchanged: 0, older: 0, flagged: 0, skipped: 0 });
    expect(s.startedAt).toBe("2026-11-05T12:00:00.000Z");
  });

  it.each(["failed", "interrupted", "running"])("a %s batch shows durable accounting, never completion", (status) => {
    const s = batchSummary(row({ status, errorCode: status === "failed" ? "DB_DISK_FULL" : status === "interrupted" ? "IMPORT_INTERRUPTED" : null, conversationsSeen: 10, conversationsAdded: 4, finishedAt: status === "running" ? null : T }));
    expect(s).toMatchObject({ complete: false, accounted: 4, notAccounted: 6, accountingText: "Accounted for 4 of 10; 6 not accounted for." });
    if (status === "failed") expect(s.errorMessage).toBe(DB_ERROR_DEFINITIONS.DB_DISK_FULL.message);
    if (status === "interrupted") expect(s.errorMessage).toBe(IMPORT_ERROR_DEFINITIONS.IMPORT_INTERRUPTED.message);
  });

  it("a failed batch that happens to have every counter is still not complete", () => {
    expect(batchSummary(row({ status: "failed", errorCode: "DB_CONSTRAINT" })).complete).toBe(false);
  });

  it("groups warnings by code with static messages, most severe first", () => {
    const s = batchSummary(row({
      status: "succeeded_with_warnings",
      warningsJson: report([
        { code: "PATH_FALLBACK", index: 0, sourceId: "a" },
        { code: "PATH_FALLBACK", index: 1, sourceId: "b" },
        { code: "CONVERSATION_REPROCESSED", index: 2, sourceId: "c" },
        { code: "CONVERSATION_PERSIST_FAILED", index: 3, sourceId: "d", errorCode: "DB_CONSTRAINT" },
      ]),
    }));
    expect(s.warnings.map((w) => [w.code, w.count, w.severity])).toEqual([
      ["CONVERSATION_PERSIST_FAILED", 1, "error"],
      ["PATH_FALLBACK", 2, "warning"],
      ["CONVERSATION_REPROCESSED", 1, "info"],
    ]);
    expect(s.warnings[1]!.message).toBe(ISSUE_DEFINITIONS.PATH_FALLBACK.message);
    expect(s.samples).toHaveLength(4);
    expect(s.samples[3]).toEqual({ code: "CONVERSATION_PERSIST_FAILED", index: 3, sourceId: "d", errorCode: "DB_CONSTRAINT" });
  });

  it.each([["not JSON", "{"], ["wrong version", '{"v":2,"counts":{},"samples":[]}'], ["missing", null]])("an unreadable report (%s) leaves counts intact", (_l, json) => {
    const s = batchSummary(row({ warningsJson: json }));
    expect(s).toMatchObject({ reportAvailable: false, warnings: [], samples: [], accounted: 3 });
  });

  it("drops unknown codes from a stored report instead of inventing messages", () => {
    const s = batchSummary(row({ warningsJson: '{"v":1,"counts":{"NOT_A_CODE":3,"PATH_NONE":1},"samples":[{"code":"NOT_A_CODE"},{"code":"PATH_NONE","index":0}],"samplesOmitted":0}' }));
    expect(s.warnings.map((w) => w.code)).toEqual(["PATH_NONE"]);
    expect(s.samples).toEqual([{ code: "PATH_NONE", index: 0 }]);
  });

  it("an unrecognised stored status is shown as unknown and incomplete", () => {
    expect(batchSummary(row({ status: "weird" }))).toMatchObject({ status: "unknown", complete: false });
  });
});

describe("codeMessage", () => {
  it("has a static message for every code the route can return", () => {
    for (const code of [...Object.keys(ISSUE_DEFINITIONS), ...Object.keys(IMPORT_ERROR_DEFINITIONS), ...Object.keys(DB_ERROR_DEFINITIONS), ...Object.keys(REQUEST_ERROR_DEFINITIONS)]) {
      expect(codeMessage(code).length, code).toBeGreaterThan(10);
    }
    expect(codeMessage("FILE_INCOMPLETE")).toMatch(/incomplete/);
  });

  it("never echoes an unknown code or prototype keys", () => {
    for (const code of ["<script>", "constructor", "__proto__", "toString"]) {
      expect(codeMessage(code)).toBe(DB_ERROR_DEFINITIONS.IMPORT_INTERNAL_ERROR.message);
    }
    expect(errorBody("IMPORT_BUSY")).toEqual({ ok: false, code: "IMPORT_BUSY", message: IMPORT_ERROR_DEFINITIONS.IMPORT_BUSY.message });
  });
});
