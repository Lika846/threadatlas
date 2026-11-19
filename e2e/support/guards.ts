import { expect, type Page } from "@playwright/test";

/**
 * Records console errors (including CSP violations), uncaught page errors and
 * any browser request to a non-local origin. Call `assertClean()` at the end
 * of a test. This guards the "no data leaves the machine" rule.
 */
export function attachPrivacyGuards(
  page: Page,
  baseURL: string | undefined,
  opts: { allowConsoleErrors?: RegExp[] } = {},
) {
  const appOrigin = new URL(baseURL ?? "http://127.0.0.1").origin;
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const foreignRequests: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    // Expected errors only (e.g. Chromium logs a deliberate 4xx API response).
    if (opts.allowConsoleErrors?.some((re) => re.test(msg.text()))) return;
    consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(err.message));
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (url.protocol === "data:" || url.protocol === "blob:") return;
    if (url.origin !== appOrigin) foreignRequests.push(req.url());
  });

  return {
    async assertClean() {
      await page.waitForLoadState("networkidle");
      expect(consoleErrors, "console errors (incl. CSP violations)").toEqual([]);
      expect(pageErrors, "uncaught page errors").toEqual([]);
      expect(foreignRequests, "requests leaving this machine").toEqual([]);
    },
  };
}
