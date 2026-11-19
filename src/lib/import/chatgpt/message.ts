import { exceedsIdLength } from "../identifiers";
import { normalizeTimestamp } from "../timestamps";
import { extractContent } from "./content";

/**
 * Interprets one mapping node's `message` field.
 *
 * - Absent or `null` → **structural node** (A29). Structural nodes are never
 *   displayed as messages and are never hidden or malformed.
 * - Present but not an object, or with unreadable content → **malformed
 *   message** (A24): kept as a message, marked, with only safely recoverable
 *   text and a warning. Nothing is invented.
 * - Role is kept exactly as exported, including unknown roles. A missing or
 *   non-string role is null with a warning; it does **not** make the node
 *   structural (A29).
 * - Hidden by default (A26): every message whose role is exactly `"system"`,
 *   and every message with `metadata.is_visually_hidden_from_conversation`
 *   strictly `true`.
 */

export type NodeIssueCode =
  | "MESSAGE_MALFORMED"
  | "MESSAGE_ROLE_MISSING"
  | "CONTENT_UNSUPPORTED"
  | "TIMESTAMP_INVALID"
  | "TIMESTAMP_UNUSUAL"
  | "NODE_REFERENCE_TOO_LONG";

export type ParsedMessage = {
  isStructural: boolean;
  isMalformed: boolean;
  sourceMessageId: string | null;
  role: string | null;
  authorName: string | null;
  contentType: string | null;
  contentText: string;
  codeLanguage: string | null;
  hasUnsupportedParts: boolean;
  rawContentJson: string | null;
  isHidden: boolean;
  status: string | null;
  createdAt: number | null;
};

type Report = (code: NodeIssueCode, field?: string) => void;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function get(obj: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

function optionalString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

const STRUCTURAL: ParsedMessage = {
  isStructural: true,
  isMalformed: false,
  sourceMessageId: null,
  role: null,
  authorName: null,
  contentType: null,
  contentText: "",
  codeLanguage: null,
  hasUnsupportedParts: false,
  rawContentJson: null,
  isHidden: false,
  status: null,
  createdAt: null,
};

/** `message.id`, or null if missing, blank or longer than MAX_ID_LENGTH (Q12; never shortened). */
function messageId(rawId: unknown, report: Report): string | null {
  if (typeof rawId !== "string" || rawId.trim() === "") return null;
  if (exceedsIdLength(rawId)) {
    report("NODE_REFERENCE_TOO_LONG", "message.id");
    return null;
  }
  return rawId;
}

export function parseMessage(message: unknown, nowMs: number, report: Report): ParsedMessage {
  if (message === undefined || message === null) return { ...STRUCTURAL };

  if (!isRecord(message)) {
    // A message that is not an object: keep a bare string as recoverable text;
    // keep any other payload as raw content. Never treated as structural.
    const recoverable = typeof message === "string";
    report("MESSAGE_MALFORMED");
    if (!recoverable) report("CONTENT_UNSUPPORTED");
    return {
      ...STRUCTURAL,
      isStructural: false,
      isMalformed: true,
      contentText: recoverable ? message : "",
      hasUnsupportedParts: !recoverable,
      rawContentJson: recoverable ? null : (JSON.stringify(message) ?? null),
    };
  }

  const author = get(message, "author");
  const rawRole = isRecord(author) ? get(author, "role") : undefined;
  const role = typeof rawRole === "string" ? rawRole : null;
  if (role === null) report("MESSAGE_ROLE_MISSING");
  const authorName = isRecord(author) ? optionalString(get(author, "name")) : null;

  const time = normalizeTimestamp(get(message, "create_time"), nowMs);
  if (time.status === "invalid") report("TIMESTAMP_INVALID", "message.create_time");
  if (time.status === "valid" && time.unusual) report("TIMESTAMP_UNUSUAL", "message.create_time");

  const content = extractContent(get(message, "content"));
  if (content.isMalformed) report("MESSAGE_MALFORMED");
  if (content.hasUnsupportedParts) report("CONTENT_UNSUPPORTED");

  const metadata = get(message, "metadata");
  const visuallyHidden =
    isRecord(metadata) && get(metadata, "is_visually_hidden_from_conversation") === true;

  const rawId = get(message, "id");
  return {
    isStructural: false,
    isMalformed: content.isMalformed,
    sourceMessageId: messageId(rawId, report),
    role,
    authorName,
    contentType: content.contentType,
    contentText: content.text,
    codeLanguage: content.codeLanguage,
    hasUnsupportedParts: content.hasUnsupportedParts,
    rawContentJson: content.rawContentJson,
    isHidden: role === "system" || visuallyHidden,
    status: optionalString(get(message, "status")),
    createdAt: time.status === "valid" ? time.seconds : null,
  };
}
