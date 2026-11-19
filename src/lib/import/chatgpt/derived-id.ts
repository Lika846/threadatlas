import { createHash } from "node:crypto";
import { canonicalJson } from "../canonical-json";

/**
 * Deterministic IDs for conversations that have neither `conversation_id` nor
 * `id` (decision D21 / A16).
 *
 * STATUS: accepted as the provisional v1 fallback (A20, 2026-11-03). The
 * version is part of every ID, so a later change of algorithm cannot silently
 * collide with or re-map v1 IDs.
 *
 * Canonical form v1 is deliberately limited to fields that describe *what was
 * said*, so a conversation keeps its derived ID across exports even if the
 * export adds or changes metadata:
 *   - conversation `create_time` (raw value, or null)
 *   - for every mapping entry, sorted by key:
 *       key, node.parent, node.message.id, node.message.author.role,
 *       node.message.create_time, node.message.content (raw)
 * Excluded: title (renames), update_time and current_node (change without
 * content changing), all other and unknown fields.
 *
 * Canonical JSON: see `../canonical-json.ts`. Hash: SHA-256, hex.
 *
 * Documented limitation (A20c): editing or continuing an ID-less conversation
 * changes its derived ID, so a re-import yields a duplicate rather than an
 * update. No fuzzy matching is attempted in M1.
 */

export const DERIVED_ID_PREFIX = "derived:";
export const DERIVED_ID_VERSION = "v1";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pick(obj: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/** The v1 projection of a conversation that the derived ID is computed from. */
export function canonicalProjectionV1(
  createTime: unknown,
  mapping: Record<string, unknown>,
): { projection: unknown; hasContent: boolean } {
  let hasContent = false;
  const nodes = Object.keys(mapping)
    .sort()
    .map((key) => {
      const node = mapping[key];
      if (!isRecord(node)) return { key, node };
      const message = pick(node, "message");
      let projectedMessage: unknown = message;
      if (isRecord(message)) {
        const author = pick(message, "author");
        const content = pick(message, "content");
        if (content !== undefined && content !== null) hasContent = true;
        projectedMessage = {
          id: pick(message, "id"),
          role: isRecord(author) ? pick(author, "role") : undefined,
          create_time: pick(message, "create_time"),
          content,
        };
      }
      return { key, parent: pick(node, "parent"), message: projectedMessage };
    });
  return {
    projection: { create_time: createTime ?? null, nodes },
    hasContent,
  };
}

/**
 * Returns `derived:v1:<sha256>` or null when the conversation has no message
 * content to derive a meaningful identity from (then it is skipped with
 * CONVERSATION_ID_UNDERIVABLE rather than given a near-constant ID).
 */
export function deriveConversationId(
  createTime: unknown,
  mapping: Record<string, unknown>,
): string | null {
  const { projection, hasContent } = canonicalProjectionV1(createTime, mapping);
  if (!hasContent) return null;
  const digest = createHash("sha256")
    .update(canonicalJson(projection), "utf8")
    .digest("hex");
  return `${DERIVED_ID_PREFIX}${DERIVED_ID_VERSION}:${digest}`;
}
