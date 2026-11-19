import type { Metadata } from "next";
import { getDb } from "@/lib/db/client";
import { getDataState, type DataState } from "@/lib/data/delete-all";
import { DataPanel } from "./data-panel";

export const metadata: Metadata = { title: "Settings" };

// Reads the database on every request; never prerendered at build time.
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  let state: DataState | null;
  try {
    state = await getDataState(getDb());
  } catch {
    state = null;
  }
  return (
    <>
      <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
      <section aria-labelledby="delete-all-title" className="mt-8">
        <h2 id="delete-all-title" className="text-xl font-semibold">
          Delete all imported data
        </h2>
        <p className="mt-2 max-w-prose text-neutral-600 dark:text-neutral-400">
          Removes every imported conversation, message and import record from the local database, then cleans up the database files.
          Cleanup is best effort: it cannot remove copies that the operating system, the disk, snapshots or backups may keep. See the
          README for details.
        </p>
        {state === null ? (
          <p role="alert" className="mt-6">
            Imported data cannot be managed right now: the database could not be read.
          </p>
        ) : (
          <DataPanel counts={state.counts} cleanupMayBeIncomplete={state.cleanupMayBeIncomplete} />
        )}
      </section>
    </>
  );
}
