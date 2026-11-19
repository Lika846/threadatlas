import { AccountingNotice, formatTime, statusSentence } from "@/components/import-summary";
import { getDb } from "@/lib/db/client";
import { BATCH_SUMMARY_SELECT, batchSummary, type BatchSummary } from "@/lib/import/summary";

/**
 * Read-only "Last import" panel (M1.5, U9): the newest ImportBatch row, so an
 * import whose tab was closed (it still finishes, measured in M1.5 step 0)
 * or that was interrupted is visible. Reads only status, counters, times and
 * the bounded report; never content or file names.
 */
export async function LastImport() {
  let summary: BatchSummary | null;
  try {
    const row = await getDb().importBatch.findFirst({ orderBy: { startedAt: "desc" }, select: BATCH_SUMMARY_SELECT });
    summary = row ? batchSummary(row) : null;
  } catch {
    return (
      <section aria-labelledby="last-import-title" className="mt-10">
        <h2 id="last-import-title" className="text-xl font-semibold">
          Last import
        </h2>
        <p className="mt-2">Import history is not available: the database could not be read.</p>
      </section>
    );
  }
  return (
    <section aria-labelledby="last-import-title" className="mt-10" data-testid="last-import">
      <h2 id="last-import-title" className="text-xl font-semibold">
        Last import
      </h2>
      {summary === null ? (
        <p className="mt-2 text-neutral-600 dark:text-neutral-400">No imports yet.</p>
      ) : (
        <div className="mt-2">
          <p>
            {statusSentence(summary)}{" "}
            <span className="text-neutral-600 dark:text-neutral-400">
              Started <time dateTime={summary.startedAt}>{formatTime(summary.startedAt)}</time>, finished{" "}
              {summary.finishedAt ? <time dateTime={summary.finishedAt}>{formatTime(summary.finishedAt)}</time> : "not finished"}.
            </span>
          </p>
          {summary.complete ? (
            <p className="mt-1">
              {summary.seen} conversations: {summary.counts.added} added, {summary.counts.updated} updated, {summary.counts.unchanged} unchanged,{" "}
              {summary.counts.older + summary.counts.flagged + summary.counts.skipped} not imported (older, flagged or skipped).
            </p>
          ) : (
            <AccountingNotice summary={summary} />
          )}
        </div>
      )}
    </section>
  );
}
