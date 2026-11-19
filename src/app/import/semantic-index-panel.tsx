"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import type { IndexView, Tone } from "@/lib/semantic/index/messages";
import { pauseIndexingAction, retryFailedAction, semanticIndexStatusAction, startIndexingAction, type SemanticActionResult } from "./semantic-actions";
import { BUTTON_PRIMARY, BUTTON_SECONDARY, NOTE } from "@/components/styles";

/**
 * Semantic-index controls (M5.1b-2): Start or Resume, Pause, Retry failed, progress.
 * Everything shown comes from the server as static text and counts. The status is
 * refreshed every 2 s while the page is visible. Indexing never starts by itself.
 */

const POLL_MS = 2_000;

const TONES: Record<Tone, string> = { success: NOTE.success, warning: NOTE.warning, error: NOTE.error, neutral: NOTE.info };

const fmt = (n: number) => n.toLocaleString("en-US");

export function SemanticIndexPanel({ initial }: { initial: IndexView | null }) {
  const [view, setView] = useState<IndexView | null>(initial);
  const [notice, setNotice] = useState<SemanticActionResult["notice"]>(null);
  const [pending, startTransition] = useTransition();
  const busyRef = useRef(false);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (stopped) return;
      if (!document.hidden && !busyRef.current) {
        try {
          const r = await semanticIndexStatusAction();
          if (!stopped && r.view) setView(r.view);
        } catch {
          // a missed poll is retried at the next tick
        }
      }
      if (!stopped) timer = setTimeout(poll, POLL_MS);
    };
    timer = setTimeout(poll, POLL_MS);
    const onVisible = () => {
      if (!document.hidden) {
        clearTimeout(timer);
        void poll();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const run = (action: () => Promise<SemanticActionResult>) =>
    startTransition(async () => {
      busyRef.current = true;
      try {
        const r = await action();
        if (r.view) setView(r.view);
        setNotice(r.notice);
      } catch {
        setNotice({ tone: "error", text: "The request could not be completed. Reload the page and try again." });
      } finally {
        busyRef.current = false;
      }
    });

  if (!view) {
    return (
      <p role="alert" className="mt-6">
        The semantic index cannot be managed right now: its status could not be read.
      </p>
    );
  }

  const c = view.counts;
  const failures = c.failed + c.tooLarge;
  return (
    <div className="mt-6 space-y-4" aria-busy={pending || view.running}>
      <p role="status" aria-live="polite" className={TONES[view.tone]} data-testid="semantic-status">
        {view.message}
      </p>
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-neutral-700 dark:text-neutral-300">
        <div className="flex gap-1">
          <dt>Indexed</dt>
          <dd className="font-medium tabular-nums" data-testid="semantic-indexed">
            {fmt(c.indexed)} of {fmt(c.conversations)}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt>Waiting</dt>
          <dd className="font-medium tabular-nums" data-testid="semantic-waiting">
            {fmt(c.waiting)}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt>In progress</dt>
          <dd className="font-medium tabular-nums" data-testid="semantic-running">
            {fmt(view.running ? c.running : 0)}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt>Failed</dt>
          <dd className="font-medium tabular-nums" data-testid="semantic-failed">
            {fmt(failures)}
            {c.tooLarge > 0 ? ` (${fmt(c.tooLarge)} too large)` : ""}
          </dd>
        </div>
      </dl>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={!view.canStart || pending}
          onClick={() => run(startIndexingAction)}
          className={BUTTON_PRIMARY}
        >
          {view.startLabel}
        </button>
        {view.running ? (
          <button
            type="button"
            disabled={!view.canPause || pending}
            onClick={() => run(pauseIndexingAction)}
            className={BUTTON_SECONDARY}
          >
            {view.pausing ? "Pausing…" : "Pause"}
          </button>
        ) : null}
        {view.canRetry ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => run(retryFailedAction)}
            className={BUTTON_SECONDARY}
          >
            Retry failed
          </button>
        ) : null}
      </div>
      <p aria-live="polite" className="min-h-6 text-sm text-neutral-600 dark:text-neutral-400" data-testid="semantic-notice">
        {notice?.text ?? ""}
      </p>
    </div>
  );
}
