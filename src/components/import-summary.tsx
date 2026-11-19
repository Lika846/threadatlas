import type { BatchSummary } from "@/lib/import/summary";
import { NOTE } from "@/components/styles";

/**
 * Renders an import summary (M1.5). Presentational only: usable from the
 * client form and the server-rendered last-import panel. Every value is
 * rendered as text (React escapes it); nothing is rendered as HTML.
 *
 * An incomplete batch (failed, interrupted, still running) leads with its
 * durable accounting, and its counters are labelled as recorded so far, so
 * they are never read as completion counts.
 */

export function statusSentence(s: Pick<BatchSummary, "status">): string {
  switch (s.status) {
    case "succeeded":
      return "Import complete.";
    case "succeeded_with_warnings":
      return "Import complete, with warnings or notes.";
    case "completed_with_errors":
      return "Import complete, but some conversations could not be saved.";
    case "failed":
      return "The import stopped before it finished.";
    case "interrupted":
      return "The import was interrupted before it finished.";
    case "running":
      return "This import has not finished. If no import is running, it stopped unexpectedly and will be marked as interrupted at the next import.";
    default:
      return "The status of this import is not recognised.";
  }
}

/** Deterministic UTC time (identical on server and client). */
export function formatTime(iso: string | null): string {
  if (iso === null) return "not finished";
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

const ROWS: [keyof BatchSummary["counts"], string][] = [
  ["added", "Added"],
  ["updated", "Updated"],
  ["unchanged", "Unchanged"],
  ["older", "Older copy, stored version kept"],
  ["flagged", "Flagged, not imported"],
  ["skipped", "Skipped"],
];

const SEVERITY_LABEL = { error: "Problem", warning: "Warning", info: "Note" } as const;

export function AccountingNotice({ summary }: { summary: BatchSummary }) {
  if (summary.complete) return null;
  return (
    <div className={`mt-3 ${NOTE.warning}`}>
      <p className="font-medium">{summary.accountingText ?? "The outcome of this import is not fully recorded."}</p>
      {summary.errorMessage && <p className="mt-1">{summary.errorMessage}</p>}
      <p className="mt-1">Import the same file again to finish. Conversations that were already saved are not duplicated.</p>
    </div>
  );
}

function sampleText(s: BatchSummary["samples"][number]): string {
  if ("oversized" in s) return `${s.code}: details too long to show`;
  const parts: string[] = [s.code];
  if (s.index !== undefined) parts.push(`entry ${s.index + 1}`);
  if (s.sourceId !== undefined) parts.push(`conversation ID ${s.sourceId}`);
  if (s.nodeId !== undefined) parts.push(`node ${s.nodeId}`);
  if (s.relatedNodeId !== undefined) parts.push(`related node ${s.relatedNodeId}`);
  if (s.field !== undefined) parts.push(`field ${s.field}`);
  if (s.errorCode !== undefined) parts.push(`database error ${s.errorCode}`);
  if (s.duplicateGroup !== undefined) parts.push(`${s.duplicateGroup.occurrences} copies`);
  return parts.join(" · ");
}

export function BatchSummaryView({ summary }: { summary: BatchSummary }) {
  return (
    <div>
      <p className="mt-2">{statusSentence(summary)}</p>
      <AccountingNotice summary={summary} />
      {summary.complete && summary.errorMessage && <p className="mt-2">{summary.errorMessage}</p>}

      <table className="mt-4 w-full max-w-md text-left text-sm">
        <caption className="text-left font-medium">
          {summary.complete ? `${summary.seen} conversations in the file` : `Recorded so far (${summary.accounted} of ${summary.seen} conversations)`}
        </caption>
        <tbody>
          {ROWS.map(([key, label]) => (
            <tr key={key} className="border-b border-neutral-200 dark:border-neutral-800">
              <th scope="row" className="py-1 pr-4 font-normal">
                {label}
              </th>
              <td className="py-1 text-right tabular-nums">{summary.counts[key]}</td>
            </tr>
          ))}
          {!summary.complete && (
            <tr>
              <th scope="row" className="py-1 pr-4 font-normal">
                Not accounted for
              </th>
              <td className="py-1 text-right tabular-nums">{summary.notAccounted}</td>
            </tr>
          )}
        </tbody>
      </table>

      {summary.warnings.length > 0 && (
        <>
          <h3 className="mt-6 font-medium">Warnings and notes</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
            {summary.warnings.map((w) => (
              <li key={w.code}>
                <span className="font-medium">{SEVERITY_LABEL[w.severity]}:</span> {w.message} ({w.count})
              </li>
            ))}
          </ul>
        </>
      )}

      {summary.samples.length > 0 && (
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600">
            Details ({summary.samples.length} listed{summary.samplesOmitted > 0 ? `, ${summary.samplesOmitted} more not listed` : ""})
          </summary>
          <ul className="mt-2 space-y-1 pl-1 font-mono text-xs break-all">
            {summary.samples.map((s, i) => (
              <li key={i}>{sampleText(s)}</li>
            ))}
          </ul>
        </details>
      )}
      {!summary.reportAvailable && <p className="mt-4 text-sm text-neutral-600 dark:text-neutral-400">The detailed report for this import is not available.</p>}
    </div>
  );
}
