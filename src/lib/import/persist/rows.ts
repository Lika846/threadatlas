import type { NormalizedConversation, NormalizedNode } from "../types";

/**
 * Mapping between the parser's normalised output (M1.2) and database rows
 * (M1.3 schema). Each field maps to exactly one column; `nodeFromRow` is the
 * exact inverse of `messageRow` (tested on every fixture).
 *
 * Messages are identified across imports by (conversationId, sourceNodeId),
 * never by the generated `Message.id`, which changes whenever a
 * conversation's messages are replaced (C7, refinement E).
 */

/** Conversation columns written on add and on replace (identity and batch links excluded). */
export function conversationColumns(c: NormalizedConversation) {
  return {
    idSource: c.idSource,
    title: c.title,
    createdAtSec: c.createdAt,
    updatedAtSec: c.updatedAt,
    currentNodeSourceId: c.currentNodeSourceId,
    pathStrategy: c.pathStrategy,
    visibleMessageCount: c.visibleMessageCount,
    nodeCount: c.nodeCount,
    contentHash: c.contentHash,
    parserVersion: c.parserVersion,
  };
}

export type MessageRow = ReturnType<typeof messageRow>;

export function messageRow(conversationId: string, n: NormalizedNode) {
  return {
    conversationId,
    sourceNodeId: n.sourceNodeId,
    sourceMessageId: n.sourceMessageId,
    parentSourceNodeId: n.parentSourceNodeId,
    siblingIndex: n.siblingIndex,
    pathIndex: n.pathIndex,
    isStructural: n.isStructural,
    isMalformed: n.isMalformed,
    role: n.role,
    authorName: n.authorName,
    contentType: n.contentType,
    contentText: n.contentText,
    codeLanguage: n.codeLanguage,
    hasUnsupportedParts: n.hasUnsupportedParts,
    rawContentJson: n.rawContentJson,
    isHidden: n.isHidden,
    status: n.status,
    createdAtSec: n.createdAt,
  };
}

/** Inverse of `messageRow` (the row must be read with `rawContentJson` opted in). */
export function nodeFromRow(row: Omit<MessageRow, "conversationId">): NormalizedNode {
  return {
    sourceNodeId: row.sourceNodeId,
    sourceMessageId: row.sourceMessageId,
    parentSourceNodeId: row.parentSourceNodeId,
    siblingIndex: row.siblingIndex,
    pathIndex: row.pathIndex,
    isStructural: row.isStructural,
    isMalformed: row.isMalformed,
    role: row.role,
    authorName: row.authorName,
    contentType: row.contentType,
    contentText: row.contentText,
    codeLanguage: row.codeLanguage,
    hasUnsupportedParts: row.hasUnsupportedParts,
    rawContentJson: row.rawContentJson,
    isHidden: row.isHidden,
    status: row.status,
    createdAt: row.createdAtSec,
  };
}
