import { MESSAGES_PER_PAGE } from "../conversations/queries";

/**
 * Links from a search result to the conversation detail page (M2.2; A98).
 *
 * `messageNumber` is the message's 1-based position among the messages the
 * detail page displays with its default settings (`getConversationDetail`
 * with `includeHidden: false`): on the stored path (`pathIndex` not null),
 * not structural, not hidden, in `pathIndex` order. The page and the anchor
 * (`#m-<number>`, the message heading's id in `MessageView`) follow from it.
 * The URL is built exactly like the detail page's own links: `?page=` only
 * after page 1, and never `hidden=show`.
 */

export type SearchLink = { conversationId: string; page: number; messageNumber: number | null };

export function messagePage(messageNumber: number): number {
  return Math.max(1, Math.ceil(messageNumber / MESSAGES_PER_PAGE));
}

export function linkFor(conversationId: string, messageNumber: number | null): SearchLink {
  return { conversationId, messageNumber, page: messageNumber === null ? 1 : messagePage(messageNumber) };
}

/** `/conversations/<id>`, plus `?page=<n>` after page 1 and `#m-<number>` for a message. */
export function searchLinkHref(link: SearchLink): string {
  const base = `/conversations/${encodeURIComponent(link.conversationId)}`;
  const query = link.page > 1 ? `?page=${link.page}` : "";
  const anchor = link.messageNumber === null ? "" : `#m-${link.messageNumber}`;
  return base + query + anchor;
}
