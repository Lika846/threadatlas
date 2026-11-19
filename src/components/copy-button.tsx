"use client";

import { useState } from "react";
import { BUTTON_SECONDARY } from "@/components/styles";

/** Copies a fixed text (a command) to the clipboard and says so; nothing else is read or sent. */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        className={`${BUTTON_SECONDARY} px-3 py-1`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setState("copied");
          } catch {
            setState("failed");
          }
        }}
      >
        {label}
      </button>
      <span role="status" aria-live="polite" className="text-sm text-neutral-600 dark:text-neutral-400">
        {state === "copied" ? "Copied." : state === "failed" ? "Couldn't copy; select the command instead." : ""}
      </span>
    </span>
  );
}
