/**
 * Delete-all confirmation phrase (M1.7, Q7 → A76). Client-safe: imported by
 * the Settings form (to enable the button) and by the Server Action (which
 * checks it again; the UI check alone is bypassable).
 */
export const DELETE_CONFIRMATION_PHRASE = "DELETE";

/** Exactly `DELETE`: case-sensitive, no trimming, nothing else accepted. */
export function isDeleteConfirmed(value: unknown): boolean {
  return value === DELETE_CONFIRMATION_PHRASE;
}
