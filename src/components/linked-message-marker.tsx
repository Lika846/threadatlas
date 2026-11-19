"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { linkedMessageId } from "@/lib/conversations/linked-message";

/**
 * Marks the message a search result linked to (M2.3 polish).
 *
 * CSS `:target` alone is not enough: Next.js navigates with
 * `history.pushState`, which browsers do not treat as a fragment navigation,
 * so `:target` only applies when a link is loaded directly. This component
 * reads `location.hash` after every render of the page (path or query change),
 * on `hashchange`, on `popstate` (Back/Forward) and when the page content
 * changes, at most once per animation frame, and puts `data-linked` on
 * the matching message's `<article>`; every other article loses it. The
 * stylesheet outlines `[data-linked]` exactly like `:target`.
 *
 * Nothing is stored, sent or logged; only the existing `#m-<n>` fragment is read.
 */
export function LinkedMessageMarker() {
  const pathname = usePathname();
  const search = useSearchParams().toString();

  useEffect(() => {
    let frame = 0;
    const mark = () => {
      for (const el of document.querySelectorAll("article[data-linked]")) el.removeAttribute("data-linked");
      const id = linkedMessageId(window.location.hash);
      if (id === null) return;
      document.getElementById(id)?.closest("article")?.setAttribute("data-linked", "");
    };
    // After the browser and Next.js have applied the new URL and content.
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(mark);
    };
    schedule();
    window.addEventListener("hashchange", schedule);
    window.addEventListener("popstate", schedule);
    // Next.js can render a page's content after the URL changes (for example on Back
    // within the same conversation), so re-check when the content changes. Only
    // child-list changes are observed: setting data-linked does not re-trigger this.
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("hashchange", schedule);
      window.removeEventListener("popstate", schedule);
    };
  }, [pathname, search]);

  return null;
}
