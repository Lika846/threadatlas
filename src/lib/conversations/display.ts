/**
 * Display helpers for the conversation pages (M1.6). Pure: text only, never
 * markup. Imported values are passed through unchanged and rendered by React
 * as escaped text.
 */

export const UNTITLED = "Untitled conversation";

export function displayTitle(title: string | null): string {
  return title === null || title.trim() === "" ? UNTITLED : title;
}

const KNOWN_ROLES: Record<string, string> = { user: "User", assistant: "Assistant", system: "System", tool: "Tool" };

/** Known roles get a label; any other role is shown exactly as exported (A29). */
export function roleLabel(role: string | null): string {
  if (role === null) return "Unknown role";
  return Object.hasOwn(KNOWN_ROLES, role) ? KNOWN_ROLES[role]! : role;
}

/** Largest |ms| a JavaScript Date can represent. */
const MAX_DATE_MS = 8.64e15;

/**
 * Epoch seconds → "YYYY-MM-DD HH:MM UTC" (deterministic on server and client).
 * Timestamps are accepted if finite (A22), so extreme values fall back to text.
 */
export function formatEpochSeconds(sec: number | null): string | null {
  if (sec === null || !Number.isFinite(sec)) return null;
  const ms = sec * 1000;
  if (Math.abs(ms) > MAX_DATE_MS) return "outside the displayable date range";
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** ISO date-time for a `<time dateTime>` attribute, or undefined. */
export function isoFromEpochSeconds(sec: number | null): string | undefined {
  if (sec === null || !Number.isFinite(sec) || Math.abs(sec * 1000) > MAX_DATE_MS) return undefined;
  return new Date(sec * 1000).toISOString();
}

/** Explanation of the stored path strategy (A25); null when no note is needed. */
export function pathNote(strategy: string): string | null {
  switch (strategy) {
    case "current_node":
      return null;
    case "latest_leaf":
      return "The export did not record which branch was open, so this shows the branch with the most recent message. It may not be the branch you last viewed in ChatGPT.";
    case "last_child":
      return "The export did not record which branch was open, so this shows the last branch at each step. It may not be the branch you last viewed in ChatGPT.";
    case "none":
      return "No message path could be reconstructed for this conversation.";
    default:
      return "The way this conversation's path was chosen is not recognised.";
  }
}

export const isCodeContent = (contentType: string | null) => contentType === "code" || contentType === "execution_output";
