import type { DbClient } from "../db/client";
import { branchVersions } from "./branches";

/**
 * Read queries for the conversation pages (M1.6), on the reader connection.
 * Every query selects its columns explicitly; `rawContentJson` is never
 * selected (and the client omits it by default as well, A37).
 */

export const CONVERSATIONS_PER_PAGE = 50;
export const MESSAGES_PER_PAGE = 1_000;

/** Internal IDs are cuids: lowercase letters and digits. Anything else is not looked up. */
const ID_PATTERN = /^[a-z0-9]{1,64}$/;
export const isConversationId = (id: string) => ID_PATTERN.test(id);

/**
 * A 1-based page number from a query parameter. Missing or malformed values
 * give page 1; values past the end give the last page.
 */
export function parsePage(raw: string | string[] | undefined, totalPages: number): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const last = Math.max(1, totalPages);
  if (value === undefined || !/^[0-9]{1,9}$/.test(value)) return 1;
  const n = Number(value);
  if (n < 1) return 1;
  return Math.min(n, last);
}

const pages = (count: number, size: number) => Math.max(1, Math.ceil(count / size));

export type ConversationListItem = {
  id: string;
  title: string | null;
  updatedAtSec: number | null;
  createdAtSec: number | null;
  visibleMessageCount: number;
};

export type ConversationList = { items: ConversationListItem[]; total: number; page: number; totalPages: number };

/** Newest first by source update time; conversations without one come last; ties by internal id. */
export async function listConversations(db: DbClient, rawPage: string | string[] | undefined): Promise<ConversationList> {
  const total = await db.conversation.count();
  const totalPages = pages(total, CONVERSATIONS_PER_PAGE);
  const page = parsePage(rawPage, totalPages);
  const items = await db.conversation.findMany({
    orderBy: [{ updatedAtSec: { sort: "desc", nulls: "last" } }, { id: "desc" }],
    skip: (page - 1) * CONVERSATIONS_PER_PAGE,
    take: CONVERSATIONS_PER_PAGE,
    select: { id: true, title: true, updatedAtSec: true, createdAtSec: true, visibleMessageCount: true },
  });
  return { items, total, page, totalPages };
}

export const CONVERSATION_HEADER_SELECT = {
  id: true,
  title: true,
  createdAtSec: true,
  updatedAtSec: true,
  pathStrategy: true,
  visibleMessageCount: true,
} as const;

export async function getConversationHeader(db: DbClient, id: string) {
  if (!isConversationId(id)) return null;
  return db.conversation.findUnique({ where: { id }, select: CONVERSATION_HEADER_SELECT });
}

const MESSAGE_SELECT = {
  sourceNodeId: true,
  pathIndex: true,
  role: true,
  authorName: true,
  contentType: true,
  contentText: true,
  codeLanguage: true,
  isMalformed: true,
  hasUnsupportedParts: true,
  isHidden: true,
  createdAtSec: true,
} as const;

export type DisplayedMessage = {
  sourceNodeId: string;
  /** 1-based position among the displayed messages. */
  number: number;
  role: string | null;
  authorName: string | null;
  contentType: string | null;
  contentText: string;
  codeLanguage: string | null;
  isMalformed: boolean;
  hasUnsupportedParts: boolean;
  isHidden: boolean;
  createdAtSec: number | null;
  /** > 1 when this message is one of several versions (branch marker). */
  versions: number;
};

export type ConversationDetail = {
  conversation: NonNullable<Awaited<ReturnType<typeof getConversationHeader>>>;
  messages: DisplayedMessage[];
  /** Messages shown with the current hidden setting, across all pages. */
  displayedCount: number;
  /** Hidden messages on the visible path (whether shown or not). */
  hiddenCount: number;
  page: number;
  totalPages: number;
};

/**
 * The stored visible path (A25), page by page.
 *
 * 1. Structure of every node (ids, parent, flags, pathIndex; no text).
 * 2. Path order by `pathIndex`; structural nodes are never shown; hidden
 *    messages only if requested. Filtering happens before pagination.
 * 3. Branch markers from the structure (see `branches.ts`).
 * 4. Content only for the requested page: one range query on
 *    (conversationId, pathIndex), which is indexed.
 */
export async function getConversationDetail(
  db: DbClient,
  id: string,
  opts: { includeHidden: boolean; page: string | string[] | undefined },
): Promise<ConversationDetail | null> {
  const conversation = await getConversationHeader(db, id);
  if (!conversation) return null;

  const nodes = await db.message.findMany({
    where: { conversationId: id },
    select: { sourceNodeId: true, parentSourceNodeId: true, isStructural: true, isHidden: true, pathIndex: true },
  });
  const path = nodes.filter((n) => n.pathIndex !== null).sort((a, b) => a.pathIndex! - b.pathIndex!);
  const shown = path.filter((n) => !n.isStructural && (opts.includeHidden || !n.isHidden));
  const hiddenCount = path.filter((n) => !n.isStructural && n.isHidden).length;
  const versions = branchVersions(
    nodes,
    path.map((n) => n.sourceNodeId),
    shown.map((n) => n.sourceNodeId),
  );

  const totalPages = pages(shown.length, MESSAGES_PER_PAGE);
  const page = parsePage(opts.page, totalPages);
  const start = (page - 1) * MESSAGES_PER_PAGE;
  const slice = shown.slice(start, start + MESSAGES_PER_PAGE);

  let messages: DisplayedMessage[] = [];
  if (slice.length > 0) {
    const rows = await db.message.findMany({
      where: {
        conversationId: id,
        isStructural: false,
        pathIndex: { gte: slice[0]!.pathIndex!, lte: slice[slice.length - 1]!.pathIndex! },
        ...(opts.includeHidden ? {} : { isHidden: false }),
      },
      orderBy: { pathIndex: "asc" },
      select: MESSAGE_SELECT,
    });
    messages = rows.map((r, i) => ({
      sourceNodeId: r.sourceNodeId,
      number: start + i + 1,
      role: r.role,
      authorName: r.authorName,
      contentType: r.contentType,
      contentText: r.contentText,
      codeLanguage: r.codeLanguage,
      isMalformed: r.isMalformed,
      hasUnsupportedParts: r.hasUnsupportedParts,
      isHidden: r.isHidden,
      createdAtSec: r.createdAtSec,
      versions: versions.get(r.sourceNodeId) ?? 1,
    }));
  }
  return { conversation, messages, displayedCount: shown.length, hiddenCount, page, totalPages };
}
