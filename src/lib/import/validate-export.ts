import { parseChatGptExport } from "./chatgpt/adapter";
import { normalizeAdapterResult, type NormalizeOptions } from "./chatgpt/normalize";
import { parseJsonText, readUploadStream } from "./read-upload";
import type { AdapterResult, ParseResult } from "./types";

/**
 * Upload pipeline: bytes (size-limited while reading) → strict UTF-8 → JSON →
 * ChatGPT adapter (M1.1, file and conversation level) → normalization (M1.2,
 * tree, path and content). Pure apart from reading the stream; no database,
 * no disk, no logging of content.
 */
export async function validateExportStream(
  stream: ReadableStream<Uint8Array> | null,
  opts: { maxBytes: number; declaredLength?: number | null },
): Promise<AdapterResult> {
  const read = await readUploadStream(stream, opts);
  if (!read.ok) return read;
  return validateExportText(read.text);
}

export function validateExportText(text: string): AdapterResult {
  const parsed = parseJsonText(text);
  if (!parsed.ok) return parsed;
  return parseChatGptExport(parsed.data);
}

export async function parseExportStream(
  stream: ReadableStream<Uint8Array> | null,
  opts: { maxBytes: number; declaredLength?: number | null } & NormalizeOptions,
): Promise<ParseResult> {
  return normalizeAdapterResult(await validateExportStream(stream, opts), opts);
}

export function parseExportText(text: string, opts: NormalizeOptions = {}): ParseResult {
  return normalizeAdapterResult(validateExportText(text), opts);
}
