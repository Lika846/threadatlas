/**
 * HTTP security headers applied to every route (see next.config.ts).
 *
 * Privacy rationale: imported conversations are untrusted and may later be
 * rendered with links or image references. Restricting every fetch-like
 * CSP directive to 'self' means the browser cannot silently send requests
 * (images, fonts, XHR, beacons) to third-party hosts.
 *
 * 'unsafe-inline' for scripts is required by Next.js App Router hydration
 * without a nonce setup; 'unsafe-eval' and the websocket sources are
 * development-only (React debugging and hot reload).
 */

export type SecurityHeader = { key: string; value: string };

export function buildContentSecurityPolicy(isDev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${isDev ? " ws://127.0.0.1:* ws://localhost:*" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function buildSecurityHeaders(isDev: boolean): SecurityHeader[] {
  return [
    { key: "Content-Security-Policy", value: buildContentSecurityPolicy(isDev) },
    { key: "Referrer-Policy", value: "no-referrer" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
    },
  ];
}
