import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkoutInTempDir, createTestDb, type TestDb } from "../../../tests/helpers/test-db";
import { createPrismaClient, type DbClient } from "./client";
import { DatabaseIsolationError, realDatabasePath, toDatabaseUrl } from "./path";

const ROOT = process.cwd();

const batch = (db: DbClient, over: Record<string, unknown> = {}) =>
  db.importBatch.create({
    data: {
      status: "running",
      adapter: "chatgpt",
      adapterVersion: "0.3.0",
      sourceFilename: "synthetic.json",
      sourceSha256: "0".repeat(64),
      sourceBytes: 10,
      ...over,
    },
  });

const conversation = (db: DbClient, over: Record<string, unknown> = {}) =>
  db.conversation.create({
    data: {
      source: "chatgpt",
      sourceId: "c-1",
      idSource: "conversation_id",
      pathStrategy: "current_node",
      visibleMessageCount: 0,
      nodeCount: 0,
      contentHash: `v1:${"a".repeat(64)}`,
      parserVersion: "0.3.0",
      ...over,
    },
  });

const message = (db: DbClient, conversationId: string, over: Record<string, unknown> = {}) =>
  db.message.create({ data: { conversationId, sourceNodeId: "n-1", siblingIndex: 0, ...over } });

const prismaCode = (e: unknown) => (e as { code?: string }).code;

let t: TestDb;
beforeEach(() => {
  t = createTestDb();
});
afterEach(async () => {
  await t.cleanup();
});

describe("database engine", () => {
  it("is SQLite 3.53.2 with foreign keys enforced and FTS5 available", async () => {
    const [v] = await t.db.$queryRaw<{ v: string }[]>`SELECT sqlite_version() AS v`;
    expect(v!.v).toBe("3.53.2");
    const [fk] = await t.db.$queryRaw<{ foreign_keys: bigint }[]>`PRAGMA foreign_keys`;
    expect(Number(fk!.foreign_keys)).toBe(1);
    // FTS5 probe in the temp schema only; the migrated schema is untouched.
    await t.db.$executeRawUnsafe("CREATE VIRTUAL TABLE temp.fts_probe USING fts5(body)");
    await t.db.$executeRawUnsafe("INSERT INTO temp.fts_probe(body) VALUES ('synthetic branching thread'), ('other')");
    const hits = await t.db.$queryRawUnsafe<{ body: string }[]>("SELECT body FROM temp.fts_probe WHERE fts_probe MATCH 'branch*'");
    expect(hits.map((h) => h.body)).toEqual(["synthetic branching thread"]);
  });

  it("has exactly the planned tables and indexes", async () => {
    const rows = await t.db.$queryRaw<{ type: string; name: string }[]>`
      SELECT type, name FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' AND name <> '_prisma_migrations' ORDER BY type, name`;
    expect(rows.map((r) => `${r.type}:${r.name}`)).toEqual([
      "index:Conversation_firstImportBatchId_idx",
      "index:Conversation_lastImportBatchId_idx",
      "index:Conversation_source_sourceId_key",
      "index:Conversation_updatedAtSec_idx",
      // Semantic index (M5.1b).
      "index:EmbeddingChunk_epoch_idx",
      "index:EmbeddingStatus_state_queuedAt_idx",
      "index:ImportBatch_sourceSha256_idx",
      "index:ImportBatch_startedAt_idx",
      "index:Message_conversationId_parentSourceNodeId_idx",
      "index:Message_conversationId_pathIndex_idx",
      "index:Message_conversationId_sourceNodeId_key",
      "table:Conversation",
      "table:EmbeddingChunk",
      "table:EmbeddingIndex",
      "table:EmbeddingStatus",
      "table:ImportBatch",
      "table:Message",
      // Search index (M2.1): two FTS5 virtual tables and their shadow tables.
      "table:conversation_fts",
      "table:conversation_fts_config",
      "table:conversation_fts_data",
      "table:conversation_fts_docsize",
      "table:conversation_fts_idx",
      "table:message_fts",
      "table:message_fts_config",
      "table:message_fts_data",
      "table:message_fts_docsize",
      "table:message_fts_idx",
      // Prisma does not see triggers, so this list is their drift check.
      "trigger:conversation_fts_after_delete",
      "trigger:conversation_fts_after_insert",
      "trigger:conversation_fts_after_update",
      "trigger:message_fts_after_delete",
      "trigger:message_fts_after_insert",
      "trigger:message_fts_after_update",
    ]);
  });
});

describe("semantic index tables (M5.1b)", () => {
  type Col = { name: string; type: string; notnull: bigint; pk: bigint };
  const columns = async (table: string) =>
    (await t.db.$queryRawUnsafe<Col[]>(`PRAGMA table_info("${table}")`)).map((c) => `${c.name}:${c.type}:${Number(c.notnull) ? "NN" : "NULL"}:${Number(c.pk)}`);
  const foreignKeys = async (table: string) =>
    (await t.db.$queryRawUnsafe<{ table: string; from: string; to: string; on_delete: string }[]>(`PRAGMA foreign_key_list("${table}")`)).map(
      (f) => `${f.from}->${f.table}.${f.to}:${f.on_delete}`,
    );

  it("have exactly the reviewed columns and primary keys", async () => {
    expect(await columns("EmbeddingIndex")).toEqual([
      "id:TEXT:NN:1", "epoch:INTEGER:NN:0", "embeddingVersion:TEXT:NN:0", "chunkerVersion:TEXT:NN:0", "chunkTokens:INTEGER:NN:0",
      "quantization:TEXT:NN:0", "dimensions:INTEGER:NN:0", "changeCounter:INTEGER:NN:0", "lastErrorCode:TEXT:NULL:0", "updatedAt:DATETIME:NN:0",
    ]);
    expect(await columns("EmbeddingStatus")).toEqual([
      "conversationId:TEXT:NN:1", "contentHash:TEXT:NN:0", "parserVersion:TEXT:NN:0", "epoch:INTEGER:NN:0", "state:TEXT:NN:0",
      "claimToken:TEXT:NULL:0", "attempts:INTEGER:NN:0", "chunkCount:INTEGER:NULL:0", "lastErrorCode:TEXT:NULL:0",
      "queuedAt:DATETIME:NN:0", "updatedAt:DATETIME:NN:0",
    ]);
    // Composite primary key (conversationId, sourceNodeId, chunkIndex): pk positions 1, 2, 3.
    expect(await columns("EmbeddingChunk")).toEqual([
      "conversationId:TEXT:NN:1", "contentHash:TEXT:NN:0", "parserVersion:TEXT:NN:0", "epoch:INTEGER:NN:0", "sourceNodeId:TEXT:NN:2",
      "chunkIndex:INTEGER:NN:3", "start:INTEGER:NN:0", "end:INTEGER:NN:0", "tokenCount:INTEGER:NN:0", "chunkKey:TEXT:NN:0", "vector:BLOB:NN:0",
    ]);
  });

  it("cascade from Conversation, and the index row has no foreign key", async () => {
    expect(await foreignKeys("EmbeddingStatus")).toEqual(["conversationId->Conversation.id:CASCADE"]);
    expect(await foreignKeys("EmbeddingChunk")).toEqual(["conversationId->Conversation.id:CASCADE"]);
    expect(await foreignKeys("EmbeddingIndex")).toEqual([]);
  });

  it("use no AUTOINCREMENT: there is no sqlite_sequence table", async () => {
    const rows = await t.db.$queryRawUnsafe<{ name: string }[]>(`SELECT name FROM sqlite_master WHERE name = 'sqlite_sequence'`);
    expect(rows).toEqual([]);
    const sql = await t.db.$queryRawUnsafe<{ sql: string }[]>(`SELECT sql FROM sqlite_master WHERE name LIKE 'Embedding%' AND sql IS NOT NULL`);
    expect(sql.some((r) => /AUTOINCREMENT/i.test(r.sql))).toBe(false);
  });

  it("are created empty by the migration (the index row appears only at the first Start)", async () => {
    const [r] = await t.db.$queryRawUnsafe<{ i: bigint; s: bigint; c: bigint }[]>(
      `SELECT (SELECT COUNT(*) FROM "EmbeddingIndex") AS i, (SELECT COUNT(*) FROM "EmbeddingStatus") AS s, (SELECT COUNT(*) FROM "EmbeddingChunk") AS c`,
    );
    expect([Number(r!.i), Number(r!.s), Number(r!.c)]).toEqual([0, 0, 0]);
  });

  it("deleting a conversation removes its status row and chunks (cascade)", async () => {
    const c = await conversation(t.db);
    const keep = await conversation(t.db, { sourceId: "keep" });
    const now = "2026-11-11T00:00:00.000+00:00";
    for (const id of [c.id, keep.id]) {
      await t.db.$executeRawUnsafe(
        `INSERT INTO "EmbeddingStatus" VALUES (?, 'h', 'p', 1, 'indexed', NULL, 1, 1, NULL, ?, ?)`, id, now, now,
      );
      await t.db.$executeRawUnsafe(`INSERT INTO "EmbeddingChunk" VALUES (?, 'h', 'p', 1, 'n-1', 0, 0, 1, 1, 'k', x'00')`, id);
    }
    await t.db.conversation.delete({ where: { id: c.id } });
    expect(await t.db.embeddingStatus.count()).toBe(1);
    expect(await t.db.embeddingChunk.count()).toBe(1);
    await expect(
      t.db.$executeRawUnsafe(`INSERT INTO "EmbeddingChunk" VALUES ('no-such-conversation', 'h', 'p', 1, 'n-1', 0, 0, 1, 1, 'k', x'00')`),
    ).rejects.toBeDefined();
  });
});

describe("defaults and types", () => {
  it("defaults counters to 0, flags to false and content text to empty", async () => {
    const b = await batch(t.db);
    expect(b).toMatchObject({
      conversationsSeen: 0, conversationsAdded: 0, conversationsUpdated: 0, conversationsUnchanged: 0,
      conversationsOlder: 0, conversationsFlagged: 0, conversationsSkipped: 0, finishedAt: null, warningsJson: null,
    });
    expect(b.startedAt).toBeInstanceOf(Date);
    const c = await conversation(t.db);
    const m = await message(t.db, c.id);
    expect(m).toMatchObject({ isStructural: false, isMalformed: false, hasUnsupportedParts: false, isHidden: false, contentText: "", pathIndex: null, role: null });
  });

  it("keeps sub-millisecond source timestamps exactly (Float epoch seconds)", async () => {
    // One microsecond apart: distinct doubles at this magnitude (spacing ≈ 2.4e-7 s),
    // but equal after DateTime's millisecond rounding.
    const created = 1767225600.123456;
    const updated = 1767225600.123457;
    expect(updated > created).toBe(true);
    expect(Math.floor(updated * 1000)).toBe(Math.floor(created * 1000));
    const c = await conversation(t.db, { createdAtSec: created, updatedAtSec: updated });
    const back = await t.db.conversation.findUniqueOrThrow({ where: { id: c.id } });
    expect(back.createdAtSec).toBe(created);
    expect(back.updatedAtSec).toBe(updated);
    expect(back.updatedAtSec! > back.createdAtSec!).toBe(true);
  });
});

describe("identity", () => {
  it("uses an internal primary key, independent of the source ID", async () => {
    const c = await conversation(t.db, { sourceId: "c-1" });
    expect(c.id).not.toBe("c-1");
    expect(c.id).toMatch(/^c[a-z0-9]{20,}$/);
  });

  it("makes (source, sourceId) unique, so providers cannot collide", async () => {
    await conversation(t.db, { source: "chatgpt", sourceId: "same" });
    await expect(conversation(t.db, { source: "other-provider", sourceId: "same" })).resolves.toBeDefined();
    await expect(conversation(t.db, { source: "chatgpt", sourceId: "same" })).rejects.toSatisfy((e) => prismaCode(e) === "P2002");
  });

  it("makes a node key unique within its conversation only", async () => {
    const a = await conversation(t.db, { sourceId: "a" });
    const b = await conversation(t.db, { sourceId: "b" });
    await message(t.db, a.id, { sourceNodeId: "n" });
    await expect(message(t.db, b.id, { sourceNodeId: "n" })).resolves.toBeDefined();
    await expect(message(t.db, a.id, { sourceNodeId: "n" })).rejects.toSatisfy((e) => prismaCode(e) === "P2002");
  });
});

describe("relations and deletion", () => {
  it("rejects a message for a conversation that does not exist", async () => {
    await expect(message(t.db, "no-such-conversation")).rejects.toSatisfy((e) => prismaCode(e) === "P2003");
  });

  it("keeps a dangling parent reference as plain text (not a foreign key)", async () => {
    const c = await conversation(t.db);
    const m = await message(t.db, c.id, { parentSourceNodeId: "missing-node" });
    expect(m.parentSourceNodeId).toBe("missing-node");
  });

  it("deleting a conversation deletes its messages, including raw payloads", async () => {
    const c = await conversation(t.db);
    const keep = await conversation(t.db, { sourceId: "keep" });
    await message(t.db, c.id, { sourceNodeId: "n-1", rawContentJson: '{"synthetic":true}' });
    await message(t.db, c.id, { sourceNodeId: "n-2" });
    await message(t.db, keep.id, { sourceNodeId: "n-1" });
    await t.db.conversation.delete({ where: { id: c.id } });
    expect(await t.db.message.count({ where: { conversationId: c.id } })).toBe(0);
    expect(await t.db.message.count()).toBe(1);
    const [raw] = await t.db.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*) AS n FROM "Message" WHERE "rawContentJson" IS NOT NULL`;
    expect(Number(raw!.n)).toBe(0);
  });

  it("deleting an import batch keeps its conversations and clears their references", async () => {
    const first = await batch(t.db);
    const last = await batch(t.db);
    const c = await conversation(t.db, { firstImportBatchId: first.id, lastImportBatchId: last.id });
    await t.db.importBatch.delete({ where: { id: first.id } });
    expect(await t.db.conversation.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ firstImportBatchId: null, lastImportBatchId: last.id });
    await t.db.importBatch.delete({ where: { id: last.id } });
    expect(await t.db.conversation.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ firstImportBatchId: null, lastImportBatchId: null });
  });

  it("supports the delete-all policy: all three tables emptied in one transaction", async () => {
    const b = await batch(t.db);
    const c = await conversation(t.db, { firstImportBatchId: b.id, lastImportBatchId: b.id });
    await message(t.db, c.id, { rawContentJson: "{}" });
    await t.db.$transaction([t.db.message.deleteMany(), t.db.conversation.deleteMany(), t.db.importBatch.deleteMany()]);
    expect([await t.db.message.count(), await t.db.conversation.count(), await t.db.importBatch.count()]).toEqual([0, 0, 0]);
  });
});

describe("rawContentJson is never returned unless asked for (A37)", () => {
  it("is omitted from ordinary queries and returned only with an explicit opt-in", async () => {
    const c = await conversation(t.db);
    await message(t.db, c.id, { rawContentJson: '{"content_type":"synthetic"}' });
    const plain = await t.db.message.findFirstOrThrow({ where: { conversationId: c.id } });
    expect("rawContentJson" in plain).toBe(false);
    const viaRelation = await t.db.conversation.findUniqueOrThrow({ where: { id: c.id }, include: { messages: true } });
    expect("rawContentJson" in viaRelation.messages[0]!).toBe(false);
    const optIn = await t.db.message.findFirstOrThrow({ where: { conversationId: c.id }, omit: { rawContentJson: false } });
    expect(optIn.rawContentJson).toBe('{"content_type":"synthetic"}');
  });
});

describe("the real database is protected (fails closed)", () => {
  // The real database is never targeted, not even to prove it is refused: these tests use
  // a decoy project root in the temp directory with its own data/threadatlas.db, and
  // check that the decoy is never opened, changed or joined by sidecar files.
  let outside: string;
  let decoyRoot: string;
  let decoyDb: string;
  const decoyState = () => ({ bytes: fs.readFileSync(decoyDb, "latin1"), mtimeMs: fs.statSync(decoyDb).mtimeMs, files: fs.readdirSync(path.dirname(decoyDb)).sort() });
  let decoyBefore: ReturnType<typeof decoyState>;
  beforeAll(() => {
    outside = fs.mkdtempSync(path.join(ROOT, "test-results-int-"));
    decoyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "threadatlas-decoy-root-"));
    decoyDb = realDatabasePath(decoyRoot);
    fs.mkdirSync(path.dirname(decoyDb), { mode: 0o700 });
    fs.writeFileSync(decoyDb, "DECOY, NOT A DATABASE");
    decoyBefore = decoyState();
  });
  afterAll(() => {
    fs.rmSync(outside, { recursive: true, force: true });
    // Nothing created, opened for writing or changed the decoy's default database.
    expect(decoyState()).toEqual(decoyBefore);
    fs.rmSync(decoyRoot, { recursive: true, force: true });
  });

  it("refuses to open the default database of a project under test", () => {
    expect(() => createPrismaClient({ env: { THREADATLAS_TEST: "1" }, root: decoyRoot })).toThrow(DatabaseIsolationError);
  });

  it.skipIf(checkoutInTempDir(ROOT))("refuses a database outside the temp directory under test", () => {
    const env = { THREADATLAS_TEST: "1", DATABASE_URL: toDatabaseUrl(path.join(outside, "x.db")) };
    expect(() => createPrismaClient({ env, root: ROOT })).toThrow(/inside the system temp directory/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("never creates a missing database file (fileMustExist)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "threadatlas-missing-"));
    const file = path.join(dir, "missing.db");
    const db = createPrismaClient({ env: { THREADATLAS_TEST: "1", DATABASE_URL: toDatabaseUrl(file) }, root: ROOT });
    await expect(db.conversation.count()).rejects.toBeDefined();
    await db.$disconnect();
    expect(fs.existsSync(file)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the Prisma CLI, with the project's config, refuses to migrate the default database under test", () => {
    // Run from the decoy root: prisma.config.ts takes the working directory as the root.
    const cli = path.join(ROOT, "node_modules", "prisma", "build", "index.js");
    const env: NodeJS.ProcessEnv = { ...process.env, THREADATLAS_TEST: "1", CHECKPOINT_DISABLE: "1", PRISMA_HIDE_UPDATE_MESSAGE: "1" };
    delete env.DATABASE_URL;
    let stderr = "";
    try {
      execFileSync(process.execPath, [cli, "migrate", "deploy", "--config", path.join(ROOT, "prisma.config.ts")], {
        cwd: decoyRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      stderr = String((e as { stderr?: Buffer }).stderr ?? "");
    }
    expect(stderr).toContain("Tests must never use the real database");
  }, 60_000);
});

describe("migrations", () => {
  it("match the Prisma schema apart from exactly the search-index tables (db:check-migrations)", () => {
    const out = execFileSync(process.execPath, [path.join(ROOT, "scripts", "check-migrations.mjs")], {
      cwd: ROOT,
      env: { ...process.env, THREADATLAS_TEST: "1", DATABASE_URL: toDatabaseUrl(t.file), CHECKPOINT_DISABLE: "1", PRISMA_HIDE_UPDATE_MESSAGE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
    expect(out).toContain("apart from the 10 search-index tables (expected)");
  }, 60_000);
});
