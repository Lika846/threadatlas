import type { NextConfig } from "next";
import { buildSecurityHeaders } from "./src/lib/security-headers";

const isDev = process.env.NODE_ENV !== "production";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  logging: {
    // Privacy (M2.3, A101): `next dev` prints every Server Function call with
    // its arguments by default, which would put search terms (and any state
    // passed back) in the terminal. Guarded by tests/next-config.test.ts and
    // the dev-mode check in e2e/dev-logging.spec.ts.
    serverFunctions: false,
  },
  // Project instructions live in CLAUDE.md; stop `next dev` from writing AGENTS.md.
  agentRules: false,
  experimental: {
    // Privacy (N1): by default (`"security"`) `next build` and `next dev` query
    // registry.npmjs.org for release and advisory metadata, and can stop with
    // upgrade instructions addressed to AI agents. Keep the build offline and
    // upgrade deliberately instead. Guarded by tests/next-config.test.ts.
    agentUpgrade: false,
  },
  turbopack: {
    // Pin the workspace root so a stray lockfile in a parent directory
    // (e.g. the home folder) is never treated as the project root.
    root: import.meta.dirname,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: buildSecurityHeaders(isDev) }];
  },
};

export default nextConfig;
