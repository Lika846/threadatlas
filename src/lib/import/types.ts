import type { DbErrorCode } from "../db/errors";
import type { FileErrorCode, IssueCode } from "./errors";

/**
 * A reported problem. It never contains message text, titles or other imported
 * content: only a code, the conversation's position in the file, optionally
 * its source ID, and a field name or related positions.
 */
export type ImportIssue = {
  code: IssueCode;
  /** 0-based position of the conversation in the export array. */
  index?: number;
  /** Source or derived conversation ID (an identifier, not content). */
  sourceId?: string;
  /** Name of the offending field (FIELD_INVALID_TYPE, TIMESTAMP_*). */
  field?: string;
  /**
   * Duplicate-ID group issues only (F3): one issue per group, without `index`.
   * Bounded in size however many copies the file contains.
   */
  duplicateGroup?: DuplicateGroupSummary;
  /** Mapping key of the node concerned (an identifier, not content). */
  nodeId?: string;
  /** Mapping key of another node involved (e.g. the listing parent). */
  relatedNodeId?: string;
  /** CONVERSATION_PERSIST_FAILED only: the sanitised database error code (never the error itself). */
  errorCode?: DbErrorCode;
};

/**
 * One duplicate-ID group (DUPLICATE_ID_SUPERSEDED, DUPLICATE_ID_AMBIGUOUS,
 * CONVERSATION_ID_AMBIGUOUS). Every copy also has its own `skipped` or
 * `flagged` entry, so exact counts come from those lists.
 */
export type DuplicateGroupSummary = {
  /** Copies of this ID that reached duplicate resolution (copies skipped earlier for another reason are not counted). */
  occurrences: number;
  /** Positions of the first copies in file order, at most 10 (`DUPLICATE_SAMPLE_LIMIT`). */
  sampleIndices: number[];
  /** True when `occurrences` is larger than `sampleIndices.length`. */
  truncated: boolean;
  /** Position of the copy that was kept (DUPLICATE_ID_SUPERSEDED only); may lie outside the sample. */
  keptIndex?: number;
};

export type FileError = { code: FileErrorCode };

export type IdSource = "conversation_id" | "id" | "derived";

/**
 * A conversation that passed conversation-level validation.
 *
 * `mapping` is passed through **unchanged and complete**: every node is kept,
 * including structural nodes (`message: null`), every branch, and nodes that
 * are later found to dangle or form cycles. Node-level interpretation happens
 * in M1.2 (tree.ts / content.ts), never by dropping entries here.
 */
export type ConversationCandidate = {
  index: number;
  sourceId: string;
  idSource: IdSource;
  /** undefined = absent; null = explicitly null in the export. */
  title: string | null | undefined;
  createTime: number | string | null | undefined;
  updateTime: number | string | null | undefined;
  currentNode: string | null | undefined;
  mapping: Record<string, unknown>;
};

export type FlaggedConversation = {
  index: number;
  code: IssueCode;
  sourceId: string;
  idSource: IdSource;
};

export type SkippedConversation = {
  index: number;
  code: IssueCode;
  sourceId?: string;
};

export type AdapterResult =
  | { ok: false; error: FileError }
  | {
      ok: true;
      adapter: "chatgpt";
      adapterVersion: string;
      conversationsSeen: number;
      /** Ready for tree reconstruction (M1.2). */
      accepted: ConversationCandidate[];
      /** Valid but not imported until a person resolves them. */
      flagged: FlaggedConversation[];
      skipped: SkippedConversation[];
      issues: ImportIssue[];
    };

export type PathStrategy = "current_node" | "latest_leaf" | "last_child" | "none";

/**
 * One stored row per mapping node (M1.3 `Message`). Built in M1.2.
 * Times are epoch seconds exactly as exported (A22); conversion to the
 * database type is decided in M1.3.
 */
export type NormalizedNode = {
  /** Mapping key (wins over `node.id`). */
  sourceNodeId: string;
  sourceMessageId: string | null;
  /** `parent` exactly as exported (may dangle); null if absent or not a string. */
  parentSourceNodeId: string | null;
  siblingIndex: number;
  /** Position on the default visible path; null = off the path. */
  pathIndex: number | null;
  /** The node has no message (A29). Independent of `role`. */
  isStructural: boolean;
  /** A message was present but unusable (A24). Never true for structural nodes. */
  isMalformed: boolean;
  /** Exactly as exported, including unknown roles; null = missing or invalid (A29). */
  role: string | null;
  authorName: string | null;
  contentType: string | null;
  contentText: string;
  /** Code language identifier, where available (A27). */
  codeLanguage: string | null;
  hasUnsupportedParts: boolean;
  /** Original content payload, only for unsupported content (A28). */
  rawContentJson: string | null;
  /** Hidden by default in the UI (A26). Always false for structural nodes. */
  isHidden: boolean;
  status: string | null;
  createdAt: number | null;
};

export type NormalizedConversation = {
  index: number;
  source: "chatgpt";
  sourceId: string;
  idSource: IdSource;
  /** Parser version that produced this result (A28: enables reprocessing). */
  parserVersion: string;
  title: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  /** `current_node` exactly as exported, even if it is not in the mapping. */
  currentNodeSourceId: string | null;
  pathStrategy: PathStrategy;
  visibleMessageCount: number;
  nodeCount: number;
  /** `v1:<sha256 hex>` (A21). */
  contentHash: string;
  /** In mapping order. */
  nodes: NormalizedNode[];
};

export type ParseResult =
  | { ok: false; error: FileError }
  | {
      ok: true;
      adapter: "chatgpt";
      adapterVersion: string;
      conversationsSeen: number;
      conversations: NormalizedConversation[];
      flagged: FlaggedConversation[];
      skipped: SkippedConversation[];
      issues: ImportIssue[];
    };
