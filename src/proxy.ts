import type { NextRequest } from "next/server";
import { checkRequestHost } from "@/lib/host-validation";

/**
 * Runs before every request except `POST /api/import` (see `config`): pages,
 * RSC payloads, static assets and Server Function POSTs. Rejects any request
 * whose Host is not a loopback name, which blocks DNS-rebinding attacks
 * (plan amendment A6).
 *
 * Server Functions and Route Handlers must still do their own Host/Origin
 * checks (A11, A13). Next.js docs warn that proxy coverage can silently change
 * when a matcher or route changes; `e2e/import.spec.ts` pins it down.
 */
export function proxy(request: NextRequest): Response | undefined {
  const result = checkRequestHost(request.headers);
  if (result.ok) return undefined;

  // The rejected Host value is not echoed back or logged.
  return new Response(
    "Forbidden: ThreadAtlas only answers requests addressed to 127.0.0.1 or localhost.\n",
    {
      status: 403,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

/**
 * Exactly `/api/import` is excluded (A14, D19): with a proxy, Next.js buffers
 * the request body and passes only the first 10 MB to the route, without an
 * error (measured in M1.5 step 0). That route checks Host and Origin itself.
 * Measured: case variants, encoded characters, suffixes and extra segments
 * still run the proxy; `/api/import/` and `//api/import` redirect (308) to
 * `/api/import`; `/api/./import` is normalised to it.
 */
export const config = {
  matcher: ["/((?!api/import$).*)"],
};
