/**
 * Shared interface styles (phase 3): the class strings that were copied between pages. Only
 * what removes real duplication; not a design system. Each token works in light and dark,
 * with a visible keyboard focus ring.
 *
 * Colour roles (Tailwind's palette): text neutral-900 / neutral-100; muted text neutral-600 /
 * neutral-400; links and the primary action blue-700 / blue-400;
 * notes amber; errors red. Measured contrast is in `styles.test.ts`.
 */

/** Keyboard focus ring (focus-visible only, so a mouse click shows none). */
export const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:focus-visible:outline-blue-400";

/** An inline text link. */
export const LINK = `font-medium text-blue-700 underline underline-offset-4 hover:text-blue-900 dark:text-blue-400 dark:hover:text-blue-300 ${FOCUS}`;

/** Secondary text: dates, counts, hints. */
export const MUTED = "text-sm text-neutral-600 dark:text-neutral-400";

const BUTTON_BASE = `inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS}`;
/** The one main action of a section. */
export const BUTTON_PRIMARY = `${BUTTON_BASE} bg-blue-700 text-white hover:bg-blue-800 dark:bg-blue-400 dark:text-neutral-950 dark:hover:bg-blue-300`;
/** Other actions. */
export const BUTTON_SECONDARY = `${BUTTON_BASE} border border-neutral-300 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800`;
/** A destructive action (delete all imported data). */
export const BUTTON_DANGER = `${BUTTON_BASE} bg-red-700 text-white hover:bg-red-800 dark:bg-red-500 dark:text-neutral-950 dark:hover:bg-red-400`;

export type Tone = "info" | "success" | "warning" | "error";
/** Boxed messages by tone. */
export const NOTE: Record<Tone, string> = {
  info: "rounded-md border border-neutral-300 bg-neutral-50 p-3 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100",
  success: "rounded-md border border-green-300 bg-green-50 p-3 text-sm text-green-950 dark:border-green-800 dark:bg-green-950 dark:text-green-100",
  warning: "rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100",
  error: "rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-950 dark:border-red-800 dark:bg-red-950 dark:text-red-100",
};
