/**
 * Helpers for the semantic-index tests (M5.1b-1): a fake embedder through a real worker
 * thread, a runner, and content-free views of the derived tables. Synthetic data and
 * temporary databases only.
 */
import { Embedder } from "../../src/lib/semantic/embedder";
import { runIndexer, type IndexEmbedder, type IndexerDeps, type IndexerResult } from "../../src/lib/semantic/index/indexer";
import type { DbClient } from "../../src/lib/db/client";
import type { TestDb } from "./test-db";
import type { FakeIndexWorkerData } from "./fake-index-worker.mts";
import { BASE_TIME } from "./synthetic-export";

export const FAKE_INDEX_WORKER = new URL("./fake-index-worker.mts", import.meta.url);

export function fakeIndexEmbedder(data: FakeIndexWorkerData = {}): () => Promise<IndexEmbedder> {
  return () => Embedder.start({ modelDir: "/unused", workerUrl: FAKE_INDEX_WORKER, workerData: data });
}

export function newLog(): Int32Array {
  return new Int32Array(new SharedArrayBuffer(4 * 4));
}

/** Runs the indexer on a test database with a fresh reader connection. */
export function indexWith(
  t: TestDb,
  opts: Partial<Omit<IndexerDeps, "writer" | "reader">> & { worker?: FakeIndexWorkerData } = {},
): Promise<IndexerResult> {
  const { worker, ...rest } = opts;
  return runIndexer({ writer: t.writer, reader: t.reader(), openEmbedder: fakeIndexEmbedder(worker), writeLockRetryMs: 50, ...rest });
}

const num = (v: unknown) => (typeof v === "bigint" ? Number(v) : (v as number));
const normalise = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v]));

export async function statusRows(db: DbClient): Promise<Record<string, unknown>[]> {
  return (await db.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM "EmbeddingStatus" ORDER BY "conversationId"`)).map(normalise);
}

export async function statusOf(db: DbClient, conversationId: string): Promise<Record<string, unknown> | null> {
  const [r] = await db.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM "EmbeddingStatus" WHERE "conversationId" = ?`, conversationId);
  return r ? normalise(r) : null;
}

export async function indexRow(db: DbClient): Promise<Record<string, unknown> | null> {
  const [r] = await db.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM "EmbeddingIndex" WHERE "id" = 'main'`);
  return r ? normalise(r) : null;
}

export async function chunkCount(db: DbClient, conversationId?: string): Promise<number> {
  const [r] = await db.$queryRawUnsafe<{ n: unknown }[]>(
    conversationId ? `SELECT COUNT(*) AS n FROM "EmbeddingChunk" WHERE "conversationId" = ?` : `SELECT COUNT(*) AS n FROM "EmbeddingChunk"`,
    ...(conversationId ? [conversationId] : []),
  );
  return num(r!.n);
}

/** Every chunk row (vectors as hex), in key order, for exact comparisons. */
export async function chunkDump(db: DbClient, conversationId?: string): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT "conversationId", "contentHash", "parserVersion", "sourceNodeId", "chunkIndex", "start", "end", "tokenCount", "chunkKey", hex("vector") AS v
     FROM "EmbeddingChunk" ${conversationId ? `WHERE "conversationId" = ?` : ""} ORDER BY "conversationId", "sourceNodeId", "chunkIndex"`,
    ...(conversationId ? [conversationId] : []),
  );
  return rows.map((r) => JSON.stringify(normalise(r)));
}

/** The same dump without conversation ids and epochs (to compare across databases). */
export async function chunkDumpBySource(db: DbClient): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT c."sourceId" AS src, ch."sourceNodeId", ch."chunkIndex", ch."start", ch."end", ch."tokenCount", ch."chunkKey", hex(ch."vector") AS v
     FROM "EmbeddingChunk" ch JOIN "Conversation" c ON c."id" = ch."conversationId"
     ORDER BY src, ch."sourceNodeId", ch."chunkIndex"`,
  );
  return rows.map((r) => JSON.stringify(normalise(r)));
}

export async function conversationId(db: DbClient, sourceId: string): Promise<string> {
  return (await db.conversation.findUniqueOrThrow({ where: { source_sourceId: { source: "chatgpt", sourceId } }, select: { id: true } })).id;
}

/** A synthetic linear conversation with one visible message per text (alternating user and assistant). */
export function conversationWithTexts(id: string, texts: readonly string[], updateTime = BASE_TIME): Record<string, unknown> {
  const mapping: Record<string, unknown> = { root: { id: "root", parent: null, children: texts.length > 0 ? ["n1"] : [], message: null } };
  texts.forEach((text, i) => {
    const k = i + 1;
    mapping[`n${k}`] = {
      id: `n${k}`,
      parent: k === 1 ? "root" : `n${k - 1}`,
      children: k < texts.length ? [`n${k + 1}`] : [],
      message: {
        id: `m${k}`,
        author: { role: k % 2 ? "user" : "assistant" },
        create_time: BASE_TIME + k,
        content: { content_type: "text", parts: [text] },
        status: "finished_successfully",
      },
    };
  });
  return {
    conversation_id: id,
    title: `Synthetic ${id}`,
    create_time: BASE_TIME,
    update_time: updateTime,
    current_node: texts.length ? `n${texts.length}` : "root",
    mapping,
  };
}
