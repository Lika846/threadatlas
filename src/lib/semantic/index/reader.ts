/**
 * The only way to read stored vectors (M5.1b-1; design §7, I6 and I7). Nothing in the
 * app calls it yet: M5.2's search will.
 *
 * 1. **Configuration (I7):** no `EmbeddingIndex` row → `INDEX_EMPTY`. A stored
 *    configuration that differs from the code's in any of its five fields, or a broken
 *    singleton (a row with another id) → `INDEX_INCOMPATIBLE`. No vectors are returned
 *    in either case, even before Reconcile runs.
 * 2. **Query side:** the querying embedder's `embeddingVersion` and `chunkerVersion`
 *    must equal the stored row's, otherwise `INDEX_INCOMPATIBLE`.
 * 3. **Rows (I6):** chunks joined to their conversation on id and version, with the
 *    chunk's epoch equal to the index's.
 * 4. **Bytes:** a vector whose length is not `quantizedByteLength(dimensions)` is never
 *    decoded; it is skipped and counted.
 * 5. **One snapshot:** configuration and rows are read in one read transaction.
 */
import type { DbClient } from "../../db/client";
import { quantizedByteLength } from "../quantize.ts";
import { CODE_INDEX_CONFIG, INDEX_ROW_ID, sameIndexConfig, type IndexConfig } from "./config.ts";
import { readIndexRow } from "./store.ts";

export type VectorRow = {
  readonly conversationId: string;
  readonly sourceNodeId: string;
  readonly chunkIndex: number;
  /** UTF-16 offsets into `Message.contentText` (no text is stored with the vector). */
  readonly start: number;
  readonly end: number;
  /** Model tokens in the chunk (search by meaning demotes very short chunks, M5.2). */
  readonly tokenCount: number;
  readonly vector: Uint8Array;
};

export type VectorReadResult =
  | { ok: false; code: "INDEX_EMPTY" | "INDEX_INCOMPATIBLE" }
  | { ok: true; epoch: number; changeCounter: number; dimensions: number; rows: VectorRow[]; skipped: number };

export type QueryEmbedderInfo = { readonly embeddingVersion: string; readonly chunkerVersion: string };

const num = (v: unknown): number => (typeof v === "bigint" ? Number(v) : Number(v));

export async function openVectorReader(
  db: DbClient,
  query: QueryEmbedderInfo,
  config: IndexConfig = CODE_INDEX_CONFIG,
): Promise<VectorReadResult> {
  return db.$transaction(
    async (tx) => {
      const { row, foreignRows } = await readIndexRow(tx);
      if (!row) return { ok: false, code: "INDEX_EMPTY" } as const;
      if (foreignRows > 0 || !sameIndexConfig(row, config)) return { ok: false, code: "INDEX_INCOMPATIBLE" } as const;
      if (query.embeddingVersion !== row.embeddingVersion || query.chunkerVersion !== row.chunkerVersion) {
        return { ok: false, code: "INDEX_INCOMPATIBLE" } as const;
      }
      const raw = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT ch."conversationId" AS "conversationId", ch."sourceNodeId" AS "sourceNodeId", ch."chunkIndex" AS "chunkIndex",
                ch."start" AS "start", ch."end" AS "end", ch."tokenCount" AS "tokenCount", ch."vector" AS "vector"
         FROM "EmbeddingChunk" ch
         JOIN "Conversation" c ON c."id" = ch."conversationId" AND c."contentHash" = ch."contentHash" AND c."parserVersion" = ch."parserVersion"
         JOIN "EmbeddingIndex" i ON i."id" = ? AND ch."epoch" = i."epoch"
         ORDER BY ch."conversationId", ch."sourceNodeId", ch."chunkIndex"`,
        INDEX_ROW_ID,
      );
      const bytes = quantizedByteLength(row.dimensions);
      const rows: VectorRow[] = [];
      let skipped = 0;
      for (const r of raw) {
        const v = r.vector;
        if (!(v instanceof Uint8Array) || v.byteLength !== bytes) {
          skipped++;
          continue;
        }
        rows.push({
          conversationId: String(r.conversationId),
          sourceNodeId: String(r.sourceNodeId),
          chunkIndex: num(r.chunkIndex),
          start: num(r.start),
          end: num(r.end),
          tokenCount: num(r.tokenCount),
          vector: v,
        });
      }
      return { ok: true, epoch: row.epoch, changeCounter: row.changeCounter, dimensions: row.dimensions, rows, skipped } as const;
    },
    { timeout: 60_000 },
  );
}
