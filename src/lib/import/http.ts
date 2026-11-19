import { getDb, type DbClient } from "../db/client";
import { checkSameOriginRequest, IMPORT_REQUEST_HEADER } from "../request-guards";
import { importExportStream, type ImportDeps } from "./import-service";
import { getImportMaxBytes } from "./read-upload";
import { BATCH_SUMMARY_SELECT, batchSummary, errorBody, type BatchRow, type ImportResponseBody } from "./summary";

/**
 * `POST /api/import` (M1.5). The route excluded from `src/proxy.ts` (A14,
 * D19), so it performs every request check itself:
 *
 *   headers only: Host, Origin, Sec-Fetch-Site, custom header, content type
 *   → Content-Length required (411) and within the limit (413)
 *   → stream the body through the M1.4 import service (size limit while
 *     reading, bytes must equal Content-Length, SHA-256, parse, persist)
 *   → 200 with the stored batch's summary (503 IMPORT_SUMMARY_UNAVAILABLE if
 *     the stored row can't be read), or an error code
 *
 * Never throws (Next.js prints uncaught route errors, message and stack, to
 * the server log, measured in M1.5 step 0) and never logs. Responses carry
 * codes, static messages, counts and the bounded local report only.
 */

export const IMPORT_FILENAME_HEADER = "x-threadatlas-filename";
const MAX_FILENAME_HEADER = 2_048;

export type ImportHttpDeps = {
  /** Injected in tests; the app uses the process-wide writer. */
  importDeps?: ImportDeps;
  /** Reader connection for the stored summary (default `getDb()`). */
  readDb?: () => DbClient;
  env?: Record<string, string | undefined>;
};

function respond(status: number, body: ImportResponseBody): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/** HTTP status for an outcome without a batch row. */
export function statusForCode(code: string): number {
  if (code === "FILE_TOO_LARGE") return 413;
  if (code.startsWith("FILE_")) return 400;
  if (code === "IMPORT_BUSY") return 409;
  if (code === "IMPORT_LOCK_FAILED" || code.startsWith("DB_")) return 503;
  return 500;
}

function filenameFrom(headers: Headers): string {
  const raw = headers.get(IMPORT_FILENAME_HEADER);
  if (raw === null || raw.length > MAX_FILENAME_HEADER) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}

export async function handleImportRequest(request: Request, deps: ImportHttpDeps = {}): Promise<Response> {
  try {
    const guard = checkSameOriginRequest(request.headers, { customHeader: IMPORT_REQUEST_HEADER, contentType: "application/json" });
    if (!guard.ok) return respond(guard.status, errorBody(guard.code));

    const length = request.headers.get("content-length");
    if (length === null || !/^[0-9]{1,16}$/.test(length)) return respond(411, errorBody("REQUEST_LENGTH_REQUIRED"));
    const declared = Number(length);

    let maxBytes: number;
    try {
      maxBytes = getImportMaxBytes(deps.env ?? process.env);
    } catch {
      return respond(500, errorBody("IMPORT_CONFIG_INVALID"));
    }
    if (declared > maxBytes) return respond(413, errorBody("FILE_TOO_LARGE"));

    const outcome = await importExportStream(
      request.body,
      { maxBytes, declaredLength: declared, filename: filenameFrom(request.headers) },
      deps.importDeps,
    );
    if (outcome.batchId === null) {
      const code = outcome.errorCode ?? "IMPORT_INTERNAL_ERROR";
      return respond(statusForCode(code), errorBody(code));
    }

    // The summary is only ever built from the stored row. If it can't be read,
    // say so: never construct one from in-memory values.
    let row: BatchRow | null;
    try {
      row = await (deps.readDb ?? getDb)().importBatch.findUnique({ where: { id: outcome.batchId }, select: BATCH_SUMMARY_SELECT });
    } catch {
      row = null;
    }
    if (row === null) return respond(503, errorBody("IMPORT_SUMMARY_UNAVAILABLE"));
    return respond(200, { ok: true, batch: batchSummary(row) });
  } catch {
    return respond(500, errorBody("IMPORT_INTERNAL_ERROR"));
  }
}
