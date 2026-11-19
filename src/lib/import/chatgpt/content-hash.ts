import { createHash } from "node:crypto";
import { canonicalJson } from "../canonical-json";

/**
 * Versioned content hash (A21) used for idempotent re-imports (M1.4).
 *
 * Canonical representation v1 of the **validated source conversation**:
 *
 *   { "v": 1,
 *     "title":        validated title, or null (absent, null or wrong type),
 *     "create_time":  validated epoch seconds (A22), or null,
 *     "update_time":  validated epoch seconds (A22), or null,
 *     "current_node": validated string, or null,
 *     "mapping":      the mapping exactly as exported }
 *
 * - The mapping is included **whole**: every node, message, content payload,
 *   author and message metadata, and any unknown node-level field. Any change
 *   anywhere in the message tree therefore changes the hash (conservative: an
 *   update is never missed).
 * - Conversation-level fields outside the four above are excluded, because
 *   ThreadAtlas does not store them (e.g. `is_archived`, model slugs, the
 *   fixture marker `_synthetic`).
 * - The conversation ID is not hashed; it is the key the hash is compared
 *   under.
 * - **Import-specific metadata is never an input**: batch IDs, import time,
 *   file name, file hash and parser version.
 * - Serialisation: `canonicalJson` (sorted keys, no whitespace, no Unicode
 *   normalisation). Hash: SHA-256, hex, prefixed with the version.
 */

export const CONTENT_HASH_VERSION = "v1";

export type ContentHashInput = {
  title: string | null;
  createTime: number | null;
  updateTime: number | null;
  currentNode: string | null;
  mapping: Record<string, unknown>;
};

export function canonicalContentV1(input: ContentHashInput): string {
  return canonicalJson({
    v: 1,
    title: input.title,
    create_time: input.createTime,
    update_time: input.updateTime,
    current_node: input.currentNode,
    mapping: input.mapping,
  });
}

export function computeContentHash(input: ContentHashInput): string {
  const digest = createHash("sha256").update(canonicalContentV1(input), "utf8").digest("hex");
  return `${CONTENT_HASH_VERSION}:${digest}`;
}
