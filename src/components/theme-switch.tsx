"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { THEME_STORAGE_KEY, type Theme, type ThemeChoice } from "@/lib/theme";

/** Fired in this tab when the choice changes (the storage event only reaches other tabs). */
const CHANGE_EVENT = "threadatlas-theme-change";

function readChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function subscribeChoice(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

/** Same rule as THEME_SCRIPT. */
function applyTheme(choice: ThemeChoice) {
  const theme = choice === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : choice;
  document.documentElement.setAttribute("data-theme", theme);
}

function choose(choice: ThemeChoice) {
  try {
    if (choice === "system") localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Storage blocked: the theme still changes for this page.
  }
  applyTheme(choice);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** The theme the page shows now, for components that need it in JavaScript (null before hydration). */
export function useTheme(): Theme | null {
  return useSyncExternalStore(
    (onChange) => {
      const observer = new MutationObserver(onChange);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      return () => observer.disconnect();
    },
    () => (document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light"),
    () => null,
  );
}

const icon = "h-4 w-4";
const OPTIONS: { value: ThemeChoice; label: string; svg: ReactNode }[] = [
  {
    value: "system",
    label: "System",
    svg: (
      <svg className={icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M8 20h8M12 16v4" />
      </svg>
    ),
  },
  {
    value: "light",
    label: "Light",
    svg: (
      <svg className={icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    ),
  },
  {
    value: "dark",
    label: "Dark",
    svg: (
      <svg className={icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
      </svg>
    ),
  },
];

/** System / Light / Dark, in the page header. Nothing is marked as chosen until the page has loaded. */
export function ThemeSwitch() {
  const current = useSyncExternalStore(subscribeChoice, readChoice, () => null);
  return (
    <div role="group" aria-label="Theme" className="flex rounded-md border border-neutral-200 p-0.5 dark:border-neutral-800">
      {OPTIONS.map(({ value, label, svg }) => (
        <button
          key={value}
          type="button"
          onClick={() => choose(value)}
          aria-pressed={current === null ? undefined : current === value}
          title={`${label} theme`}
          className="rounded p-1.5 text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-600 aria-pressed:bg-neutral-900 aria-pressed:text-white dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100 dark:aria-pressed:bg-neutral-100 dark:aria-pressed:text-neutral-900"
        >
          {svg}
          <span className="sr-only">{label} theme</span>
        </button>
      ))}
    </div>
  );
}
