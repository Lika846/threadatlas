/**
 * "Latest request wins" (M2.3). Each search gets a ticket; a response may
 * update the page only if its ticket is still the latest, whatever order the
 * responses complete in. Pure; one gate per mounted search form.
 */
export function createLatestGate() {
  let latest = 0;
  return {
    /** Starts a request and returns its ticket. */
    begin(): number {
      latest += 1;
      return latest;
    },
    isLatest(ticket: number): boolean {
      return ticket === latest;
    },
    /** Makes every outstanding ticket stale (for example when the form unmounts). */
    invalidate(): void {
      latest += 1;
    },
  };
}
