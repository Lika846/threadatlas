/**
 * Host-header validation: defence against DNS rebinding (plan amendment A6).
 *
 * Binding the server to 127.0.0.1 stops other machines from connecting, but not
 * a malicious website. Such a site can point its own domain at 127.0.0.1; the
 * browser then treats this app as same-origin with the attacker's page and lets
 * it read every response. In that attack the browser sends the attacker's
 * domain in the `Host` header (scripts cannot override `Host`), so accepting
 * only loopback host names blocks it.
 *
 * Any port is accepted. The attack is identified by the host *name*, and the
 * port varies legitimately (dev 3000, e2e 3100, `--port`).
 *
 * This is not CSRF protection. State-changing requests additionally need their
 * own Origin checks (A6, A11).
 */

export const ALLOWED_HOSTNAMES: readonly string[] = ["127.0.0.1", "localhost"];

export type HostCheckResult =
  | { ok: true }
  | {
      ok: false;
      reason: "missing-host" | "host-not-allowed" | "forwarded-host-not-allowed";
    };

/** Header access compatible with `Headers` and `NextRequest.headers`. */
type HeaderSource = { get(name: string): string | null };

// Strict `hostname[:port]`: no userinfo, paths, whitespace, lists, IPv6
// literals or trailing dots. Anything unusual is rejected, not normalised.
const HOST_PATTERN = /^([a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::([0-9]{1,5}))?$/;

/** Returns true only for a single, well-formed loopback `Host` value. */
export function isAllowedHost(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  const match = HOST_PATTERN.exec(value.toLowerCase());
  if (!match) return false;
  const [, hostname, port] = match;
  if (port !== undefined) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return false;
  }
  return hostname !== undefined && ALLOWED_HOSTNAMES.includes(hostname);
}

/**
 * Validates the request's `Host` and, if present, `X-Forwarded-Host`.
 * The latter is checked because Next.js uses it when comparing Origin for
 * Server Actions, and page scripts *can* set it.
 */
export function checkRequestHost(headers: HeaderSource): HostCheckResult {
  const host = headers.get("host");
  if (host === null || host === "") return { ok: false, reason: "missing-host" };
  if (!isAllowedHost(host)) return { ok: false, reason: "host-not-allowed" };

  const forwarded = headers.get("x-forwarded-host");
  if (forwarded !== null) {
    const values = forwarded.split(",").map((v) => v.trim());
    if (!values.every(isAllowedHost)) {
      return { ok: false, reason: "forwarded-host-not-allowed" };
    }
  }
  return { ok: true };
}
