import { checkRequestHost } from "./host-validation";

/**
 * Checks for state-changing requests from the app's own pages (M1.5; the
 * same-origin core is reused by the M1.7 Server Actions below). Header-only: run them before reading the body, so
 * a rejected request is never consumed.
 *
 * Measured in M1.5 step 0 (Chromium, Next.js 16.4.4):
 * - Routes excluded from `src/proxy.ts` receive forged `Host` headers, so the
 *   Host check must run here as well (same rules as the proxy).
 * - Other origins on this machine can make simple `fetch`, `no-cors` `fetch`,
 *   `sendBeacon` and form POSTs reach a route. All of them carried `Origin`,
 *   none could add a custom header or `Content-Type: application/json`
 *   (those force a CORS preflight, which fails: Next.js answers OPTIONS
 *   without CORS headers).
 *
 * So, in order: loopback Host; `Origin` exactly equal to this server's own
 * origin (scheme, host and port); `Sec-Fetch-Site: same-origin` when the
 * browser sends it; the custom header; the expected content type. The
 * content type is CSRF hardening only; uploads are validated by content (A13).
 * Rejected values are never echoed or logged.
 */

export const IMPORT_REQUEST_HEADER = "x-threadatlas-import";

export type GuardFailure = { status: 403; code: "REQUEST_FORBIDDEN" } | { status: 415; code: "REQUEST_CONTENT_TYPE" };

type HeaderSource = { get(name: string): string | null };

/** The page origin a same-origin request must carry: `http://` + the validated Host. */
export function expectedOrigin(host: string): string {
  return `http://${host.toLowerCase()}`;
}

/**
 * The independent same-origin core shared by every state-changing request:
 * loopback Host (and X-Forwarded-Host), an `Origin` exactly equal to this
 * server's own origin, and `Sec-Fetch-Site: same-origin` when sent.
 */
export function isSameOriginRequest(headers: HeaderSource): boolean {
  if (!checkRequestHost(headers).ok) return false;
  const host = headers.get("host")!;
  const origin = headers.get("origin");
  if (origin === null || origin.toLowerCase() !== expectedOrigin(host)) return false;
  const site = headers.get("sec-fetch-site");
  return site === null || site === "same-origin";
}

export function checkSameOriginRequest(
  headers: HeaderSource,
  opts: { customHeader: string; contentType: string },
): { ok: true } | ({ ok: false } & GuardFailure) {
  const forbidden = { ok: false as const, status: 403 as const, code: "REQUEST_FORBIDDEN" as const };
  if (!isSameOriginRequest(headers)) return forbidden;
  if (headers.get(opts.customHeader) !== "1") return forbidden;
  const type = (headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== opts.contentType) return { ok: false, status: 415, code: "REQUEST_CONTENT_TYPE" };
  return { ok: true };
}

/**
 * Checks for Server Actions (M1.7, A11). Run first in the action body, via
 * `await headers()`. Measured in M1.7 step 0 (Next.js 16.4.4): Next's own
 * check rejects a foreign or `null` Origin, but still runs the action when
 * Origin is missing, when `Sec-Fetch-Site` is `cross-site`, and for the
 * no-JavaScript multipart form path, which sends no `Next-Action` header.
 *
 * So this repeats the same-origin core above independently, then requires
 * `Next-Action`. That header is supplementary only: a cross-origin page
 * cannot add it without a CORS preflight (which fails), but it is not a
 * secret (the action ID is in the page). It also rules out the no-JavaScript
 * path, which the app's forms never use.
 */
export const SERVER_ACTION_HEADER = "next-action";

export function checkServerActionRequest(headers: HeaderSource): { ok: true } | { ok: false; code: "REQUEST_FORBIDDEN" } {
  if (!isSameOriginRequest(headers)) return { ok: false, code: "REQUEST_FORBIDDEN" };
  const action = headers.get(SERVER_ACTION_HEADER);
  if (action === null || action.trim() === "") return { ok: false, code: "REQUEST_FORBIDDEN" };
  return { ok: true };
}
