import { describe, expect, it } from "vitest";
import {
  buildContentSecurityPolicy,
  buildSecurityHeaders,
} from "./security-headers";

function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp.split(";").map((d) => {
      const [name = "", ...sources] = d.trim().split(/\s+/);
      return [name, sources];
    }),
  );
}

describe("buildContentSecurityPolicy", () => {
  const fetchDirectives = [
    "default-src",
    "img-src",
    "font-src",
    "connect-src",
    "form-action",
  ];

  it.each([false, true])(
    "never allows third-party hosts (isDev=%s)",
    (isDev) => {
      const parsed = directives(buildContentSecurityPolicy(isDev));
      for (const name of fetchDirectives) {
        const sources = parsed.get(name);
        expect(sources, `${name} missing`).toBeDefined();
        for (const source of sources ?? []) {
          // Only same-origin, inline data, or local dev websockets.
          expect(source).toMatch(
            /^('self'|data:|blob:|ws:\/\/(127\.0\.0\.1|localhost):\*)$/,
          );
        }
      }
    },
  );

  it("excludes dev-only relaxations in production", () => {
    const csp = buildContentSecurityPolicy(false);
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("ws:");
    expect(directives(csp).get("connect-src")).toEqual(["'self'"]);
  });

  it("blocks plugins, framing and base-tag hijacking", () => {
    const parsed = directives(buildContentSecurityPolicy(false));
    expect(parsed.get("object-src")).toEqual(["'none'"]);
    expect(parsed.get("frame-ancestors")).toEqual(["'none'"]);
    expect(parsed.get("base-uri")).toEqual(["'self'"]);
  });
});

describe("buildSecurityHeaders", () => {
  it("sends a no-referrer policy so links never leak the local URL", () => {
    const headers = new Map(
      buildSecurityHeaders(false).map((h) => [h.key, h.value]),
    );
    expect(headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.has("Content-Security-Policy")).toBe(true);
  });
});
