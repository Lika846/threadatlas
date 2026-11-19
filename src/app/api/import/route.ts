import { handleImportRequest } from "@/lib/import/http";

/**
 * Import upload (M1.5). Excluded from `src/proxy.ts`, because the proxy
 * buffers request bodies and silently truncates them past 10 MB (measured in
 * M1.5 step 0); `handleImportRequest` performs the Host, Origin and CSRF
 * checks itself, before reading the body. Other methods get Next.js's 405.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleImportRequest(request);
}
