/**
 * Related conversations (knowledge-graph MVP, step 1). Server-only.
 *
 * For one conversation, the indexed conversations closest to it in meaning, from the graph
 * spike (`docs/spikes/graph/README.md`, synthetic data):
 * - **Similarity:** cosine of the language-corrected, centred conversation vectors
 *   (`../conversation-vectors.ts`). Best-passage similarity was rejected: identical
 *   boilerplate ("I hope this helps!…") scores 1.00 and links anything.
 * - **Which:** its own top `RELATED_LIMIT` with similarity ≥ `RELATED_FLOOR` (experimental),
 *   most similar first. No forced matches: a conversation close to no other gets none.
 * - **Why:** per side, the passage that is close both to the other conversation's average and
 *   to its own (the smaller of the two similarities), skipping boilerplate: a passage with
 *   near-copies in 3 or more *unrelated* conversations ("I hope this helps! Let me know
 *   if…"); a prompt reused across related conversations still counts as evidence. A
 *   pair is shown only when both passages reach `EVIDENCE_MIN`; otherwise the link is listed
 *   without passages. (Synthetic data: 68 of 2,550 chosen passages were boilerplate without
 *   the near-copy check; every boilerplate passage, and no other, has near-copies.)
 *
 * Computed on request from cached vectors (milliseconds); nothing is stored. Passages are
 * read from their messages by the stored offsets, only from messages the conversation page
 * shows (on the path, not hidden or structural), and returned as plain text.
 */
import type { DbClient } from "../../db/client";
import { linkFor, searchLinkHref } from "../../search/link";
import { chunkVector, correctChunk, correctedVectors, hasNearCopies, type CorrectedVectors } from "../conversation-vectors.ts";
import { CODE_INDEX_CONFIG } from "../index/config.ts";
import { currentVectors, type VectorCache } from "../search/vector-cache.ts";
import { BOILERPLATE_CONVERSATIONS, BOILERPLATE_SIMILARITY, evidencePassage, nearestConversations, PASSAGE_CHARS, RELATED_FLOOR } from "./similarity.ts";

export type RelatedPassage = { text: string; messageNumber: number; href: string };
export type RelatedConversation = {
  id: string;
  title: string | null;
  updatedAtSec: number | null;
  similarity: number;
  /** A passage from each conversation that explains the link, or null when none is informative. */
  evidence: { focus: RelatedPassage; other: RelatedPassage } | null;
};
export type RelatedResult =
  | { status: "ok"; related: RelatedConversation[] }
  /** No usable semantic index at all. */
  | { status: "no-index" }
  /** The index exists, but this conversation isn't in it (not indexed yet, or no text). */
  | { status: "not-indexed" };

const VISIBLE = (a: string) => `${a}."pathIndex" IS NOT NULL AND ${a}."isStructural" = 0 AND ${a}."isHidden" = 0`;
/** Each passage's message text and its position among the displayed messages (as search by meaning). */
const passageSql = (n: number) => `
WITH target(cid, node) AS (VALUES ${Array.from({ length: n }, () => "(?, ?)").join(", ")})
SELECT t.cid AS cid, t.node AS node, m."contentText" AS text,
  (SELECT COUNT(*) FROM "Message" x WHERE x."conversationId" = t.cid AND x."pathIndex" <= m."pathIndex" AND ${VISIBLE("x")}) AS messageNumber
FROM target t JOIN "Message" m ON m."conversationId" = t.cid AND m."sourceNodeId" = t.node AND ${VISIBLE("m")}`;

const KEY_SEP = "\u0000";

function shorten(text: string, start: number, end: number): string | null {
  if (!(start < end && end <= text.length)) return null;
  let passage = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (passage === "") return null;
  let cut = false;
  if (passage.length > PASSAGE_CHARS) {
    passage = passage.slice(0, PASSAGE_CHARS - 1).replace(/\s+\S*$/, "");
    cut = true;
  }
  return `${start > 0 ? "… " : ""}${passage}${cut || end < text.length ? " …" : ""}`;
}

/** The chosen chunk of each side for every link; null when a side has no informative passage. */
function chooseEvidence(cache: VectorCache, cv: CorrectedVectors, focus: number, others: readonly number[]): Map<number, [number, number] | null> {
  const corrected = (conversation: number) =>
    cv.chunks[conversation]!.filter((c) => c.used).map((c) => ({ index: c.index, v: correctChunk(chunkVector(cache, c.index), cv.means.get(cv.chunkLang[c.index]!)!) }));
  const boilerplate = (chunks: readonly { index: number }[]) => (i: number) =>
    hasNearCopies(cache, cv, chunks[i]!.index, BOILERPLATE_SIMILARITY, BOILERPLATE_CONVERSATIONS, RELATED_FLOOR);
  const focusChunks = corrected(focus);
  const out = new Map<number, [number, number] | null>();
  for (const o of others) {
    const otherChunks = corrected(o);
    const a = evidencePassage(focusChunks.map((c) => c.v), cv.vectors[focus]!, cv.vectors[o]!, boilerplate(focusChunks));
    const b = evidencePassage(otherChunks.map((c) => c.v), cv.vectors[o]!, cv.vectors[focus]!, boilerplate(otherChunks));
    out.set(o, a && b ? [focusChunks[a.index]!.index, otherChunks[b.index]!.index] : null);
  }
  return out;
}

/** Related conversations of one conversation. */
export async function findRelated(db: DbClient, conversationId: string): Promise<RelatedResult> {
  const v = await currentVectors(db, { embeddingVersion: CODE_INDEX_CONFIG.embeddingVersion, chunkerVersion: CODE_INDEX_CONFIG.chunkerVersion });
  if (!v.ok) return { status: "no-index" };
  const cv = await correctedVectors(db, v.cache);
  const focus = cv.position.get(conversationId);
  if (focus === undefined) return { status: "not-indexed" };
  const near = nearestConversations(cv.centred, focus);
  if (near.length === 0) return { status: "ok", related: [] };

  const evidence = chooseEvidence(v.cache, cv, focus, near.map((x) => x.index));
  const cache = v.cache;
  const chunkKeys = [...evidence.values()].flatMap((p) => (p ? p : [])).map((i) => ({ cid: cache.conversationIds[cache.conversation[i]!]!, node: cache.sourceNodeIds[i]!, i }));
  const messages = new Map<string, { text: string; messageNumber: number }>();
  if (chunkKeys.length > 0) {
    const rows = await db.$queryRawUnsafe<{ cid: string; node: string; text: string; messageNumber: number | bigint }[]>(
      passageSql(chunkKeys.length),
      ...chunkKeys.flatMap((k) => [k.cid, k.node]),
    );
    for (const r of rows) messages.set(r.cid + KEY_SEP + r.node, { text: r.text, messageNumber: Number(r.messageNumber) });
  }
  const passage = (i: number): RelatedPassage | null => {
    const cid = cache.conversationIds[cache.conversation[i]!]!;
    const m = messages.get(cid + KEY_SEP + cache.sourceNodeIds[i]!);
    if (!m || m.messageNumber < 1) return null; // not shown on the conversation page
    const text = shorten(m.text, cache.starts[i]!, cache.ends[i]!);
    return text === null ? null : { text, messageNumber: m.messageNumber, href: searchLinkHref(linkFor(cid, m.messageNumber)) };
  };

  const ids = near.map((x) => cv.ids[x.index]!);
  const rows = await db.conversation.findMany({ where: { id: { in: ids } }, select: { id: true, title: true, updatedAtSec: true } });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const related: RelatedConversation[] = [];
  for (const x of near) {
    const c = byId.get(cv.ids[x.index]!);
    if (!c) continue; // deleted since the vectors were loaded
    const pair = evidence.get(x.index) ?? null;
    const focusPassage = pair ? passage(pair[0]) : null;
    const otherPassage = pair ? passage(pair[1]) : null;
    related.push({
      id: c.id,
      title: c.title,
      updatedAtSec: c.updatedAtSec,
      similarity: x.similarity,
      evidence: focusPassage && otherPassage ? { focus: focusPassage, other: otherPassage } : null,
    });
  }
  return { status: "ok", related };
}
