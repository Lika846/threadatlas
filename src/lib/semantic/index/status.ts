/**
 * Read-only status of the semantic index (M5.1b-1; design §5.8 and §11). Never writes:
 * dead `running` rows are reset only at Start, under the indexer lock (I5).
 *
 * Liveness is decided by the process, never by the row (correction D):
 * - `live`: what this process's indexer is doing (null when it is not running);
 * - `probe`: a non-blocking probe of the indexer lock (`probeIndexerLock`), called only
 *   when this process is not indexing.
 *
 * | `running` rows | this process | lock held elsewhere | state |
 * | any | indexing   | —   | `indexing` (or `waiting-for-import`, `pausing`) |
 * | any | no         | yes | `indexing-elsewhere` |
 * | > 0 | no         | no  | `interrupted` (counted as waiting) |
 * | 0   | no         | no  | idle: `never-indexed`, `incompatible`, `run-failed`, `waiting`, `finished-with-failures`, `up-to-date` |
 *
 * Counts and codes only: no text, ids or vectors.
 */
import type { DbClient } from "../../db/client";
import { CODE_INDEX_CONFIG, sameIndexConfig, type IndexConfig } from "./config.ts";
import type { LiveIndexerState } from "./indexer.ts";
import { readIndexRow } from "./store.ts";

export type IndexStatusState =
  | "indexing"
  | "waiting-for-import"
  | "pausing"
  | "indexing-elsewhere"
  | "interrupted"
  | "incompatible"
  | "never-indexed"
  | "run-failed"
  | "waiting"
  | "finished-with-failures"
  | "up-to-date";

export type IndexStatus = {
  state: IndexStatusState;
  counts: {
    conversations: number;
    indexed: number;
    /** Pending, never queued, and (unless live) interrupted `running` rows. */
    waiting: number;
    /** `running` rows: live work, or interrupted work when no process is indexing. */
    running: number;
    /** Failed, excluding too large. */
    failed: number;
    tooLarge: number;
    chunks: number;
  };
  /** Last run-level error code (static). */
  lastErrorCode: string | null;
};

const num = (v: unknown): number => (typeof v === "bigint" ? Number(v) : Number(v));

export async function computeIndexStatus(
  db: DbClient,
  opts: { live: LiveIndexerState | null; probe: () => "held" | "free" | "unknown"; config?: IndexConfig },
): Promise<IndexStatus> {
  const config = opts.config ?? CODE_INDEX_CONFIG;
  const { c, index } = await db.$transaction(async (tx) => {
    const [r] = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT
         (SELECT COUNT(*) FROM "Conversation") AS conversations,
         (SELECT COUNT(*) FROM "EmbeddingStatus" WHERE "state" = 'indexed') AS indexed,
         (SELECT COUNT(*) FROM "EmbeddingStatus" WHERE "state" = 'pending') AS pending,
         (SELECT COUNT(*) FROM "EmbeddingStatus" WHERE "state" = 'running') AS running,
         (SELECT COUNT(*) FROM "EmbeddingStatus" WHERE "state" = 'failed') AS failed,
         (SELECT COUNT(*) FROM "EmbeddingStatus" WHERE "state" = 'failed' AND "lastErrorCode" = 'CONVERSATION_TOO_LARGE') AS tooLarge,
         (SELECT COUNT(*) FROM "Conversation" c WHERE NOT EXISTS (SELECT 1 FROM "EmbeddingStatus" s WHERE s."conversationId" = c."id")) AS unqueued,
         (SELECT COUNT(*) FROM "EmbeddingChunk") AS chunks`,
    );
    return { c: r ?? {}, index: await readIndexRow(tx) };
  });
  const running = num(c.running);
  const tooLarge = num(c.tooLarge);
  const failed = num(c.failed) - tooLarge;
  const live = opts.live;
  const counts = {
    conversations: num(c.conversations),
    indexed: num(c.indexed),
    waiting: num(c.pending) + num(c.unqueued) + (live ? 0 : running),
    running,
    failed,
    tooLarge,
    chunks: num(c.chunks),
  };
  const lastErrorCode = index.row?.lastErrorCode ?? null;
  const state = ((): IndexStatusState => {
    if (live === "running") return "indexing";
    if (live) return live;
    if (opts.probe() === "held") return "indexing-elsewhere";
    if (running > 0) return "interrupted";
    if (!index.row) return "never-indexed";
    if (index.foreignRows > 0 || !sameIndexConfig(index.row, config)) return "incompatible";
    if (lastErrorCode) return "run-failed";
    if (counts.waiting > 0) return "waiting";
    if (failed + tooLarge > 0) return "finished-with-failures";
    return "up-to-date";
  })();
  return { state, counts, lastErrorCode };
}
