/**
 * Message content extraction (plan §3 "Content types"; A27, A28).
 *
 * Output is plain text for display and search. It is never HTML and must
 * never be rendered as HTML.
 *
 * Supported content types (their meaning is fully captured as text):
 * - `text`: string parts joined with a blank line.
 * - `multimodal_text`: string parts kept; `image_asset_pointer` parts become
 *   `[image]`; any other object part becomes `[attachment: <type>]` and counts
 *   as unsupported.
 * - `code`: `text` kept exactly; `language` kept where available (A27).
 * - `execution_output`: `text` kept exactly.
 *
 * Everything else is **unsupported content**: string parts, or else a string
 * `text`, are extracted on a best-effort basis; otherwise the placeholder
 * `[unsupported content: <type>]` is inserted. Whenever content could not be
 * fully represented as text (`hasUnsupportedParts`), the original content
 * payload is kept in `rawContentJson` (A28, narrow exception to A4).
 *
 * Malformed content (A24) is marked, keeps only text that can be recovered
 * safely, and is never filled in with invented text.
 */

export type ExtractedContent = {
  contentType: string | null;
  text: string;
  codeLanguage: string | null;
  hasUnsupportedParts: boolean;
  isMalformed: boolean;
  rawContentJson: string | null;
};

export const SUPPORTED_CONTENT_TYPES = [
  "text",
  "multimodal_text",
  "code",
  "execution_output",
] as const;

const PART_SEPARATOR = "\n\n";
const SAFE_TYPE_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A type name shown in placeholders; anything unusual is shown as "unknown". */
export function displayTypeName(value: unknown): string {
  return typeof value === "string" && SAFE_TYPE_NAME.test(value) ? value : "unknown";
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const v = Object.hasOwn(obj, key) ? obj[key] : undefined;
  return typeof v === "string" ? v : undefined;
}

type PartsResult = { text: string; unsupported: boolean };

function joinParts(parts: unknown[], multimodal: boolean): PartsResult {
  let unsupported = false;
  const pieces = parts.map((part) => {
    if (typeof part === "string") return part;
    if (multimodal && isRecord(part)) {
      if (part.content_type === "image_asset_pointer") return "[image]";
      unsupported = true;
      return `[attachment: ${displayTypeName(part.content_type)}]`;
    }
    unsupported = true;
    return "[unsupported part]";
  });
  return { text: pieces.join(PART_SEPARATOR), unsupported };
}

/** Best-effort text: string parts, else a string `text`, else nothing. */
function recoverText(content: Record<string, unknown>): PartsResult | null {
  const parts = Object.hasOwn(content, "parts") ? content.parts : undefined;
  if (Array.isArray(parts)) return joinParts(parts, false);
  const text = stringField(content, "text");
  if (text !== undefined) return { text, unsupported: false };
  return null;
}

function result(
  partial: Partial<ExtractedContent> & { text: string },
  raw: unknown,
): ExtractedContent {
  const hasUnsupportedParts = partial.hasUnsupportedParts ?? false;
  return {
    contentType: partial.contentType ?? null,
    text: partial.text,
    codeLanguage: partial.codeLanguage ?? null,
    hasUnsupportedParts,
    isMalformed: partial.isMalformed ?? false,
    rawContentJson: hasUnsupportedParts ? (JSON.stringify(raw) ?? null) : null,
  };
}

export function extractContent(content: unknown): ExtractedContent {
  // Missing content: malformed, nothing to recover, nothing invented.
  if (content === undefined || content === null) {
    return result({ text: "", isMalformed: true }, content);
  }
  // A bare string is safely recoverable text.
  if (typeof content === "string") {
    return result({ text: content, isMalformed: true }, content);
  }
  // Numbers, booleans, arrays: unreadable; keep the payload.
  if (!isRecord(content)) {
    return result({ text: "", isMalformed: true, hasUnsupportedParts: true }, content);
  }

  const rawType = Object.hasOwn(content, "content_type") ? content.content_type : undefined;
  if (typeof rawType !== "string" || rawType.trim() === "") {
    const recovered = recoverText(content);
    return result(
      {
        text: recovered?.text ?? "",
        isMalformed: true,
        hasUnsupportedParts: true,
      },
      content,
    );
  }
  const contentType = rawType;

  switch (contentType) {
    case "text":
    case "multimodal_text": {
      const parts = Object.hasOwn(content, "parts") ? content.parts : undefined;
      if (Array.isArray(parts)) {
        const joined = joinParts(parts, contentType === "multimodal_text");
        return result(
          { contentType, text: joined.text, hasUnsupportedParts: joined.unsupported },
          content,
        );
      }
      const text = stringField(content, "text");
      return result(
        {
          contentType,
          text: text ?? "",
          isMalformed: true,
          hasUnsupportedParts: text === undefined,
        },
        content,
      );
    }
    case "code":
    case "execution_output": {
      const text = stringField(content, "text");
      const language = contentType === "code" ? stringField(content, "language") : undefined;
      const codeLanguage = language !== undefined && language.trim() !== "" ? language : null;
      if (text !== undefined) {
        return result({ contentType, text, codeLanguage }, content);
      }
      const recovered = recoverText(content);
      return result(
        {
          contentType,
          text: recovered?.text ?? "",
          codeLanguage,
          isMalformed: true,
          hasUnsupportedParts: true,
        },
        content,
      );
    }
    default: {
      const recovered = recoverText(content);
      const text =
        recovered !== null && recovered.text !== ""
          ? recovered.text
          : `[unsupported content: ${displayTypeName(contentType)}]`;
      return result({ contentType, text, hasUnsupportedParts: true }, content);
    }
  }
}
