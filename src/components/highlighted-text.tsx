import { Fragment } from "react";
import type { SnippetSegment } from "@/lib/search/snippet";

/**
 * Renders search segments (M2.3, A97): plain React text, with `<mark>` around
 * matches. Never HTML: imported text is escaped by React like everywhere else.
 */
export function HighlightedText({ segments }: { segments: SnippetSegment[] }) {
  return (
    <>
      {segments.map((s, i) =>
        s.match ? (
          <mark key={i} className="rounded-sm bg-yellow-200 px-0.5 text-inherit dark:bg-yellow-700/60">
            {s.text}
          </mark>
        ) : (
          <Fragment key={i}>{s.text}</Fragment>
        ),
      )}
    </>
  );
}
