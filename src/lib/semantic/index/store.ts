/**
 * SQL of the persistent semantic index (M5.1b-1; design §3–§7). The statements are the
 * ones run in the pre-implementation prototype
 * (`docs/spikes/m5.1b/migration/prototype.int.test.ts.txt`), unchanged in substance.
 *
 * - **The only writer** of `EmbeddingIndex`, `EmbeddingStatus` and `EmbeddingChunk`
 *   (with the import's I2 and delete-all's I3, which call into this module).
 * - **Writes** run on the writer connection, under the write lock, inside
 *   `runWriterTransaction` (the caller's). Page reads run on a reader connection.
 * - **Raw SQL with positional `?` parameters** (the adapter rejects `?1`). `DateTime`
 *   columns are written as text in the adapter's own format (`dbTimestamp`; checked
 *   against Prisma-written rows in the tests).
 * - **The singleton:** every statement addresses `EmbeddingIndex` by `INDEX_ROW_ID`.
 *   Only `reconcile` inserts the row; a row with any other id is removed there, and the
 *   index is rebuilt (see `config.ts`).
 * - **Privacy:** nothing here logs; errors propagate to the caller, which maps them to
 *   codes.
 */
import { randomBytes } from "node:crypto";
import type { DbClient } from "../../db/client";
import { quantizedByteLength } from "../quantize.ts";
import {
  INDEX_ROW_ID,
  INSERT_ROWS_PER_STATEMENT,
  MAX_ATTEMPTS,
  MAX_CHUNKS_PER_CONVERSATION,
  sameIndexConfig,
  type IndexConfig,
} from "./config.ts";

/** A client or an interactive-transaction client: only raw statements are used. */
export type Sql = Pick<DbClient, "$executeRawUnsafe" | "$queryRawUnsafe">;

/** `DateTime` as the Prisma better-sqlite3 adapter stores it: ISO 8601 with `+00:00`. */
export function dbTimestamp(d: Date = new Date()): string {
  return d.toISOString().replace("Z", "+00:00");
}

const num = (v: unknown): number => (typeof v === "bigint" ? Number(v) : Number(v));
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The visible-message rule of keyword search (`search.ts`): on the path, not structural, not hidden. */
const VISIBLE = `m."pathIndex" IS NOT NULL AND m."isStructural" = 0 AND m."isHidden" = 0`;

const BUMP_COUNTER = `UPDATE "EmbeddingIndex" SET "changeCounter" = "changeCounter" + 1, "updatedAt" = ? WHERE "id" = ?`;
const CURRENT_EPOCH = `(SELECT "epoch" FROM "EmbeddingIndex" WHERE "id" = ?)`;

// ---- I2: import (add and replace) --------------------------------------------

const I2_UPSERT_STATUS = `
INSERT INTO "EmbeddingStatus" ("conversationId", "contentHash", "parserVersion", "epoch", "state", "claimToken",
  "attempts", "chunkCount", "lastErrorCode", "queuedAt", "updatedAt")
SELECT c."id", c."contentHash", c."parserVersion", COALESCE(${CURRENT_EPOCH}, 0), 'pending', NULL, 0, NULL, NULL, ?, ?
FROM "Conversation" c WHERE c."id" = ?
ON CONFLICT ("conversationId") DO UPDATE SET
  "contentHash" = excluded."contentHash", "parserVersion" = excluded."parserVersion", "epoch" = excluded."epoch",
  "state" = 'pending', "claimToken" = NULL, "attempts" = 0, "chunkCount" = NULL, "lastErrorCode" = NULL,
  "queuedAt" = excluded."queuedAt", "updatedAt" = excluded."updatedAt"`;

/**
 * I2: called inside the import transaction after an add or replace has written the
 * messages. Deletes the conversation's chunks and (re)queues its status row with the
 * new version, token cleared, attempts 0. Rolls back with the import.
 */
export async function invalidateConversation(tx: Sql, conversationId: string, now = dbTimestamp()): Promise<void> {
  const deleted = await tx.$executeRawUnsafe(`DELETE FROM "EmbeddingChunk" WHERE "conversationId" = ?`, conversationId);
  const upserted = await tx.$executeRawUnsafe(I2_UPSERT_STATUS, INDEX_ROW_ID, now, now, conversationId);
  // The conversation was written in this transaction: anything else is a bug, and
  // throwing rolls the whole import of this conversation back.
  if (upserted !== 1) throw new Error("semantic status row was not written");
  if (deleted > 0) await tx.$executeRawUnsafe(BUMP_COUNTER, now, INDEX_ROW_ID);
}

// ---- I3: delete-all -----------------------------------------------------------

/**
 * I3, phase 1 (inside delete-all's transaction): every chunk and status row, explicitly
 * (the cascade is a second line); the epoch and change counter increase. The
 * `EmbeddingIndex` row is kept (decision 4): it holds versions and counters only.
 */
export async function clearSemanticIndex(tx: Sql, now = dbTimestamp()): Promise<{ chunks: number; statuses: number }> {
  const chunks = await tx.$executeRawUnsafe(`DELETE FROM "EmbeddingChunk"`);
  const statuses = await tx.$executeRawUnsafe(`DELETE FROM "EmbeddingStatus"`);
  await tx.$executeRawUnsafe(
    `UPDATE "EmbeddingIndex" SET "epoch" = "epoch" + 1, "changeCounter" = "changeCounter" + 1, "updatedAt" = ? WHERE "id" = ?`,
    now,
    INDEX_ROW_ID,
  );
  return { chunks, statuses };
}

/** Rows left in the derived tables (delete-all verification and standalone cleanup). */
export async function semanticRowCounts(db: Sql): Promise<{ chunks: number; statuses: number }> {
  const [r] = await db.$queryRawUnsafe<{ chunks: unknown; statuses: unknown }[]>(
    `SELECT (SELECT COUNT(*) FROM "EmbeddingChunk") AS chunks, (SELECT COUNT(*) FROM "EmbeddingStatus") AS statuses`,
  );
  return { chunks: num(r?.chunks), statuses: num(r?.statuses) };
}

// ---- The index row ----------------------------------------------------------------

export type IndexRow = IndexConfig & {
  readonly epoch: number;
  readonly changeCounter: number;
  readonly lastErrorCode: string | null;
};

type RawIndexRow = Record<string, unknown>;

function toIndexRow(r: RawIndexRow): IndexRow {
  return {
    embeddingVersion: String(r.embeddingVersion),
    chunkerVersion: String(r.chunkerVersion),
    chunkTokens: num(r.chunkTokens),
    quantization: String(r.quantization),
    dimensions: num(r.dimensions),
    epoch: num(r.epoch),
    changeCounter: num(r.changeCounter),
    lastErrorCode: r.lastErrorCode === null || r.lastErrorCode === undefined ? null : String(r.lastErrorCode),
  };
}

/** The index row and whether any row with another id exists (a broken singleton). */
export async function readIndexRow(db: Sql): Promise<{ row: IndexRow | null; foreignRows: number }> {
  const rows = await db.$queryRawUnsafe<RawIndexRow[]>(`SELECT * FROM "EmbeddingIndex"`);
  const main = rows.find((r) => r.id === INDEX_ROW_ID);
  return { row: main ? toIndexRow(main) : null, foreignRows: rows.length - (main ? 1 : 0) };
}

/** Run-level error code on the index row (static codes only); null clears it. */
export async function setRunError(tx: Sql, code: string | null, now = dbTimestamp()): Promise<void> {
  await tx.$executeRawUnsafe(`UPDATE "EmbeddingIndex" SET "lastErrorCode" = ?, "updatedAt" = ? WHERE "id" = ?`, code, now, INDEX_ROW_ID);
}

// ---- Reconcile (Start, step 3) ------------------------------------------------------

export type ReconcileResult = {
  /** Why every chunk was dropped and every row requeued, if it was. */
  readonly rebuilt: "created" | "config-changed" | "singleton-repaired" | null;
  /** `running` rows of a dead run, back to `pending` (I5; the attempt is kept). */
  readonly reset: number;
  /** Rows whose version differed from their conversation's (defensive; I2 prevents it). */
  readonly resynced: number;
  /** Conversations with no status row, queued (backfill; correction A). */
  readonly queued: number;
  readonly epoch: number;
};

/**
 * Start, step 3 (design §5.2), in one transaction under the indexer lock and the write
 * lock. Creates or repairs the index row; on any configuration difference drops every
 * chunk, requeues every row and increases the epoch; resets dead `running` rows (I5);
 * queues conversations that have no status row. `indexed` (including zero-chunk) and
 * `failed` rows are never requeued here.
 */
export async function reconcile(tx: Sql, config: IndexConfig, now = dbTimestamp()): Promise<ReconcileResult> {
  const foreign = await tx.$executeRawUnsafe(`DELETE FROM "EmbeddingIndex" WHERE "id" <> ?`, INDEX_ROW_ID);
  const { row } = await readIndexRow(tx);
  let rebuilt: ReconcileResult["rebuilt"] = null;
  if (!row) rebuilt = "created";
  else if (foreign > 0) rebuilt = "singleton-repaired";
  else if (!sameIndexConfig(row, config)) rebuilt = "config-changed";

  if (rebuilt) {
    await tx.$executeRawUnsafe(`DELETE FROM "EmbeddingChunk"`);
    if (!row) {
      // Above every epoch ever stored, so no surviving row can match it.
      await tx.$executeRawUnsafe(
        `INSERT INTO "EmbeddingIndex" ("id", "epoch", "embeddingVersion", "chunkerVersion", "chunkTokens", "quantization",
           "dimensions", "changeCounter", "lastErrorCode", "updatedAt")
         VALUES (?, 1 + MAX(0, COALESCE((SELECT MAX("epoch") FROM "EmbeddingStatus"), 0)), ?, ?, ?, ?, ?, 0, NULL, ?)`,
        INDEX_ROW_ID, config.embeddingVersion, config.chunkerVersion, config.chunkTokens, config.quantization, config.dimensions, now,
      );
    } else {
      await tx.$executeRawUnsafe(
        `UPDATE "EmbeddingIndex" SET "epoch" = "epoch" + 1, "embeddingVersion" = ?, "chunkerVersion" = ?, "chunkTokens" = ?,
           "quantization" = ?, "dimensions" = ?, "changeCounter" = "changeCounter" + 1, "updatedAt" = ? WHERE "id" = ?`,
        config.embeddingVersion, config.chunkerVersion, config.chunkTokens, config.quantization, config.dimensions, now, INDEX_ROW_ID,
      );
    }
    await tx.$executeRawUnsafe(
      `UPDATE "EmbeddingStatus" SET "state" = 'pending', "claimToken" = NULL, "attempts" = 0, "chunkCount" = NULL,
         "lastErrorCode" = NULL, "epoch" = ${CURRENT_EPOCH}, "updatedAt" = ?`,
      INDEX_ROW_ID, now,
    );
  }

  // I5: the caller holds the indexer lock, so every running row belongs to a dead run.
  const reset = await tx.$executeRawUnsafe(
    `UPDATE "EmbeddingStatus" SET "state" = 'pending', "claimToken" = NULL, "updatedAt" = ? WHERE "state" = 'running'`,
    now,
  );
  const resynced = await tx.$executeRawUnsafe(
    `UPDATE "EmbeddingStatus" SET "state" = 'pending', "claimToken" = NULL, "attempts" = 0, "chunkCount" = NULL,
       "contentHash" = (SELECT c."contentHash" FROM "Conversation" c WHERE c."id" = "EmbeddingStatus"."conversationId"),
       "parserVersion" = (SELECT c."parserVersion" FROM "Conversation" c WHERE c."id" = "EmbeddingStatus"."conversationId"),
       "updatedAt" = ?
     WHERE EXISTS (SELECT 1 FROM "Conversation" c WHERE c."id" = "EmbeddingStatus"."conversationId"
                   AND (c."contentHash" <> "EmbeddingStatus"."contentHash" OR c."parserVersion" <> "EmbeddingStatus"."parserVersion"))`,
    now,
  );
  if (resynced > 0) {
    await tx.$executeRawUnsafe(
      `DELETE FROM "EmbeddingChunk" WHERE NOT EXISTS (SELECT 1 FROM "Conversation" c WHERE c."id" = "EmbeddingChunk"."conversationId"
         AND c."contentHash" = "EmbeddingChunk"."contentHash" AND c."parserVersion" = "EmbeddingChunk"."parserVersion")`,
    );
  }
  const queued = await tx.$executeRawUnsafe(
    `INSERT INTO "EmbeddingStatus" ("conversationId", "contentHash", "parserVersion", "epoch", "state", "claimToken",
       "attempts", "chunkCount", "lastErrorCode", "queuedAt", "updatedAt")
     SELECT c."id", c."contentHash", c."parserVersion", ${CURRENT_EPOCH}, 'pending', NULL, 0, NULL, NULL, ?, ?
     FROM "Conversation" c
     WHERE NOT EXISTS (SELECT 1 FROM "EmbeddingStatus" s WHERE s."conversationId" = c."id")`,
    INDEX_ROW_ID, now, now,
  );
  await setRunError(tx, null, now);
  const after = await readIndexRow(tx);
  return { rebuilt, reset, resynced, queued, epoch: after.row!.epoch };
}

// ---- T1: claim ---------------------------------------------------------------------

export type Claim = {
  readonly conversationId: string;
  readonly contentHash: string;
  readonly parserVersion: string;
  readonly epoch: number;
  readonly attempts: number;
  /** Random 128-bit hex; any re-queue clears it from the row. */
  readonly token: string;
};

/** The oldest pending row, now `running` with a fresh token; the attempt counts at claim (§5.6). */
export async function claimNext(tx: Sql, now = dbTimestamp()): Promise<Claim | null> {
  const token = randomBytes(16).toString("hex");
  const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
    `UPDATE "EmbeddingStatus" SET "state" = 'running', "claimToken" = ?, "attempts" = "attempts" + 1,
       "epoch" = ${CURRENT_EPOCH}, "updatedAt" = ?
     WHERE "conversationId" = (SELECT "conversationId" FROM "EmbeddingStatus" WHERE "state" = 'pending'
                               ORDER BY "queuedAt", "conversationId" LIMIT 1)
     RETURNING "conversationId", "contentHash", "parserVersion", "epoch", "attempts"`,
    token, INDEX_ROW_ID, now,
  );
  const r = rows[0];
  if (!r) return null;
  return {
    conversationId: String(r.conversationId),
    contentHash: String(r.contentHash),
    parserVersion: String(r.parserVersion),
    epoch: num(r.epoch),
    attempts: num(r.attempts),
    token,
  };
}

export type EligibleMessage = {
  readonly sourceNodeId: string;
  readonly pathIndex: number;
  /** Characters as SQLite counts them (code points); no text is read here. */
  readonly chars: number;
};

/** T1: ids and lengths of the visible messages, in path order (no text). */
export async function listEligibleMessages(tx: Sql, conversationId: string): Promise<EligibleMessage[]> {
  const rows = await tx.$queryRawUnsafe<{ sourceNodeId: string; pathIndex: unknown; chars: unknown }[]>(
    `SELECT m."sourceNodeId" AS "sourceNodeId", m."pathIndex" AS "pathIndex", length(m."contentText") AS "chars"
     FROM "Message" m WHERE m."conversationId" = ? AND ${VISIBLE} ORDER BY m."pathIndex"`,
    conversationId,
  );
  return rows.map((r) => ({ sourceNodeId: String(r.sourceNodeId), pathIndex: num(r.pathIndex), chars: num(r.chars) }));
}

// ---- Pages (no lock, reader connection) ------------------------------------------------

export type PageMessage = { readonly sourceNodeId: string; readonly pathIndex: number; readonly text: string };

/**
 * One page of message text, in one statement (one snapshot), only while the
 * conversation still has the claim's version and the row still holds the claim's
 * token. Returns null when either changed (a stale claim).
 */
export async function readPage(db: Sql, claim: Claim, fromPathIndex: number, toPathIndex: number): Promise<PageMessage[] | null> {
  const rows = await db.$queryRawUnsafe<{ sourceNodeId: string; pathIndex: unknown; text: string }[]>(
    `SELECT m."sourceNodeId" AS "sourceNodeId", m."pathIndex" AS "pathIndex", m."contentText" AS "text"
     FROM "Message" m
     WHERE m."conversationId" = ? AND m."pathIndex" >= ? AND m."pathIndex" <= ? AND ${VISIBLE}
       AND EXISTS (SELECT 1 FROM "Conversation" c WHERE c."id" = ? AND c."contentHash" = ? AND c."parserVersion" = ?)
       AND EXISTS (SELECT 1 FROM "EmbeddingStatus" s WHERE s."conversationId" = ? AND s."state" = 'running' AND s."claimToken" = ?)
     ORDER BY m."pathIndex"`,
    claim.conversationId, fromPathIndex, toPathIndex,
    claim.conversationId, claim.contentHash, claim.parserVersion,
    claim.conversationId, claim.token,
  );
  if (rows.length === 0) return null;
  return rows.map((r) => ({ sourceNodeId: String(r.sourceNodeId), pathIndex: num(r.pathIndex), text: String(r.text) }));
}

// ---- T2: commit -----------------------------------------------------------------------------

export type ChunkRow = {
  readonly sourceNodeId: string;
  readonly chunkIndex: number;
  readonly start: number;
  readonly end: number;
  readonly tokenCount: number;
  readonly chunkKey: string;
  readonly vector: Uint8Array;
};

/** The configuration the running worker reported (plus the code's chunk budget and quantisation). */
export type WorkerConfig = IndexConfig;

const isCount = (n: unknown): boolean => Number.isSafeInteger(n) && (n as number) >= 0;

/**
 * What a commit accepts: at most `MAX_CHUNKS_PER_CONVERSATION` rows; non-empty ids;
 * non-negative safe integers with `start < end`; vectors of exactly `vectorBytes`; no
 * two rows with the same key. Anything else would be stored silently converted (SQLite
 * affinity) or fail half-way, so it is refused before any write.
 */
export function validChunkRows(chunks: readonly ChunkRow[], vectorBytes: number): boolean {
  if (chunks.length > MAX_CHUNKS_PER_CONVERSATION) return false;
  const keys = new Set<string>();
  for (const k of chunks) {
    if (typeof k.sourceNodeId !== "string" || k.sourceNodeId === "" || typeof k.chunkKey !== "string" || k.chunkKey === "") return false;
    if (!isCount(k.chunkIndex) || !isCount(k.start) || !isCount(k.end) || !isCount(k.tokenCount) || k.end <= k.start) return false;
    if (!(k.vector instanceof Uint8Array) || k.vector.byteLength !== vectorBytes) return false;
    const key = `${k.chunkIndex}:${k.sourceNodeId}`;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

/**
 * T2 (I4): one compare-and-set on the status row (token, version on row and
 * conversation, epoch, stored configuration equal to the worker's); the chunks are
 * written only if it succeeded, all in the caller's transaction.
 */
export async function commitClaim(
  tx: Sql,
  claim: Claim,
  chunks: readonly ChunkRow[],
  worker: WorkerConfig,
  now = dbTimestamp(),
): Promise<"committed" | "stale"> {
  const stride = quantizedByteLength(worker.dimensions);
  // Checked before any write; a throw rolls the caller's transaction back.
  if (!validChunkRows(chunks, stride)) throw new Error("invalid chunk rows");
  const ok = await tx.$executeRawUnsafe(
    `UPDATE "EmbeddingStatus" SET "state" = 'indexed', "claimToken" = NULL, "chunkCount" = ?, "lastErrorCode" = NULL, "updatedAt" = ?
     WHERE "conversationId" = ? AND "state" = 'running' AND "claimToken" = ?
       AND "contentHash" = ? AND "parserVersion" = ? AND "epoch" = ?
       AND EXISTS (SELECT 1 FROM "Conversation" c WHERE c."id" = ? AND c."contentHash" = ? AND c."parserVersion" = ?)
       AND EXISTS (SELECT 1 FROM "EmbeddingIndex" i WHERE i."id" = ? AND i."epoch" = ?
                   AND i."embeddingVersion" = ? AND i."chunkerVersion" = ? AND i."chunkTokens" = ?
                   AND i."quantization" = ? AND i."dimensions" = ?)`,
    chunks.length, now, claim.conversationId, claim.token, claim.contentHash, claim.parserVersion, claim.epoch,
    claim.conversationId, claim.contentHash, claim.parserVersion,
    INDEX_ROW_ID, claim.epoch, worker.embeddingVersion, worker.chunkerVersion, worker.chunkTokens, worker.quantization, worker.dimensions,
  );
  if (ok !== 1) return "stale";
  await tx.$executeRawUnsafe(`DELETE FROM "EmbeddingChunk" WHERE "conversationId" = ?`, claim.conversationId);
  // Two parameters per statement instead of eleven per row: the offsets as one JSON
  // array, the vectors as one concatenated blob cut by SQLite at a fixed stride. Same
  // transaction, same rows; about 2.5 times faster than per-row parameters at the chunk
  // cap (measured in M5.1b-1), which keeps T2's write-lock hold well under 500 ms.
  // Row j of a statement takes element j of the JSON array and bytes [j·stride,
  // (j+1)·stride) of the blob (`substr` counts bytes on a blob); the row count is checked.
  for (let i = 0; i < chunks.length; i += INSERT_ROWS_PER_STATEMENT) {
    if (i > 0) await yieldToEventLoop();
    const part = chunks.slice(i, i + INSERT_ROWS_PER_STATEMENT);
    const meta = JSON.stringify(part.map((k) => [k.sourceNodeId, k.chunkIndex, k.start, k.end, k.tokenCount, k.chunkKey]));
    const vectors = Buffer.concat(part.map((k) => k.vector));
    const inserted = await tx.$executeRawUnsafe(
      `INSERT INTO "EmbeddingChunk" ("conversationId", "contentHash", "parserVersion", "epoch", "sourceNodeId", "chunkIndex",
         "start", "end", "tokenCount", "chunkKey", "vector")
       SELECT ?, ?, ?, ?, j.value ->> 0, j.value ->> 1, j.value ->> 2, j.value ->> 3, j.value ->> 4, j.value ->> 5,
         substr(?, j.key * ? + 1, ?)
       FROM json_each(?) j`,
      claim.conversationId, claim.contentHash, claim.parserVersion, claim.epoch, vectors, stride, stride, meta,
    );
    if (inserted !== part.length) throw new Error("chunk insert wrote an unexpected number of rows");
  }
  await tx.$executeRawUnsafe(BUMP_COUNTER, now, INDEX_ROW_ID);
  return "committed";
}

// ---- Failures, refunds, retry (§5.6) ----------------------------------------------------------

/**
 * - `recoverable`: back to `pending`, or `failed` once `MAX_ATTEMPTS` is reached;
 * - `permanent`: `failed` at once;
 * - `refund`: back to `pending` and the attempt given back (clean run-level failure,
 *   pause, cancel; `code` null keeps the previous code);
 * - `worker-crash`: as recoverable (the attempt is kept).
 */
export type ClaimOutcome = "recoverable" | "permanent" | "refund" | "worker-crash";

/** Applies a failure to the claimed row, only while it still holds the claim's token. */
export async function releaseClaim(tx: Sql, claim: Claim, outcome: ClaimOutcome, code: string | null, now = dbTimestamp()): Promise<number> {
  const sql = {
    recoverable: `UPDATE "EmbeddingStatus" SET "state" = CASE WHEN "attempts" >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END,
                    "claimToken" = NULL, "lastErrorCode" = COALESCE(?, "lastErrorCode"), "updatedAt" = ?
                  WHERE "conversationId" = ? AND "claimToken" = ?`,
    "worker-crash": `UPDATE "EmbeddingStatus" SET "state" = CASE WHEN "attempts" >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END,
                    "claimToken" = NULL, "lastErrorCode" = COALESCE(?, "lastErrorCode"), "updatedAt" = ?
                  WHERE "conversationId" = ? AND "claimToken" = ?`,
    permanent: `UPDATE "EmbeddingStatus" SET "state" = 'failed', "claimToken" = NULL, "lastErrorCode" = COALESCE(?, "lastErrorCode"), "updatedAt" = ?
                WHERE "conversationId" = ? AND "claimToken" = ?`,
    refund: `UPDATE "EmbeddingStatus" SET "state" = 'pending', "claimToken" = NULL, "attempts" = MAX("attempts" - 1, 0),
               "lastErrorCode" = COALESCE(?, "lastErrorCode"), "updatedAt" = ?
             WHERE "conversationId" = ? AND "claimToken" = ?`,
  }[outcome];
  return tx.$executeRawUnsafe(sql, code, now, claim.conversationId, claim.token);
}

/**
 * "Retry failed": every `failed` row back to `pending` with attempts 0. The last error
 * code is kept, so a too-large conversation can be shown as such until it fails again.
 */
export async function retryFailed(tx: Sql, now = dbTimestamp()): Promise<number> {
  return tx.$executeRawUnsafe(`UPDATE "EmbeddingStatus" SET "state" = 'pending', "attempts" = 0, "updatedAt" = ? WHERE "state" = 'failed'`, now);
}
