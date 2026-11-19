"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";
import { DELETE_CONFIRMATION_PHRASE, isDeleteConfirmed } from "@/lib/data/confirmation";
import type { SettingsActionState } from "@/lib/data/messages";
import { deleteAllAction, finishCleanupAction } from "./actions";
import { BUTTON_DANGER, BUTTON_PRIMARY, BUTTON_SECONDARY, LINK, NOTE } from "@/components/styles";

/**
 * Delete-all and storage-cleanup controls (M1.7). One component for both, so
 * the result message survives the page refresh that follows an action (the
 * page then shows the other control). Plain text only.
 */

export type DataPanelProps = {
  counts: { conversations: number; messages: number; imports: number };
  /** Only meaningful when there is no imported data (see `getDataState`). */
  cleanupMayBeIncomplete: boolean | null;
};



function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function latestOf(a: SettingsActionState, b: SettingsActionState): SettingsActionState {
  if (!a) return b;
  if (!b) return a;
  return a.seq >= b.seq ? a : b;
}

export function DataPanel({ counts, cleanupMayBeIncomplete }: DataPanelProps) {
  const [deleteState, deleteAction, deleting] = useActionState(deleteAllAction, null);
  const [cleanupState, cleanupAction, cleaning] = useActionState<SettingsActionState>(finishCleanupAction, null);
  const resultRef = useRef<HTMLDivElement>(null);
  // The most recent result of either action (sequence numbers come from the server).
  const latest = latestOf(deleteState, cleanupState);

  useEffect(() => {
    if (latest) resultRef.current?.focus();
  }, [latest]);

  const busy = deleting || cleaning;
  const hasData = counts.conversations + counts.messages + counts.imports > 0;

  return (
    <div className="mt-6 space-y-6" aria-busy={busy}>
      <div role="status" aria-live="polite" className="sr-only">
        {deleting ? "Deleting all imported data…" : cleaning ? "Cleaning up storage…" : ""}
      </div>

      {latest && (
        <div
          ref={resultRef}
          tabIndex={-1}
          role={latest.tone === "success" ? "status" : "alert"}
          data-outcome={latest.outcome}
          className={`focus:outline-2 focus:outline-blue-600 ${NOTE[latest.tone]}`}
        >
          <p>{latest.message}</p>
          {latest.outcome === "complete" && (
            <p className="mt-2">
              <Link href="/conversations" className={LINK}>
                View conversations
              </Link>{" "}
              (now empty), or{" "}
              <Link href="/import" className={LINK}>
                import a file
              </Link>
              .
            </p>
          )}
        </div>
      )}

      {hasData ? (
        // Remounted after each result, which clears the typed phrase.
        <DeleteForm key={deleteState?.seq ?? 0} counts={counts} action={deleteAction} busy={busy} deleting={deleting} />
      ) : (
        <section aria-labelledby="cleanup-title" className="space-y-3">
          <p>There is no imported data.</p>
          <h3 id="cleanup-title" className="text-lg font-medium">
            Storage cleanup
          </h3>
          {cleanupMayBeIncomplete === true && (
            <p className={NOTE.warning}>
              Cleanup may be incomplete: the database still has free space or a leftover journal file, so deleted text may remain in
              it. Run Finish storage cleanup.
            </p>
          )}
          <p className="text-neutral-600 dark:text-neutral-400">
            Compacts the database files so that text from deleted conversations does not remain in them. It never deletes records and
            is safe to repeat.
            {cleanupMayBeIncomplete !== true &&
              " Run it again if a deletion was interrupted: no warning here does not prove that an earlier cleanup finished."}
          </p>
          <form action={cleanupAction}>
            <button
              type="submit"
              disabled={busy}
              className={BUTTON_PRIMARY}
            >
              {cleaning ? "Cleaning up…" : "Finish storage cleanup"}
            </button>
          </form>
        </section>
      )}
    </div>
  );
}

function DeleteForm({
  counts,
  action,
  busy,
  deleting,
}: {
  counts: DataPanelProps["counts"];
  action: (formData: FormData) => void;
  busy: boolean;
  deleting: boolean;
}) {
  const [phrase, setPhrase] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmed = isDeleteConfirmed(phrase);
  return (
    <form action={action} className="space-y-4">
      <p>
        This deletes <strong>{fmt(counts.conversations)}</strong> {counts.conversations === 1 ? "conversation" : "conversations"},{" "}
        <strong>{fmt(counts.messages)}</strong> {counts.messages === 1 ? "message" : "messages"} and{" "}
        <strong>{fmt(counts.imports)}</strong> {counts.imports === 1 ? "import record" : "import records"} from this computer. It
        cannot be undone. Your original export file is not affected.
      </p>
      <div>
        <label htmlFor="delete-confirm" className="block font-medium">
          Type {DELETE_CONFIRMATION_PHRASE} to confirm
        </label>
        <p id="delete-confirm-hint" className="text-sm text-neutral-600 dark:text-neutral-400">
          Capital letters, exactly as shown.
        </p>
        <input
          ref={inputRef}
          id="delete-confirm"
          name="confirm"
          type="text"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          aria-describedby="delete-confirm-hint"
          disabled={busy}
          className="mt-2 block w-48 rounded-md border border-neutral-300 bg-white px-3 py-2 font-mono dark:border-neutral-700 dark:bg-neutral-900"
        />
      </div>
      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={!confirmed || busy} className={BUTTON_DANGER}>
          {deleting ? "Deleting…" : "Delete all imported data"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setPhrase("");
            inputRef.current?.focus();
          }}
          className={BUTTON_SECONDARY}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
