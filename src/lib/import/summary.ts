import { DB_ERROR_DEFINITIONS } from "../db/errors";
import { IMPORT_ERROR_DEFINITIONS, ISSUE_DEFINITIONS, type IssueCode } from "./errors";
import { accountingSummary, batchAccounting, IMPORT_STATUSES, type ImportStatus, type OutcomeCounters } from "./persist/batch";
import { REPORT_VERSION, type ReportSample } from "./report";

/**
 * Client-facing import summaries (M1.5). Built from the **stored** ImportBatch
 * row, so the import response and the last-import panel show the same durable
 * accounting: an interrupted or failed batch shows "Accounted for X of Y; Z not
 * accounted for.", never completion counts.
 *
 * Contains only codes, static messages, counts, positions and source
 * identifiers (bounded local diagnostics, A59). Never imported content, raw
 * errors or file names.
 */

export const REQUEST_ERROR_DEFINITIONS = {
  REQUEST_FORBIDDEN: { message: "This request was refused. Imports must be started from the ThreadAtlas import page." },
  REQUEST_CONTENT_TYPE: { message: "The upload was sent with an unsupported content type." },
  REQUEST_LENGTH_REQUIRED: { message: "The upload did not state its size, so it was refused." },
} as const;

export type RequestErrorCode = keyof typeof REQUEST_ERROR_DEFINITIONS;

/** Static message for any code the import route can return. */
export function codeMessage(code: string): string {
  const tables: Record<string, { message: string }>[] = [ISSUE_DEFINITIONS, IMPORT_ERROR_DEFINITIONS, DB_ERROR_DEFINITIONS, REQUEST_ERROR_DEFINITIONS];
  for (const t of tables) if (Object.hasOwn(t, code)) return t[code]!.message;
  return DB_ERROR_DEFINITIONS.IMPORT_INTERNAL_ERROR.message;
}

export type WarningGroup = { code: string; count: number; severity: "error" | "warning" | "info"; message: string };

export type BatchSummary = {
  batchId: string;
  /** `unknown` only if the stored value is not a recognised status. */
  status: ImportStatus | "unknown";
  /** Every discovered conversation has a durably recorded outcome. */
  complete: boolean;
  seen: number;
  accounted: number;
  notAccounted: number;
  /** Durably recorded outcome counters. */
  counts: OutcomeCounters;
  /** "Accounted for X of Y; Z not accounted for." for incomplete batches, else null. */
  accountingText: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
  warnings: WarningGroup[];
  samples: ReportSample[];
  samplesOmitted: number;
  /** False if the stored report is missing or unreadable. */
  reportAvailable: boolean;
};

export type BatchRow = {
  id: string;
  status: string;
  errorCode: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  conversationsSeen: number;
  conversationsAdded: number;
  conversationsUpdated: number;
  conversationsUnchanged: number;
  conversationsOlder: number;
  conversationsFlagged: number;
  conversationsSkipped: number;
  warningsJson: string | null;
};

/** Columns needed by `batchSummary` (never `sourceFilename` or hashes). */
export const BATCH_SUMMARY_SELECT = {
  id: true,
  status: true,
  errorCode: true,
  startedAt: true,
  finishedAt: true,
  conversationsSeen: true,
  conversationsAdded: true,
  conversationsUpdated: true,
  conversationsUnchanged: true,
  conversationsOlder: true,
  conversationsFlagged: true,
  conversationsSkipped: true,
  warningsJson: true,
} as const;

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

function parseReport(json: string | null): { warnings: WarningGroup[]; samples: ReportSample[]; samplesOmitted: number } | null {
  if (json === null) return null;
  try {
    const r = JSON.parse(json) as { v?: unknown; counts?: unknown; samples?: unknown; samplesOmitted?: unknown };
    if (r.v !== REPORT_VERSION || typeof r.counts !== "object" || r.counts === null || !Array.isArray(r.samples)) return null;
    const warnings: WarningGroup[] = [];
    for (const [code, count] of Object.entries(r.counts as Record<string, unknown>)) {
      if (!Object.hasOwn(ISSUE_DEFINITIONS, code) || typeof count !== "number") continue;
      const def = ISSUE_DEFINITIONS[code as IssueCode];
      warnings.push({ code, count, severity: def.severity, message: def.message });
    }
    warnings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.count - a.count || (a.code < b.code ? -1 : 1));
    const samples = (r.samples as unknown[]).filter(
      (s): s is ReportSample => typeof s === "object" && s !== null && Object.hasOwn(ISSUE_DEFINITIONS, String((s as { code?: unknown }).code)),
    );
    return { warnings, samples, samplesOmitted: typeof r.samplesOmitted === "number" ? r.samplesOmitted : 0 };
  } catch {
    return null;
  }
}

export function batchSummary(row: BatchRow): BatchSummary {
  const status = (IMPORT_STATUSES as readonly string[]).includes(row.status) ? (row.status as ImportStatus) : "unknown";
  const a = batchAccounting(row);
  const report = parseReport(row.warningsJson);
  const accounting = accountingSummary(a);
  return {
    batchId: row.id,
    status,
    complete: a.complete,
    seen: a.seen,
    accounted: a.accounted,
    notAccounted: a.notAccounted,
    counts: {
      added: row.conversationsAdded,
      updated: row.conversationsUpdated,
      unchanged: row.conversationsUnchanged,
      older: row.conversationsOlder,
      flagged: row.conversationsFlagged,
      skipped: row.conversationsSkipped,
    },
    accountingText: accounting,
    errorCode: row.errorCode,
    errorMessage: row.errorCode === null ? null : codeMessage(row.errorCode),
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    warnings: report?.warnings ?? [],
    samples: report?.samples ?? [],
    samplesOmitted: report?.samplesOmitted ?? 0,
    reportAvailable: report !== null,
  };
}

/** JSON body of `POST /api/import`. */
export type ImportResponseBody =
  | { ok: true; batch: BatchSummary }
  | { ok: false; code: string; message: string };

export function errorBody(code: string): ImportResponseBody {
  return { ok: false, code, message: codeMessage(code) };
}
