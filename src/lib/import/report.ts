import { ISSUE_DEFINITIONS, issueSeverity, type IssueCode } from "./errors";
import type { ImportIssue } from "./types";

/**
 * The bounded, content-free warnings report stored in
 * `ImportBatch.warningsJson` (D44, D51, A39, A45).
 *
 *   { "v": 1,
 *     "complete": false while the import is running or if it stopped early,
 *     "accountedConversations": conversations with a durably recorded outcome,
 *     "counts": { "<code>": exact count, ... }   (keys sorted, never truncated)
 *     "samples": [ issue | { "code", "oversized": true }, ... ]  (pipeline order)
 *     "truncated": true if any sample was left out,
 *     "samplesOmitted": number left out }
 *
 * Rules: at most 500 samples; a sample over 1 KiB serialised becomes
 * `{code, oversized: true}`; sampling stops before the serialised report
 * would exceed 128 KiB. The envelope's maximum size is reserved up front
 * (every known code at the largest possible count), so the limit holds
 * whatever is counted later. Samples carry codes, positions, field names and
 * source identifiers only, never imported content. Identifiers may appear here
 * because the report is a local diagnostic; they never appear in error
 * messages or logs (refinement D).
 */

export const REPORT_VERSION = 1;
export const REPORT_MAX_BYTES = 128 * 1024;
export const REPORT_MAX_SAMPLES = 500;
export const SAMPLE_MAX_BYTES = 1024;

export type ReportSample =
  | {
      code: IssueCode;
      index?: number;
      sourceId?: string;
      field?: string;
      nodeId?: string;
      relatedNodeId?: string;
      errorCode?: string;
      duplicateGroup?: ImportIssue["duplicateGroup"];
    }
  | { code: IssueCode; oversized: true };

export type ImportReport = {
  v: typeof REPORT_VERSION;
  complete: boolean;
  accountedConversations: number;
  counts: Partial<Record<IssueCode, number>>;
  samples: ReportSample[];
  truncated: boolean;
  samplesOmitted: number;
};

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** Fixed key order, undefined fields dropped: identical issues serialise identically. */
function toSample(issue: ImportIssue): ReportSample {
  const s: Record<string, unknown> = { code: issue.code };
  if (issue.index !== undefined) s.index = issue.index;
  if (issue.sourceId !== undefined) s.sourceId = issue.sourceId;
  if (issue.field !== undefined) s.field = issue.field;
  if (issue.nodeId !== undefined) s.nodeId = issue.nodeId;
  if (issue.relatedNodeId !== undefined) s.relatedNodeId = issue.relatedNodeId;
  if (issue.errorCode !== undefined) s.errorCode = issue.errorCode;
  if (issue.duplicateGroup !== undefined) {
    const g = issue.duplicateGroup;
    s.duplicateGroup = {
      occurrences: g.occurrences,
      sampleIndices: [...g.sampleIndices],
      truncated: g.truncated,
      ...(g.keptIndex === undefined ? {} : { keptIndex: g.keptIndex }),
    };
  }
  return s as ReportSample;
}

function serialise(r: ImportReport): string {
  const counts: Record<string, number> = {};
  for (const code of Object.keys(r.counts).sort()) counts[code] = r.counts[code as IssueCode]!;
  return JSON.stringify({
    v: r.v,
    complete: r.complete,
    accountedConversations: r.accountedConversations,
    counts,
    samples: r.samples,
    truncated: r.truncated,
    samplesOmitted: r.samplesOmitted,
  });
}

/** Largest possible envelope: every known code at the largest count. */
export const ENVELOPE_MAX_BYTES = (() => {
  const big = Number.MAX_SAFE_INTEGER;
  const counts: Partial<Record<IssueCode, number>> = {};
  for (const code of Object.keys(ISSUE_DEFINITIONS) as IssueCode[]) counts[code] = big;
  return bytes(
    serialise({ v: REPORT_VERSION, complete: false, accountedConversations: big, counts, samples: [], truncated: false, samplesOmitted: big }),
  );
})();

const SAMPLE_BUDGET = REPORT_MAX_BYTES - ENVELOPE_MAX_BYTES;

/** Incremental: issues can be added one at a time across a whole import. */
export class ReportBuilder {
  private readonly counts = new Map<IssueCode, number>();
  private readonly samples: ReportSample[] = [];
  private sampleBytes = 0;
  private sampling = true;
  private omitted = 0;
  private notable = false;

  add(issue: ImportIssue): void {
    this.counts.set(issue.code, (this.counts.get(issue.code) ?? 0) + 1);
    if (issueSeverity(issue.code) !== "info") this.notable = true;
    if (!this.sampling || this.samples.length >= REPORT_MAX_SAMPLES) {
      this.omitted++;
      return;
    }
    let sample = toSample(issue);
    let size = bytes(JSON.stringify(sample));
    if (size > SAMPLE_MAX_BYTES) {
      sample = { code: issue.code, oversized: true };
      size = bytes(JSON.stringify(sample));
    }
    const added = size + (this.samples.length > 0 ? 1 : 0); // separating comma
    if (this.sampleBytes + added > SAMPLE_BUDGET) {
      // Deterministic: once the byte budget is reached, no later sample is kept.
      this.sampling = false;
      this.omitted++;
      return;
    }
    this.samples.push(sample);
    this.sampleBytes += added;
  }

  addAll(issues: readonly ImportIssue[]): void {
    for (const issue of issues) this.add(issue);
  }

  count(code: IssueCode): number {
    return this.counts.get(code) ?? 0;
  }

  /** True if any issue other than an "info" note was recorded. */
  hasWarnings(): boolean {
    return this.notable;
  }

  build(opts: { complete: boolean; accountedConversations: number }): ImportReport {
    return {
      v: REPORT_VERSION,
      complete: opts.complete,
      accountedConversations: opts.accountedConversations,
      counts: Object.fromEntries(this.counts) as Partial<Record<IssueCode, number>>,
      samples: [...this.samples],
      truncated: this.omitted > 0,
      samplesOmitted: this.omitted,
    };
  }

  toJson(opts: { complete: boolean; accountedConversations: number }): string {
    return serialise(this.build(opts));
  }
}
