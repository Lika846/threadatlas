import { describe, expect, it } from "vitest";
import { MAX_ID_LENGTH } from "./identifiers";
import {
  ENVELOPE_MAX_BYTES,
  REPORT_MAX_BYTES,
  REPORT_MAX_SAMPLES,
  ReportBuilder,
  SAMPLE_MAX_BYTES,
  type ImportReport,
} from "./report";
import type { ImportIssue } from "./types";

const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const opts = { complete: true, accountedConversations: 0 };

function build(issues: ImportIssue[], o = opts) {
  const r = new ReportBuilder();
  r.addAll(issues);
  const json = r.toJson(o);
  return { r, json, report: JSON.parse(json) as ImportReport };
}

describe("warnings report (D44, D51)", () => {
  it("has the versioned shape, with sorted counts", () => {
    const { report, json } = build([
      { code: "PATH_FALLBACK", index: 0, sourceId: "c-1" },
      { code: "MESSAGE_MALFORMED", index: 0, sourceId: "c-1", nodeId: "n-1" },
    ]);
    expect(Object.keys(report)).toEqual(["v", "complete", "accountedConversations", "counts", "samples", "truncated", "samplesOmitted"]);
    expect(report).toMatchObject({ v: 1, complete: true, truncated: false, samplesOmitted: 0 });
    expect(Object.keys(report.counts)).toEqual(["MESSAGE_MALFORMED", "PATH_FALLBACK"]);
    // Samples stay in pipeline order; only the counts are sorted.
    expect(report.samples.map((x) => x.code)).toEqual(["PATH_FALLBACK", "MESSAGE_MALFORMED"]);
    expect(json.length).toBeGreaterThan(0);
  });

  it("an empty report is small and complete", () => {
    const { report } = build([]);
    expect(report).toEqual({ v: 1, complete: true, accountedConversations: 0, counts: {}, samples: [], truncated: false, samplesOmitted: 0 });
  });

  it("records complete:false and the accounted count for partial reports", () => {
    const { report } = build([], { complete: false, accountedConversations: 17 });
    expect(report).toMatchObject({ complete: false, accountedConversations: 17 });
  });

  it("keeps exact counts with 100,000 issues and at most 500 samples", () => {
    const issues: ImportIssue[] = [];
    for (let i = 0; i < 100_000; i++) issues.push({ code: i % 3 === 0 ? "NODE_ID_MISMATCH" : "PATH_FALLBACK", index: i, sourceId: `c-${i}`, nodeId: `n-${i}` });
    const { report, json } = build(issues);
    expect(report.counts).toEqual({ NODE_ID_MISMATCH: 33_334, PATH_FALLBACK: 66_666 });
    expect(report.samples).toHaveLength(REPORT_MAX_SAMPLES);
    expect(report.samplesOmitted).toBe(100_000 - REPORT_MAX_SAMPLES);
    expect(report.truncated).toBe(true);
    // Samples are the first 500 in pipeline order.
    expect(report.samples.map((s) => ("index" in s ? s.index : -1))).toEqual(Array.from({ length: 500 }, (_, i) => i));
    expect(bytes(json)).toBeLessThanOrEqual(REPORT_MAX_BYTES);
  });

  it("replaces a sample over 1 KiB with {code, oversized:true}", () => {
    const long = "x".repeat(MAX_ID_LENGTH);
    const { report } = build([
      { code: "NODE_CHILD_PARENT_MISMATCH", index: 0, sourceId: long, nodeId: long, relatedNodeId: long },
      { code: "PATH_FALLBACK", index: 1, sourceId: "short" },
    ]);
    expect(report.samples[0]).toEqual({ code: "NODE_CHILD_PARENT_MISMATCH", oversized: true });
    expect(report.samples[1]).toEqual({ code: "PATH_FALLBACK", index: 1, sourceId: "short" });
    expect(report.counts.NODE_CHILD_PARENT_MISMATCH).toBe(1);
  });

  it("measures the 1 KiB rule in UTF-8 bytes, not characters", () => {
    // 300 four-byte code points: 300 characters (under 1024) but 1200 bytes.
    const wide = "\u{1F600}".repeat(300);
    const { report } = build([{ code: "PATH_FALLBACK", index: 0, sourceId: wide }]);
    expect(report.samples[0]).toEqual({ code: "PATH_FALLBACK", oversized: true });
  });

  it("keeps a sample of exactly 1 KiB", () => {
    const base = JSON.stringify({ code: "PATH_FALLBACK", index: 0, sourceId: "" });
    const sourceId = "y".repeat(SAMPLE_MAX_BYTES - bytes(base));
    const { report } = build([{ code: "PATH_FALLBACK", index: 0, sourceId }]);
    expect(report.samples[0]).toEqual({ code: "PATH_FALLBACK", index: 0, sourceId });
  });

  it("stops sampling before 128 KiB, deterministically, and never loses counts", () => {
    // Samples just under 1 KiB each: the byte budget is reached before 500.
    const id = "z".repeat(470);
    const issues: ImportIssue[] = Array.from({ length: 400 }, (_, i) => ({ code: "NODE_ID_MISMATCH", index: i, sourceId: id, nodeId: id }));
    const a = build(issues);
    const b = build(issues);
    expect(a.json).toBe(b.json);
    expect(bytes(a.json)).toBeLessThanOrEqual(REPORT_MAX_BYTES);
    expect(a.report.samples.length).toBeLessThan(400);
    expect(a.report.samples.length).toBeGreaterThan(100);
    expect(a.report.samples.length + a.report.samplesOmitted).toBe(400);
    expect(a.report.counts.NODE_ID_MISMATCH).toBe(400);
    // Once full, a later small sample is not squeezed in.
    const r = new ReportBuilder();
    r.addAll(issues);
    r.add({ code: "PATH_FALLBACK", index: 999 });
    const after = r.build(opts);
    expect(after.samples.some((s) => s.code === "PATH_FALLBACK")).toBe(false);
    expect(after.counts.PATH_FALLBACK).toBe(1);
  });

  it("stays within 128 KiB even with every code counted at huge values", () => {
    expect(ENVELOPE_MAX_BYTES).toBeLessThan(8 * 1024);
    const id = "q".repeat(500);
    const r = new ReportBuilder();
    for (let i = 0; i < 5_000; i++) r.add({ code: "NODE_ID_MISMATCH", index: i, sourceId: id, nodeId: id.slice(0, 10) });
    const json = r.toJson({ complete: false, accountedConversations: Number.MAX_SAFE_INTEGER });
    expect(bytes(json)).toBeLessThanOrEqual(REPORT_MAX_BYTES);
  });

  it("serialises samples with a fixed key order, independent of how issues were built", () => {
    const x = build([{ nodeId: "n", sourceId: "s", code: "NODE_ID_MISMATCH", index: 3 } as ImportIssue]).json;
    const y = build([{ code: "NODE_ID_MISMATCH", index: 3, sourceId: "s", nodeId: "n" }]).json;
    expect(x).toBe(y);
  });

  it("includes a persistence failure's sanitised database code, and nothing else about the error", () => {
    const { report } = build([{ code: "CONVERSATION_PERSIST_FAILED", index: 4, sourceId: "c-4", errorCode: "DB_CONSTRAINT" }]);
    expect(report.samples[0]).toEqual({ code: "CONVERSATION_PERSIST_FAILED", index: 4, sourceId: "c-4", errorCode: "DB_CONSTRAINT" });
  });

  it("treats info notes as not notable", () => {
    const r = new ReportBuilder();
    r.add({ code: "CONVERSATION_REPROCESSED", index: 0, sourceId: "c" });
    expect(r.hasWarnings()).toBe(false);
    r.add({ code: "CONVERSATION_OLDER", index: 1, sourceId: "d" });
    expect(r.hasWarnings()).toBe(true);
  });
});
