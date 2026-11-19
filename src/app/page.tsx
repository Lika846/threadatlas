import Link from "next/link";
import type { ReactNode } from "react";
import { ModelHelp } from "@/components/model-help";
import { BUTTON_PRIMARY, BUTTON_SECONDARY, LINK, MUTED, NOTE } from "@/components/styles";
import { EXPORT_HELP_URL, setupOf, type Setup, type StepId, type StepState } from "@/lib/onboarding/steps";
import { getIndexingStatus } from "@/lib/semantic/index/service";

// Reads the database (counts only) on every request; never prerendered at build time.
export const dynamic = "force-dynamic";

/**
 * Home (phase 3): the first-run sequence, export → import → index → explore, checking itself
 * off from the archive's real state. Empty: how to get and import an export. Imported: index for
 * meaning (with the model's installation if it is missing). Partly indexed: continue, and
 * explore what is ready. Everything indexed: the map is the next step. One primary action at
 * a time; numbered because it is a real sequence. Counts only; no conversation content.
 */

const n = (x: number) => x.toLocaleString("en-US");
const conversations = (x: number) => `${n(x)} ${x === 1 ? "conversation" : "conversations"}`;

const MARK: Record<StepState, { symbol: string; label: string; className: string }> = {
  done: { symbol: "✓", label: "Done", className: "border-green-700 bg-green-700 text-white dark:border-green-400 dark:bg-green-400 dark:text-neutral-950" },
  current: { symbol: "", label: "Next", className: "border-blue-700 text-blue-700 dark:border-blue-400 dark:text-blue-400" },
  available: { symbol: "", label: "Available", className: "border-blue-700 text-blue-700 dark:border-blue-400 dark:text-blue-400" },
  waiting: { symbol: "", label: "Later", className: "border-neutral-400 text-neutral-600 dark:border-neutral-600 dark:text-neutral-400" },
  blocked: { symbol: "!", label: "Needs the model", className: "border-amber-600 bg-amber-50 text-amber-900 dark:border-amber-500 dark:bg-amber-950 dark:text-amber-100" },
};

function Step({ number, id, state, title, children }: { number: number; id: StepId; state: StepState; title: string; children: ReactNode }) {
  const mark = MARK[state];
  return (
    <li className="flex gap-4" data-step={id} data-state={state} aria-current={state === "current" ? "step" : undefined}>
      <span aria-hidden="true" className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 text-sm font-semibold tabular-nums ${mark.className}`}>
        {mark.symbol || number}
      </span>
      <div className="min-w-0 flex-1 pb-6">
        <h2 className={`text-lg font-semibold ${state === "waiting" ? "text-neutral-600 dark:text-neutral-400" : ""}`}>
          {title} <span className="sr-only">({mark.label})</span>
        </h2>
        <div className="mt-1 space-y-2 text-neutral-700 dark:text-neutral-300">{children}</div>
      </div>
    </li>
  );
}

function IndexStep({ setup, state }: { setup: Setup; state: StepState }) {
  const c = setup.counts;
  const failures = c.failed + c.tooLarge;
  if (state === "waiting") return <p>After importing, index your conversations so they can be found by meaning, grouped on the map and related to each other.</p>;
  if (state === "blocked") return setup.model === "ok" ? null : <ModelHelp state={setup.model} />;
  if (state === "done")
    return (
      <p>
        {c.indexed === c.conversations ? `All ${conversations(c.conversations)} are indexed.` : `${n(c.indexed)} of ${conversations(c.conversations)} indexed.`}
        {failures > 0 && (
          <>
            {" "}
            {n(failures)} couldn&apos;t be indexed;{" "}
            <Link href="/import#semantic-index-title" className={LINK}>
              see the Import page
            </Link>
            .
          </>
        )}
      </p>
    );
  return (
    <>
      <p>
        {setup.indexing
          ? `Indexing… ${n(c.indexed)} of ${conversations(c.conversations)} indexed so far.`
          : c.indexed > 0
            ? `${n(c.indexed)} of ${conversations(c.conversations)} indexed; ${n(c.waiting + c.running)} still to do.`
            : `${conversations(c.conversations)} to index. It runs on this computer with a local model and takes a few minutes for a few thousand conversations.`}
      </p>
      <p>
        <Link href="/import#semantic-index-title" className={BUTTON_PRIMARY}>
          {setup.indexing ? "See progress" : c.indexed > 0 ? "Continue indexing" : "Start indexing"}
        </Link>
      </p>
    </>
  );
}

export default async function Home() {
  let setup: Setup | null;
  try {
    setup = setupOf(await getIndexingStatus());
  } catch {
    setup = null;
  }
  const state = (id: StepId) => setup?.steps.find((s) => s.id === id)?.state ?? "waiting";
  return (
    <>
      <h1 className="text-3xl font-semibold tracking-tight">ThreadAtlas</h1>
      <p className="mt-3 max-w-prose text-lg text-neutral-700 dark:text-neutral-300">Map your ChatGPT history, on this computer.</p>
      <p className={`mt-1 max-w-prose ${MUTED}`}>Nothing is uploaded: the app has no network code, and the language model runs locally.</p>

      {setup === null ? (
        <p role="alert" className={`mt-8 ${NOTE.error}`}>
          The archive&apos;s state could not be read.{" "}
          <Link href="/import" className={LINK}>
            Go to the Import page
          </Link>
          .
        </p>
      ) : (
        <ol className="mt-8 max-w-2xl" aria-label="Getting started">
          <Step number={1} id="export" state={state("export")} title="Get your ChatGPT export">
            {state("export") === "done" ? (
              <p>Done. To add newer conversations later, export again and import the new file: nothing is duplicated.</p>
            ) : (
              <p>
                In ChatGPT, open <strong>Settings</strong>, then <strong>Data controls</strong>; under <strong>Export data</strong>, choose{" "}
                <strong>Export</strong> and confirm. You&apos;ll get an email with a link to a .zip file; unzip it. The file ThreadAtlas needs is{" "}
                <code className="font-mono">conversations.json</code>. More in{" "}
                <a href={EXPORT_HELP_URL} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className={LINK}>
                  OpenAI&apos;s export instructions
                </a>
                .
              </p>
            )}
          </Step>
          <Step number={2} id="import" state={state("import")} title="Import it">
            {state("import") === "done" ? (
              <p>
                {conversations(setup.counts.conversations)} imported.{" "}
                <Link href="/import" className={LINK}>
                  Import another file
                </Link>
              </p>
            ) : (
              <>
                <p>The file is read on this computer and isn&apos;t kept; only the conversations are saved, in the local database.</p>
                <p>
                  <Link href="/import" className={BUTTON_PRIMARY}>
                    Import a file
                  </Link>
                </p>
              </>
            )}
          </Step>
          <Step number={3} id="index" state={state("index")} title="Index for meaning">
            <IndexStep setup={setup} state={state("index")} />
          </Step>
          <Step number={4} id="explore" state={state("explore")} title="Explore">
            {state("explore") === "waiting" ? (
              <p>The map of themes and topics, search by meaning and related conversations, once something is indexed.</p>
            ) : (
              <>
                {state("explore") === "available" && <p>What&apos;s indexed so far can already be explored; the rest joins as it is indexed.</p>}
                <p className="flex flex-wrap gap-3">
                  <Link href="/map" className={state("explore") === "current" ? BUTTON_PRIMARY : BUTTON_SECONDARY}>
                    Open the map
                  </Link>
                  <Link href="/search" className={BUTTON_SECONDARY}>
                    Search
                  </Link>
                  <Link href="/conversations" className={BUTTON_SECONDARY}>
                    All conversations
                  </Link>
                </p>
              </>
            )}
          </Step>
        </ol>
      )}
    </>
  );
}
