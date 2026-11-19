import type { Metadata } from "next";
import { getImportMaxBytes } from "@/lib/import/read-upload";
import { ModelHelp } from "@/components/model-help";
import { LINK } from "@/components/styles";
import { EXPORT_HELP_URL } from "@/lib/onboarding/steps";
import { viewOf, type IndexView } from "@/lib/semantic/index/messages";
import { getIndexingStatus, type ModelState } from "@/lib/semantic/index/service";
import { ImportForm } from "./import-form";
import { LastImport } from "./last-import";
import { SemanticIndexPanel } from "./semantic-index-panel";

export const metadata: Metadata = { title: "Import" };

// Reads the database on every request; never prerendered at build time.
export const dynamic = "force-dynamic";

export default async function ImportPage() {
  let maxBytes: number | null;
  try {
    maxBytes = getImportMaxBytes();
  } catch {
    maxBytes = null;
  }
  let index: IndexView | null;
  let model: ModelState | null = null;
  try {
    const status = await getIndexingStatus();
    index = viewOf(status);
    model = status.model;
  } catch {
    index = null;
  }
  return (
    <>
      <h1 className="text-3xl font-semibold tracking-tight">Import</h1>
      <p className="mt-3 max-w-prose text-neutral-600 dark:text-neutral-400">
        Import a ChatGPT <code>conversations.json</code> export (JSON only). The file is processed on this computer and is not stored;
        only the conversations are saved, in the local database. Importing the same export again updates changed conversations and
        never duplicates them.
      </p>
      <p className="mt-2 max-w-prose text-neutral-600 dark:text-neutral-400">
        To get the file: in ChatGPT, open Settings, then Data controls; under Export data, choose Export and confirm. Unzip the .zip
        file from the email; the file to import is <code>conversations.json</code>. More in{" "}
        <a href={EXPORT_HELP_URL} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className={LINK}>
          OpenAI&apos;s export instructions
        </a>
        .
      </p>
      {maxBytes === null ? (
        <p role="alert" className="mt-6">
          The import size limit (IMPORT_MAX_BYTES) is not configured correctly, so importing is unavailable.
        </p>
      ) : (
        <ImportForm maxBytes={maxBytes} />
      )}
      <LastImport />
      <section aria-labelledby="semantic-index-title" className="mt-12">
        <h2 id="semantic-index-title" className="text-xl font-semibold">
          Semantic index
        </h2>
        <p className="mt-2 max-w-prose text-neutral-600 dark:text-neutral-400">
          Index your conversations so Search can find them by meaning, not just by exact words. The index is built on this computer
          with a local language model; nothing leaves your machine. Indexing starts only when you press Start. Index again after each
          import: new and changed conversations are found by meaning only once they are indexed.
        </p>
        {model !== null && model !== "ok" && (
          <div className="mt-4 max-w-prose">
            <ModelHelp state={model} />
          </div>
        )}
        <SemanticIndexPanel initial={index} />
      </section>
    </>
  );
}
