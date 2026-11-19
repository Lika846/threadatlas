import { createHash } from "node:crypto";
import type { FileError } from "./types";

/** 50 MiB (A2, A10). */
export const DEFAULT_IMPORT_MAX_BYTES = 52_428_800;

/**
 * Reads the upload limit from `IMPORT_MAX_BYTES`. A misconfigured value is a
 * configuration error, so it throws instead of silently falling back.
 */
export function getImportMaxBytes(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.IMPORT_MAX_BYTES;
  if (raw === undefined || raw.trim() === "") return DEFAULT_IMPORT_MAX_BYTES;
  if (!/^[0-9]+$/.test(raw.trim())) {
    throw new Error("IMPORT_MAX_BYTES must be a positive integer number of bytes.");
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("IMPORT_MAX_BYTES must be a positive integer number of bytes.");
  }
  return value;
}

export type ReadResult = { ok: true; text: string } | { ok: false; error: FileError };

/** A successful upload read: the text plus the SHA-256 (hex) and size of the bytes as received. */
export type UploadReadResult =
  | { ok: true; text: string; sha256: string; byteLength: number }
  | { ok: false; error: FileError };

/**
 * Reads a byte stream into text while enforcing `maxBytes` incrementally:
 * reading stops (and the stream is cancelled) as soon as the limit is
 * exceeded, so an oversized upload is never fully buffered (A10).
 *
 * `declaredLength` (e.g. Content-Length) allows rejecting before reading, but
 * is never trusted on its own: the byte count is always enforced. When it is
 * given, the bytes read must match it exactly, or the upload is
 * `FILE_INCOMPLETE` (M1.5: a proxy can silently deliver a truncated body while
 * keeping the original Content-Length, measured in M1.5 step 0).
 * On success it also returns the SHA-256 and byte count of the bytes as
 * received (for `ImportBatch.sourceSha256` / `sourceBytes`), hashed while
 * reading. The bytes themselves are never stored (A4).
 * Never logs or returns any of the content on failure.
 */
export async function readUploadStream(
  stream: ReadableStream<Uint8Array> | null,
  opts: { maxBytes: number; declaredLength?: number | null },
): Promise<UploadReadResult> {
  const { maxBytes, declaredLength } = opts;
  if (
    typeof declaredLength === "number" &&
    Number.isFinite(declaredLength) &&
    declaredLength > maxBytes
  ) {
    await stream?.cancel().catch(() => {});
    return { ok: false, error: { code: "FILE_TOO_LARGE" } };
  }
  if (stream === null) return { ok: false, error: { code: "FILE_EMPTY" } };

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  const hash = createHash("sha256");
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, error: { code: "FILE_TOO_LARGE" } };
      }
      chunks.push(value);
      hash.update(value);
    }
  } catch {
    return { ok: false, error: { code: "FILE_READ_FAILED" } };
  } finally {
    reader.releaseLock();
  }

  if (typeof declaredLength === "number" && Number.isFinite(declaredLength) && total !== declaredLength) {
    return { ok: false, error: { code: "FILE_INCOMPLETE" } };
  }
  if (total === 0) return { ok: false, error: { code: "FILE_EMPTY" } };
  const decoded = decodeUtf8(concat(chunks, total));
  if (!decoded.ok) return decoded;
  return { ok: true, text: decoded.text, sha256: hash.digest("hex"), byteLength: total };
}

/** Decodes strict UTF-8 (invalid bytes are an error, a leading BOM is removed). */
export function decodeUtf8(bytes: Uint8Array): ReadResult {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ok: true, text };
  } catch {
    return { ok: false, error: { code: "FILE_NOT_UTF8" } };
  }
}

export type ParseResult = { ok: true; data: unknown } | { ok: false; error: FileError };

/**
 * Parses JSON. The parser's own error message (which may quote content) is discarded.
 *
 * Depth (F2): V8's `JSON.parse` is iterative (verified on Node 24 with 26
 * million nested arrays, the most a 50 MiB file can hold), so nesting alone
 * does not make parsing fail. If a runtime does run out of stack while
 * parsing (a `RangeError`), the file is reported as FILE_TOO_DEEP rather than
 * as invalid JSON.
 */
export function parseJsonText(text: string): ParseResult {
  if (text.trim() === "") return { ok: false, error: { code: "FILE_EMPTY" } };
  try {
    return { ok: true, data: JSON.parse(text) as unknown };
  } catch (e) {
    if (e instanceof RangeError) return { ok: false, error: { code: "FILE_TOO_DEEP" } };
    return { ok: false, error: { code: "FILE_INVALID_JSON" } };
  }
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
