import { exceedsIdLength } from "../identifiers";
import { normalizeTimestamp } from "../timestamps";
import type {
  AdapterResult,
  ConversationCandidate,
  ImportIssue,
  NormalizedConversation,
  ParseResult,
} from "../types";
import { ADAPTER_NAME, ADAPTER_VERSION } from "./adapter";
import { computeContentHash } from "./content-hash";
import { buildTree } from "./tree";

/**
 * M1.2: turns a conversation accepted by the adapter (M1.1) into the
 * normalized shape that M1.4 will persist. Pure: no database, no logging.
 */

export type NormalizeOptions = {
  /** Import time in ms, used only to mark far-future timestamps as unusual. */
  nowMs?: number;
};

function conversationTime(
  value: unknown,
  field: string,
  nowMs: number,
  issues: ImportIssue[],
  base: Pick<ImportIssue, "index" | "sourceId">,
): number | null {
  const t = normalizeTimestamp(value, nowMs);
  if (t.status === "invalid") issues.push({ code: "TIMESTAMP_INVALID", ...base, field });
  if (t.status === "valid" && t.unusual) issues.push({ code: "TIMESTAMP_UNUSUAL", ...base, field });
  return t.status === "valid" ? t.seconds : null;
}

export function normalizeConversation(
  candidate: ConversationCandidate,
  opts: NormalizeOptions = {},
): { conversation: NormalizedConversation; issues: ImportIssue[] } {
  const nowMs = opts.nowMs ?? Date.now();
  const base = { index: candidate.index, sourceId: candidate.sourceId };
  const issues: ImportIssue[] = [];

  const title = candidate.title ?? null;
  const createdAt = conversationTime(candidate.createTime, "create_time", nowMs, issues, base);
  const updatedAt = conversationTime(candidate.updateTime, "update_time", nowMs, issues, base);
  const currentNode = candidate.currentNode ?? null;

  const tree = buildTree(candidate.mapping, currentNode, nowMs);
  for (const issue of tree.issues) issues.push({ ...issue, ...base });

  const visibleMessageCount = tree.nodes.filter(
    (n) => n.pathIndex !== null && !n.isStructural && !n.isHidden,
  ).length;

  return {
    conversation: {
      index: candidate.index,
      source: ADAPTER_NAME,
      sourceId: candidate.sourceId,
      idSource: candidate.idSource,
      parserVersion: ADAPTER_VERSION,
      title,
      createdAt,
      updatedAt,
      // Q12: an oversized current_node is not stored (tree.ts reports it). The
      // hash below still uses the validated source value, so hash v1 is unchanged.
      currentNodeSourceId: currentNode !== null && exceedsIdLength(currentNode) ? null : currentNode,
      pathStrategy: tree.pathStrategy,
      visibleMessageCount,
      nodeCount: tree.nodes.length,
      contentHash: computeContentHash({
        title,
        createTime: createdAt,
        updateTime: updatedAt,
        currentNode,
        mapping: candidate.mapping,
      }),
      nodes: tree.nodes,
    },
    issues,
  };
}

/** Applies M1.2 normalization to every accepted conversation of an adapter result. */
export function normalizeAdapterResult(
  result: AdapterResult,
  opts: NormalizeOptions = {},
): ParseResult {
  if (!result.ok) return result;
  const issues = [...result.issues];
  const conversations = result.accepted.map((candidate) => {
    const { conversation, issues: own } = normalizeConversation(candidate, opts);
    issues.push(...own);
    return conversation;
  });
  return {
    ok: true,
    adapter: result.adapter,
    adapterVersion: result.adapterVersion,
    conversationsSeen: result.conversationsSeen,
    conversations,
    flagged: result.flagged,
    skipped: result.skipped,
    issues,
  };
}
