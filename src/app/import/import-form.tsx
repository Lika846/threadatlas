"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { BatchSummaryView } from "@/components/import-summary";
import { issueMessage } from "@/lib/import/errors";
import type { ImportResponseBody } from "@/lib/import/summary";
import { BUTTON_PRIMARY, LINK, NOTE } from "@/components/styles";

/**
 * Upload form (M1.5). Sends the file itself as the request body (not a
 * multipart form), so the server enforces the size limit while reading.
 * The browser sets Content-Length and Origin; scripts cannot.
 */

type Phase =
  | { kind: "idle" }
  | { kind: "pending"; startedAt: number }
  | { kind: "done"; body: Extract<ImportResponseBody, { ok: true }> }
  | { kind: "error"; message: string };

export const PENDING_MESSAGE = "Importing… This may take up to a minute. Keep this tab open to see the result.";
const NETWORK_ERROR =
  "The upload could not be completed. If the whole file had already been sent, the import may still finish on this computer; the Last import section below shows the latest result.";
const INTERNAL_ERROR = "An unexpected internal error occurred.";

function formatMiB(bytes: number): string {
  return `${Math.round(bytes / 2 ** 20)} MiB`;
}

export function ImportForm({ maxBytes }: { maxBytes: number }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [elapsed, setElapsed] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (phase.kind === "done") resultRef.current?.focus();
    if (phase.kind === "error") errorRef.current?.focus();
    if (phase.kind !== "pending") return;
    const startedAt = phase.startedAt;
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase.kind === "pending") return;
    const file = inputRef.current?.files?.[0];
    if (!file) return setPhase({ kind: "error", message: "Choose a file to import." });
    if (file.size === 0) return setPhase({ kind: "error", message: issueMessage("FILE_EMPTY") });
    if (file.size > maxBytes) return setPhase({ kind: "error", message: issueMessage("FILE_TOO_LARGE") });

    setElapsed(0);
    setPhase({ kind: "pending", startedAt: Date.now() });
    let response: Response;
    try {
      response = await fetch("/api/import", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-threadatlas-import": "1",
          "x-threadatlas-filename": encodeURIComponent(file.name),
        },
        body: file,
      });
    } catch {
      setPhase({ kind: "error", message: NETWORK_ERROR });
      router.refresh();
      return;
    }
    let body: ImportResponseBody | null = null;
    try {
      body = (await response.json()) as ImportResponseBody;
    } catch {
      body = null;
    }
    if (body?.ok) setPhase({ kind: "done", body });
    else setPhase({ kind: "error", message: body?.message ?? INTERNAL_ERROR });
    router.refresh(); // updates the Last import section
  }

  const pending = phase.kind === "pending";
  return (
    <section aria-labelledby="import-form-title" aria-busy={pending} className="mt-8">
      <h2 id="import-form-title" className="text-xl font-semibold">
        Import a file
      </h2>
      <noscript>
        <p className="mt-2">Importing needs JavaScript to be enabled in this browser.</p>
      </noscript>
      <form onSubmit={onSubmit} className="mt-4 space-y-4">
        <div>
          <label htmlFor="import-file" className="block font-medium">
            ChatGPT export file
          </label>
          <p id="import-file-hint" className="text-sm text-neutral-600 dark:text-neutral-400">
            The <code>conversations.json</code> file from a ChatGPT data export. JSON only, up to {formatMiB(maxBytes)}.
          </p>
          <input
            ref={inputRef}
            id="import-file"
            name="file"
            type="file"
            accept=".json,application/json"
            aria-describedby="import-file-hint"
            disabled={pending}
            className="mt-2 block text-sm file:mr-3 file:rounded-md file:border-0 file:bg-neutral-200 file:px-3 file:py-2 file:text-sm file:font-medium dark:file:bg-neutral-800"
          />
        </div>
        <button
          type="submit"
          disabled={pending}
          className={BUTTON_PRIMARY}
        >
          {pending ? "Importing…" : "Import"}
        </button>
      </form>

      <div role="status" aria-live="polite" className="mt-4">
        {pending && <p>{PENDING_MESSAGE}</p>}
      </div>
      {pending && (
        <p className="text-sm text-neutral-600 tabular-nums dark:text-neutral-400" aria-hidden="true">
          Elapsed: {elapsed} s
        </p>
      )}

      {phase.kind === "error" && (
        <div ref={errorRef} tabIndex={-1} role="alert" className={`mt-4 focus:outline-2 focus:outline-red-600 ${NOTE.error}`}>
          {phase.message}
        </div>
      )}

      {phase.kind === "done" && (
        <section aria-labelledby="import-result-title" className="mt-6">
          <h3 id="import-result-title" ref={resultRef} tabIndex={-1} className="text-xl font-semibold focus:outline-2 focus:outline-blue-600">
            Import summary
          </h3>
          <BatchSummaryView summary={phase.body.batch} />
          {phase.body.batch.counts.added + phase.body.batch.counts.updated > 0 && (
            <p className={`mt-6 max-w-prose ${NOTE.info}`} data-testid="import-next-step">
              <strong>Next:</strong> index the new and changed conversations, so the map, search by meaning and related conversations
              include them.{" "}
              <a href="#semantic-index-title" className={LINK}>
                Go to indexing
              </a>
            </p>
          )}
          <p className="mt-6">
            <Link
              href="/conversations"
              className={LINK}
            >
              View conversations
            </Link>
          </p>
        </section>
      )}
    </section>
  );
}
