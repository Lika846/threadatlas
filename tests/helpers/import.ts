import { createHash } from "node:crypto";
import type { DbClient } from "../../src/lib/db/client";
import { importAdapterResult, type ImportDeps, type ImportOutcome } from "../../src/lib/import/import-service";
import { validateExportText } from "../../src/lib/import/validate-export";

/** Parses synthetic export text and imports it through the real service. */
export async function importText(text: string, deps: ImportDeps): Promise<ImportOutcome> {
  const parsed = validateExportText(text);
  if (!parsed.ok) throw new Error(`synthetic export must parse, got ${parsed.error.code}`);
  return importAdapterResult(
    parsed,
    { filename: "synthetic.json", sha256: createHash("sha256").update(text).digest("hex"), byteLength: Buffer.byteLength(text) },
    deps,
  );
}

/**
 * Canonical dump of all stored conversation data (raw payloads included),
 * without generated IDs and batch links, for comparing final states.
 */
export async function dumpConversations(db: DbClient): Promise<string> {
  const conversations = await db.conversation.findMany({
    orderBy: [{ source: "asc" }, { sourceId: "asc" }],
    omit: { id: true, firstImportBatchId: true, lastImportBatchId: true },
    include: {
      messages: {
        orderBy: { sourceNodeId: "asc" },
        omit: { id: true, conversationId: true, rawContentJson: false },
      },
    },
  });
  return JSON.stringify(conversations);
}

/** Every row of every table, including generated IDs (byte-for-byte state checks). */
export async function dumpExact(db: DbClient): Promise<string> {
  const [batches, conversations, messages] = await Promise.all([
    db.importBatch.findMany({ orderBy: { id: "asc" } }),
    db.conversation.findMany({ orderBy: { id: "asc" } }),
    db.message.findMany({ orderBy: { id: "asc" }, omit: { rawContentJson: false } }),
  ]);
  return JSON.stringify({ batches, conversations, messages });
}

export async function batchRow(db: DbClient, id: string) {
  return db.importBatch.findUniqueOrThrow({ where: { id } });
}

/** Changes made by this connection since it opened (SQLite `total_changes()`). */
export async function totalChanges(db: DbClient): Promise<number> {
  const [r] = await db.$queryRawUnsafe<{ n: bigint }[]>("SELECT total_changes() AS n");
  return Number(r!.n);
}

/** Integrity: every conversation has exactly `nodeCount` message rows. */
export async function partialConversations(db: DbClient): Promise<number> {
  const [r] = await db.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*) AS n FROM "Conversation" c
     WHERE c."nodeCount" <> (SELECT COUNT(*) FROM "Message" m WHERE m."conversationId" = c."id")`,
  );
  return Number(r!.n);
}
