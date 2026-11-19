import { z } from "zod";
import type {
  AdapterResult,
  ConversationCandidate,
  DuplicateGroupSummary,
  FlaggedConversation,
  IdSource,
  ImportIssue,
  SkippedConversation,
} from "../types";
import { exceedsJsonDepth, MAX_JSON_DEPTH } from "../canonical-json";
import { exceedsIdLength } from "../identifiers";
import { validSeconds } from "../timestamps";
import { DERIVED_ID_PREFIX, deriveConversationId } from "./derived-id";

/**
 * ChatGPT `conversations.json` adapter: file- and conversation-level
 * validation (M1.1). Node-level tree reconstruction and content extraction are
 * in `normalize.ts` (M1.2).
 *
 * Version tolerance (A1, A17):
 * - Unknown fields are ignored and never fail a conversation.
 * - A known *optional* field with an unexpected type is ignored with a
 *   FIELD_INVALID_TYPE warning; the conversation is still accepted.
 * - Only structural requirements skip a conversation: it must be an object
 *   with an object `mapping`, it must have a usable identity, it must not
 *   nest deeper than `CONVERSATION_MAX_DEPTH` (F2), and no mapping key or
 *   `parent` reference may exceed MAX_ID_LENGTH (Q12).
 * - The mapping is passed through complete and unmodified (every branch and
 *   every structural node is preserved).
 */

export const ADAPTER_NAME = "chatgpt" as const;
/** Parser version, stored with imported rows so later versions can reprocess them (A28). */
export const ADAPTER_VERSION = "0.3.0";

/**
 * Nesting limit for one conversation object (F2). The export's top-level
 * array is level 1, so a conversation may use the remaining levels: no
 * object/array anywhere in the file is deeper than `MAX_JSON_DEPTH`.
 */
export const CONVERSATION_MAX_DEPTH = MAX_JSON_DEPTH - 1;

/** Most copy positions listed in one duplicate-group issue (F3). */
export const DUPLICATE_SAMPLE_LIMIT = 10;

const ConversationObject = z.record(z.string(), z.unknown());
const Mapping = z.record(z.string(), z.unknown());
const NonBlankString = z.string().refine((s) => s.trim().length > 0);
const Timestamp = z.union([z.number(), z.string()]).nullable();

const OPTIONAL_FIELDS = {
  conversation_id: NonBlankString,
  id: NonBlankString,
  title: z.string().nullable(),
  current_node: z.string().nullable(),
  create_time: Timestamp,
  update_time: Timestamp,
} as const;

type OptionalFieldName = keyof typeof OPTIONAL_FIELDS;

function readOptional<K extends OptionalFieldName>(
  obj: Record<string, unknown>,
  field: K,
  index: number,
  issues: ImportIssue[],
): z.infer<(typeof OPTIONAL_FIELDS)[K]> | undefined {
  if (!Object.hasOwn(obj, field)) return undefined;
  const parsed = OPTIONAL_FIELDS[field].safeParse(obj[field]);
  if (parsed.success) return parsed.data as z.infer<(typeof OPTIONAL_FIELDS)[K]>;
  issues.push({ code: "FIELD_INVALID_TYPE", index, field });
  return undefined;
}

/**
 * Update time for duplicate ordering. Uses the shared timestamp rule (A22,
 * A30): only finite, representable values count, so a copy whose time is
 * missing or invalid can never "win".
 */
/**
 * The first mapping key or `parent` string longer than MAX_ID_LENGTH, as a
 * location only (the identifier itself is never returned). Child entries,
 * `message.id` and `current_node` are not checked here: they cannot change
 * the tree, so tree.ts ignores oversized ones with a warning.
 */
function findOversizedNodeId(
  mapping: Record<string, unknown>,
): { field: "mapping"; nodeId?: never } | { field: "parent"; nodeId: string } | null {
  for (const key of Object.keys(mapping)) {
    if (exceedsIdLength(key)) return { field: "mapping" };
  }
  for (const key of Object.keys(mapping)) {
    const value = mapping[key];
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const parent: unknown = Object.hasOwn(value, "parent") ? (value as Record<string, unknown>).parent : undefined;
    if (typeof parent === "string" && exceedsIdLength(parent)) return { field: "parent", nodeId: key };
  }
  return null;
}

function orderingTime(value: number | string | null | undefined): number | undefined {
  return validSeconds(value);
}

export function parseChatGptExport(data: unknown): AdapterResult {
  if (!Array.isArray(data)) {
    return { ok: false, error: { code: "FILE_UNSUPPORTED_STRUCTURE" } };
  }
  if (data.length === 0) {
    return { ok: false, error: { code: "FILE_NO_CONVERSATIONS" } };
  }

  const issues: ImportIssue[] = [];
  const skipped: SkippedConversation[] = [];
  const flagged: FlaggedConversation[] = [];
  const candidates: ConversationCandidate[] = [];

  data.forEach((entry: unknown, index) => {
    const objResult = ConversationObject.safeParse(entry);
    if (!objResult.success) {
      skipped.push({ index, code: "CONVERSATION_NOT_OBJECT" });
      issues.push({ code: "CONVERSATION_NOT_OBJECT", index });
      return;
    }
    const obj = objResult.data;

    // Identity, part 1: explicit IDs (D21: conversation_id, then id).
    const conversationId = readOptional(obj, "conversation_id", index, issues);
    const plainId = readOptional(obj, "id", index, issues);
    // Q12: the ID that would be used must not exceed MAX_ID_LENGTH. An
    // oversized one is never shortened and never replaced by `id` or a derived
    // ID, so the conversation is skipped; the ID itself is not reported.
    let sourceId: string | undefined;
    let idSource: IdSource | undefined;
    if (conversationId !== undefined) {
      if (exceedsIdLength(conversationId)) {
        skipped.push({ index, code: "CONVERSATION_ID_TOO_LONG" });
        issues.push({ code: "CONVERSATION_ID_TOO_LONG", index, field: "conversation_id" });
        return;
      }
      sourceId = conversationId;
      idSource = "conversation_id";
      if (plainId !== undefined && exceedsIdLength(plainId)) {
        issues.push({ code: "FIELD_TOO_LONG", index, sourceId, field: "id" });
      } else if (plainId !== undefined && plainId !== conversationId) {
        issues.push({ code: "CONVERSATION_ID_MISMATCH", index, sourceId });
      }
    } else if (plainId !== undefined) {
      if (exceedsIdLength(plainId)) {
        skipped.push({ index, code: "CONVERSATION_ID_TOO_LONG" });
        issues.push({ code: "CONVERSATION_ID_TOO_LONG", index, field: "id" });
        return;
      }
      sourceId = plainId;
      idSource = "id";
    }

    // Nesting limit (F2): checked iteratively before anything recursive (the
    // derived ID, the content hash, raw payload serialisation) sees the data.
    // Only this conversation is skipped; the rest of the file is unaffected.
    if (exceedsJsonDepth(obj, CONVERSATION_MAX_DEPTH)) {
      skipped.push({ index, code: "CONVERSATION_TOO_DEEP", sourceId });
      issues.push({ code: "CONVERSATION_TOO_DEEP", index, sourceId });
      return;
    }

    // Structure: an object mapping is required.
    if (!Object.hasOwn(obj, "mapping")) {
      skipped.push({ index, code: "CONVERSATION_MAPPING_MISSING", sourceId });
      issues.push({ code: "CONVERSATION_MAPPING_MISSING", index, sourceId });
      return;
    }
    const mappingResult = Mapping.safeParse(obj.mapping);
    if (!mappingResult.success) {
      skipped.push({ index, code: "CONVERSATION_MAPPING_INVALID", sourceId });
      issues.push({ code: "CONVERSATION_MAPPING_INVALID", index, sourceId });
      return;
    }
    const mapping = mappingResult.data;

    // Q12: an oversized mapping key or `parent` would have to be dropped or
    // nulled, which loses messages or turns nodes into false roots. The tree
    // would look complete when it is not, so the conversation is skipped.
    const oversized = findOversizedNodeId(mapping);
    if (oversized !== null) {
      skipped.push({ index, code: "CONVERSATION_NODE_ID_TOO_LONG", sourceId });
      issues.push({ code: "CONVERSATION_NODE_ID_TOO_LONG", index, sourceId, ...oversized });
      return;
    }

    const title = readOptional(obj, "title", index, issues);
    const createTime = readOptional(obj, "create_time", index, issues);
    const updateTime = readOptional(obj, "update_time", index, issues);
    const currentNode = readOptional(obj, "current_node", index, issues);

    // Identity, part 2: derive when no explicit ID exists (proposal v1, Q11).
    if (sourceId === undefined) {
      const derived = deriveConversationId(createTime, mapping);
      if (derived === null) {
        skipped.push({ index, code: "CONVERSATION_ID_UNDERIVABLE" });
        issues.push({ code: "CONVERSATION_ID_UNDERIVABLE", index });
        return;
      }
      sourceId = derived;
      idSource = "derived";
      issues.push({ code: "CONVERSATION_ID_DERIVED", index, sourceId });
    } else if (sourceId.startsWith(DERIVED_ID_PREFIX)) {
      flagged.push({
        index,
        code: "CONVERSATION_ID_RESERVED",
        sourceId,
        idSource: idSource ?? "id",
      });
      issues.push({ code: "CONVERSATION_ID_RESERVED", index, sourceId });
      return;
    }

    candidates.push({
      index,
      sourceId,
      idSource: idSource ?? "derived",
      title,
      createTime,
      updateTime,
      currentNode,
      mapping,
    });
  });

  const accepted = resolveDuplicates(candidates, skipped, flagged, issues);

  return {
    ok: true,
    adapter: ADAPTER_NAME,
    adapterVersion: ADAPTER_VERSION,
    conversationsSeen: data.length,
    accepted,
    flagged: flagged.sort((a, b) => a.index - b.index),
    skipped: skipped.sort((a, b) => a.index - b.index),
    issues,
  };
}

/**
 * Within one file:
 * - Explicit ID seen twice or more: keep the copy with the strictly latest
 *   update time (others skipped with DUPLICATE_ID_SUPERSEDED, plan §3). If the
 *   latest cannot be determined (missing/unparsable or tied times), all
 *   copies are flagged with DUPLICATE_ID_AMBIGUOUS. Times are compared only
 *   when every copy's time is valid (A22).
 * - Derived ID seen twice or more (identical canonical content): all copies
 *   are flagged with CONVERSATION_ID_AMBIGUOUS, never merged (D21).
 *
 * Reporting (F3): each copy still gets its own `skipped`/`flagged` entry, so
 * counts stay exact, but each group produces **one** issue with a bounded
 * summary (`DuplicateGroupSummary`) instead of one issue per copy listing all
 * the others. Work and report size are linear in the number of conversations.
 */
function resolveDuplicates(
  candidates: ConversationCandidate[],
  skipped: SkippedConversation[],
  flagged: FlaggedConversation[],
  issues: ImportIssue[],
): ConversationCandidate[] {
  // Candidates are in file order, so every group lists its copies in ascending index order.
  const groups = new Map<string, ConversationCandidate[]>();
  for (const c of candidates) {
    const group = groups.get(c.sourceId);
    if (group) group.push(c);
    else groups.set(c.sourceId, [c]);
  }

  const removed = new Set<number>();
  for (const [sourceId, group] of groups) {
    if (group.length < 2) continue;

    const summary = (keptIndex?: number): DuplicateGroupSummary => ({
      occurrences: group.length,
      sampleIndices: group.slice(0, DUPLICATE_SAMPLE_LIMIT).map((c) => c.index),
      truncated: group.length > DUPLICATE_SAMPLE_LIMIT,
      ...(keptIndex === undefined ? {} : { keptIndex }),
    });

    const flagAll = (code: "DUPLICATE_ID_AMBIGUOUS" | "CONVERSATION_ID_AMBIGUOUS") => {
      for (const c of group) {
        removed.add(c.index);
        flagged.push({ index: c.index, code, sourceId, idSource: c.idSource });
      }
      issues.push({ code, sourceId, duplicateGroup: summary() });
    };

    if (group.every((c) => c.idSource === "derived")) {
      flagAll("CONVERSATION_ID_AMBIGUOUS");
      continue;
    }

    const keep = strictlyLatest(group);
    if (keep === undefined) {
      flagAll("DUPLICATE_ID_AMBIGUOUS");
      continue;
    }
    for (const c of group) {
      if (c === keep) continue;
      removed.add(c.index);
      skipped.push({ index: c.index, code: "DUPLICATE_ID_SUPERSEDED", sourceId });
    }
    issues.push({ code: "DUPLICATE_ID_SUPERSEDED", sourceId, duplicateGroup: summary(keep.index) });
  }

  return candidates.filter((c) => !removed.has(c.index));
}

/**
 * The copy with the strictly latest valid update time, in one pass. Undefined
 * when any copy's time is missing or invalid, or when the latest time is tied.
 */
function strictlyLatest(group: ConversationCandidate[]): ConversationCandidate | undefined {
  let best: ConversationCandidate | undefined;
  let bestTime = -Infinity;
  let tied = false;
  for (const c of group) {
    const t = orderingTime(c.updateTime);
    if (t === undefined) return undefined;
    if (t > bestTime) {
      best = c;
      bestTime = t;
      tied = false;
    } else if (t === bestTime) {
      tied = true;
    }
  }
  return tied ? undefined : best;
}
