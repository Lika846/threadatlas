/**
 * M5.1b migration rehearsal (opt-in: about 20–30 s, it runs the Prisma CLI many times):
 *
 *   THREADATLAS_REHEARSAL=1 npx vitest run --project int tests/semantic-migration-rehearsal.int.test.ts
 *
 * Committed form of the pre-implementation rehearsal
 * (docs/spikes/m5.1b/migration/rehearsal.int.test.ts.txt), run against the committed
 * migration. It rehearses the real-database procedure (design §10) on synthetic copies:
 * backup, deploy, verification (data and schema fingerprints, FTS5, drift), delete-all
 * with the new tables, rollback by backup restore and by the rollback SQL, a deliberately
 * failing migration, and the path guards.
 *
 * - **An M2 database:** the import code now writes status rows (I2), so it cannot fill
 *   an M2 database directly. The synthetic data are imported into a fully migrated copy,
 *   which the reviewed rollback SQL then returns to the M2 schema; the result is checked
 *   to have exactly the schema of a database migrated with the M2 migrations only.
 * - **Workspaces:** throwaway Prisma workspaces inside the project (removed afterwards)
 *   hold the M2 migrations or a deliberately broken migration; every database lives in
 *   the system temp directory. Set M51B_REHEARSAL_REPORT=<file> for the numbers.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeDrift } from "../scripts/migration-drift.mjs";
import { importText } from "./helpers/import";
import { exportText, syntheticConversation, syntheticExport } from "./helpers/synthetic-export";
import { createPrismaClient } from "../src/lib/db/client";
import { assertDatabaseIsolation, realDatabasePath, toDatabaseUrl } from "../src/lib/db/path";
import { deleteAllImportedData } from "../src/lib/data/delete-all";
import { searchConversations } from "../src/lib/search/search";

const RUN = process.env.THREADATLAS_REHEARSAL === "1";
const ROOT = process.cwd();
const NAME = "20261111120000_semantic_index";
const MIGRATION = fs.readFileSync(path.join(ROOT, "prisma/migrations", NAME, "migration.sql"), "utf8");
const ROLLBACK = fs.readFileSync(path.join(ROOT, "docs/spikes/m5.1b/migration/rollback.sql"), "utf8");
/** SHA-256 of prisma/schema.prisma at the end of M2 (commit d5dc87d). */
const M2_SCHEMA_SHA256 = "68367647a2bfcc4cb813abc7beeebf7db986b22e9bd985c811fa1e5ceeb9fa59";
const CANARY = Buffer.from("M51B-CANARY-VECTOR-".repeat(21)).subarray(0, 388);
const NEW_TABLES = ["EmbeddingChunk", "EmbeddingIndex", "EmbeddingStatus"];
const report: Record<string, unknown> = {};

let tmp: string;
const workspaces: string[] = [];
const env = (db: string) => ({ ...process.env, DATABASE_URL: toDatabaseUrl(db), THREADATLAS_TEST: "1", CHECKPOINT_DISABLE: "1", PRISMA_HIDE_UPDATE_MESSAGE: "1" });

function cli(cwd: string, db: string, args: string[]) {
  const t = performance.now();
  const r = spawnSync(process.execPath, [path.join(ROOT, "node_modules/prisma/build/index.js"), ...args], { cwd, env: env(db), encoding: "utf8", input: "" });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}`, ms: Math.round(performance.now() - t) };
}

/** The M2 schema: today's schema without the three M5.1b models and the two back-relations. */
function m2Schema(): string {
  const s = fs.readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf8");
  const withoutRelations = s.replace(
    "  /// Semantic index (M5.1b): derived data, removed with the conversation\n  embeddingStatus     EmbeddingStatus?\n  embeddingChunks     EmbeddingChunk[]\n",
    "",
  );
  const start = withoutRelations.indexOf("\n/// Semantic index configuration and counters (M5.1b).");
  return withoutRelations.slice(0, start);
}

/** A throwaway Prisma workspace: the project's config and migrations, then `edit`. */
function workspace(edit: (prismaDir: string) => void): string {
  const w = fs.mkdtempSync(path.join(ROOT, ".m51b-ws-"));
  workspaces.push(w);
  fs.mkdirSync(path.join(w, "src/lib/db"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "src/lib/db/path.ts"), path.join(w, "src/lib/db/path.ts"));
  fs.copyFileSync(path.join(ROOT, "prisma.config.ts"), path.join(w, "prisma.config.ts"));
  fs.cpSync(path.join(ROOT, "prisma"), path.join(w, "prisma"), { recursive: true });
  edit(path.join(w, "prisma"));
  return w;
}
const m2Workspace = () =>
  workspace((p) => {
    fs.rmSync(path.join(p, "migrations", NAME), { recursive: true });
    fs.writeFileSync(path.join(p, "schema.prisma"), m2Schema());
  });

const copy = (from: string, name: string) => {
  const to = path.join(tmp, name);
  fs.copyFileSync(from, to);
  return to;
};

const hex = (v: unknown) => (Buffer.isBuffer(v) ? v.toString("hex") : v);
const sha = (x: unknown) => createHash("sha256").update(JSON.stringify(x, (_k, v) => hex(v))).digest("hex");

/** Fingerprints of everything that must not change, plus the new objects. */
function inspect(file: string) {
  const db = new Database(file, { readonly: true });
  try {
    const all = (sql: string) => db.prepare(sql).all() as Record<string, unknown>[];
    const rows = (t: string) => all(`SELECT * FROM "${t}" ORDER BY rowid`);
    const master = all(`SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`);
    const isNew = (m: Record<string, unknown>) => NEW_TABLES.includes(String(m.tbl_name));
    const has = (t: string) => master.some((m) => m.type === "table" && m.name === t);
    const one = (sql: string) => Object.values(db.prepare(sql).get() as Record<string, unknown>)[0];
    return {
      data: sha({ b: rows("ImportBatch"), c: rows("Conversation"), m: rows("Message") }),
      counts: all(`SELECT (SELECT COUNT(*) FROM "Conversation") AS c, (SELECT COUNT(*) FROM "Message") AS m, (SELECT COUNT(*) FROM "ImportBatch") AS b`)[0],
      oldMigrations: sha(all(`SELECT migration_name, checksum, finished_at, rolled_back_at, applied_steps_count FROM _prisma_migrations WHERE migration_name <> '${NAME}' ORDER BY migration_name`)),
      thisMigration: all(`SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolledBack FROM _prisma_migrations WHERE migration_name = '${NAME}'`),
      oldSchema: sha(master.filter((m) => !isNew(m))),
      newObjects: master.filter(isNew).map((m) => `${m.type}:${m.name}`),
      newRows: Object.fromEntries(NEW_TABLES.filter(has).map((t) => [t, Number(one(`SELECT COUNT(*) FROM "${t}"`))])),
      sqliteSequence: has("sqlite_sequence"),
      integrity: one("PRAGMA integrity_check"),
      foreignKeyViolations: all("PRAGMA foreign_key_check").length,
      freePages: Number(one("PRAGMA freelist_count")),
    };
  } finally {
    db.close();
  }
}

function ftsIntegrity(file: string): boolean {
  const db = new Database(file);
  try {
    db.exec(`INSERT INTO "message_fts"("message_fts") VALUES('integrity-check')`);
    db.exec(`INSERT INTO "conversation_fts"("conversation_fts") VALUES('integrity-check')`);
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

async function searches(file: string) {
  const db = createPrismaClient({ env: { THREADATLAS_TEST: "1", DATABASE_URL: toDatabaseUrl(file) }, root: ROOT });
  try {
    const out: Record<string, unknown> = {};
    for (const q of ["budsjett", "семена", "synthetic message", "kanariefugl"]) {
      const r = await searchConversations(db, q, undefined);
      out[q] = r.status === "ok" ? { total: r.total, ids: r.results.map((x) => x.conversationId), snippets: r.results.map((x) => x.snippet) } : r;
    }
    return sha(out);
  } finally {
    await db.$disconnect();
  }
}

function driftOk(cwd: string, db: string, args: string[]) {
  const out = path.join(tmp, `drift-${Math.random().toString(36).slice(2)}.sql`);
  const r = cli(cwd, db, ["migrate", "diff", ...args, "--script", "--output", out]);
  if (r.code !== 0) return { ok: false, unexpected: [] as string[] };
  const res = analyzeDrift(fs.readFileSync(out, "utf8")) as { ok: boolean; unexpected: string[]; missing: string[] };
  return { ok: res.ok, unexpected: res.unexpected, missing: res.missing };
}

let base: string; // populated M2 database
let backup: string;
let before: ReturnType<typeof inspect>;
let beforeSearch: string;
let m2ws: string;

describe.skipIf(!RUN)("M5.1b migration rehearsal (opt-in)", { timeout: 180_000 }, () => {
  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "threadatlas-m51b-rehearsal-"));
    expect(createHash("sha256").update(m2Schema()).digest("hex")).toBe(M2_SCHEMA_SHA256);
    m2ws = m2Workspace();
    // A pure M2 database (M2 migrations only), for the schema comparison.
    const pure = path.join(tmp, "pure-m2.db");
    expect(cli(m2ws, pure, ["migrate", "deploy"]).code).toBe(0);
    // Synthetic data through the real import, into a fully migrated database, then back to M2.
    base = path.join(tmp, "m2.db");
    expect(cli(ROOT, base, ["migrate", "deploy"]).code).toBe(0);
    const db = createPrismaClient({ env: { THREADATLAS_TEST: "1", DATABASE_URL: toDatabaseUrl(base) }, root: ROOT });
    const convs: unknown[] = [
      ...syntheticExport(40, { messages: 8, idPrefix: "bulk" }),
      syntheticConversation({ id: "no-1", tag: "Hagen trenger et budsjett for frø", messages: 4 }),
      syntheticConversation({ id: "ru-1", tag: "Бюджет на семена и инструменты", messages: 4 }),
      syntheticConversation({ id: "long-1", messages: 1_200, textLength: 300 }),
      syntheticConversation({ id: "canary-text", tag: "kanariefugl", messages: 2 }),
    ];
    await importText(exportText(convs), { writer: { db, dbPath: base } });
    // A second import replacing some conversations, so the history includes replacements.
    await importText(exportText(syntheticExport(5, { messages: 3, idPrefix: "bulk", updateTime: 1_800_000_000, tag: "v2" })), { writer: { db, dbPath: base } });
    await db.$disconnect();
    const raw = new Database(base);
    raw.exec(ROLLBACK);
    raw.close();
    before = inspect(base);
    expect(before.newObjects).toEqual([]);
    expect(before.oldSchema).toBe(inspect(pure).oldSchema);
    const names = (file: string) => {
      const d = new Database(file, { readonly: true });
      try {
        return d.prepare(`SELECT migration_name FROM _prisma_migrations ORDER BY migration_name`).all();
      } finally {
        d.close();
      }
    };
    expect(names(base)).toEqual(names(pure));
    beforeSearch = await searches(base);
    report.populated = { ...(before.counts as object), bytes: fs.statSync(base).size };
  }, 180_000);

  afterAll(() => {
    for (const w of workspaces) fs.rmSync(w, { recursive: true, force: true });
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    const out = process.env.M51B_REHEARSAL_REPORT;
    if (out) fs.writeFileSync(out, JSON.stringify(report, null, 1));
  });

  it("backs up the populated M2 database with the SQLite backup API and verifies the copy", async () => {
    const src = new Database(base, { readonly: true });
    backup = path.join(tmp, "backup.db");
    await src.backup(backup);
    src.close();
    const b = inspect(backup);
    expect(b.integrity).toBe("ok");
    expect([b.data, b.oldMigrations, b.oldSchema]).toEqual([before.data, before.oldMigrations, before.oldSchema]);
  });

  it("deploys only the new migration and leaves every existing row, object and FTS5 index unchanged", async () => {
    const db = copy(base, "deploy.db");
    const st0 = cli(ROOT, db, ["migrate", "status"]);
    expect(st0.out).toContain(NAME); // pending
    const r = cli(ROOT, db, ["migrate", "deploy"]);
    report.deploy = { code: r.code, ms: r.ms };
    expect(r.code).toBe(0);
    expect(r.out).toContain(NAME);
    const a = inspect(db);
    report.afterDeploy = { newObjects: a.newObjects, sqliteSequence: a.sqliteSequence };
    expect(a.integrity).toBe("ok");
    expect(a.foreignKeyViolations).toBe(0);
    expect([a.data, a.oldMigrations, a.oldSchema]).toEqual([before.data, before.oldMigrations, before.oldSchema]);
    expect(a.thisMigration).toEqual([{ migration_name: NAME, finished: 1, rolledBack: 0 }]);
    expect([...a.newObjects].sort()).toEqual(
      [
        "index:EmbeddingChunk_epoch_idx",
        "index:EmbeddingStatus_state_queuedAt_idx",
        "index:sqlite_autoindex_EmbeddingChunk_1",
        "index:sqlite_autoindex_EmbeddingIndex_1",
        "index:sqlite_autoindex_EmbeddingStatus_1",
        "table:EmbeddingChunk",
        "table:EmbeddingIndex",
        "table:EmbeddingStatus",
      ].sort(),
    );
    expect(a.newRows).toEqual({ EmbeddingChunk: 0, EmbeddingIndex: 0, EmbeddingStatus: 0 });
    expect(a.sqliteSequence).toBe(false);
    expect(ftsIntegrity(db)).toBe(true);
    expect(await searches(db)).toBe(beforeSearch);
    const st = cli(ROOT, db, ["migrate", "status"]);
    expect(st.code).toBe(0);
    expect(st.out).toMatch(/up to date/i);
    const files = driftOk(ROOT, db, ["--from-migrations", "prisma/migrations", "--to-schema", "prisma/schema.prisma"]);
    const live = driftOk(ROOT, db, ["--from-config-datasource", "--to-schema", "prisma/schema.prisma"]);
    report.drift = { migrationsVsSchema: files, databaseVsSchema: live };
    expect(files.ok).toBe(true);
    expect(live.ok).toBe(true);
    const again = cli(ROOT, db, ["migrate", "deploy"]);
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/No pending migrations/i);
    expect(inspect(db).data).toBe(before.data);
  });

  it("the drift check flags the new schema without its migration", () => {
    const noMigration = workspace((p) => fs.rmSync(path.join(p, "migrations", NAME), { recursive: true }));
    const r = driftOk(noMigration, path.join(tmp, "unused.db"), ["--from-migrations", "prisma/migrations", "--to-schema", "prisma/schema.prisma"]);
    expect(r.ok).toBe(false);
    expect(r.unexpected?.some((s) => s.includes("EmbeddingChunk"))).toBe(true);
  });

  it("delete-all (I3) on the migrated database removes status and chunk rows, keeps EmbeddingIndex, and leaves no vector bytes", async () => {
    const db = copy(base, "delete.db");
    expect(cli(ROOT, db, ["migrate", "deploy"]).code).toBe(0);
    const raw = new Database(db);
    raw.exec(`INSERT INTO "EmbeddingIndex" VALUES ('main', 1, 'e', 'c', 64, 'q', 384, 0, NULL, '2026-11-11T00:00:00.000+00:00')`);
    const ids = raw.prepare(`SELECT "id", "contentHash", "parserVersion" FROM "Conversation"`).all() as { id: string; contentHash: string; parserVersion: string }[];
    const st = raw.prepare(`INSERT INTO "EmbeddingStatus" VALUES (?, ?, ?, 1, 'indexed', NULL, 1, 3, NULL, '2026-11-11T00:00:00.000+00:00', '2026-11-11T00:00:00.000+00:00')`);
    const ch = raw.prepare(`INSERT INTO "EmbeddingChunk" VALUES (?, ?, ?, 1, ?, 0, 0, 10, 5, ?, ?)`);
    raw.exec("BEGIN");
    for (const c of ids) {
      st.run(c.id, c.contentHash, c.parserVersion);
      for (const n of ["n1", "n2", "n3"]) ch.run(c.id, c.contentHash, c.parserVersion, n, "k".repeat(32), CANARY);
    }
    raw.exec("COMMIT");
    raw.close();
    expect(fs.readFileSync(db).includes(CANARY)).toBe(true);
    const client = createPrismaClient({ env: { THREADATLAS_TEST: "1", DATABASE_URL: toDatabaseUrl(db) }, root: ROOT });
    const res = await deleteAllImportedData({ writer: { db: client, dbPath: db } });
    await client.$disconnect();
    report.deleteAll = { status: res.status, seededStatusRows: ids.length, seededChunks: ids.length * 3 };
    expect(res.status).toBe("complete");
    const a = inspect(db);
    expect(a.newRows).toEqual({ EmbeddingChunk: 0, EmbeddingIndex: 1, EmbeddingStatus: 0 });
    expect(a.freePages).toBe(0);
    expect(a.integrity).toBe("ok");
    expect(fs.readFileSync(db).includes(CANARY)).toBe(false);
    expect(fs.readFileSync(db).includes(Buffer.from("M51B-CANARY"))).toBe(false);
    expect(ftsIntegrity(db)).toBe(true);
  });

  it("rollback A: restoring the backup returns the exact M2 state, and the migration can be applied again", async () => {
    const db = path.join(tmp, "restored.db");
    const src = new Database(backup, { readonly: true });
    await src.backup(db);
    src.close();
    const r = inspect(db);
    expect([r.data, r.oldSchema, r.oldMigrations]).toEqual([before.data, before.oldSchema, before.oldMigrations]);
    expect(r.newObjects).toEqual([]);
    expect(cli(ROOT, db, ["migrate", "status"]).out).toContain(NAME); // not yet applied
    expect(cli(ROOT, db, ["migrate", "deploy"]).code).toBe(0);
    expect(inspect(db).data).toBe(before.data);
  });

  it("rollback B: the rollback SQL returns the M2 schema exactly; the M2 migrations report up to date with no drift; redeploy works", async () => {
    const db = copy(base, "rollback.db");
    expect(cli(ROOT, db, ["migrate", "deploy"]).code).toBe(0);
    const raw = new Database(db);
    raw.exec(ROLLBACK);
    raw.close();
    const r = inspect(db);
    expect(r.newObjects).toEqual([]);
    expect(r.thisMigration).toEqual([]);
    expect(r.sqliteSequence).toBe(false);
    expect([r.data, r.oldSchema, r.oldMigrations]).toEqual([before.data, before.oldSchema, before.oldMigrations]);
    expect(r.integrity).toBe("ok");
    expect(ftsIntegrity(db)).toBe(true);
    const m2Status = cli(m2ws, db, ["migrate", "status"]);
    expect(m2Status.code).toBe(0);
    expect(m2Status.out).toMatch(/up to date/i);
    expect(driftOk(m2ws, db, ["--from-config-datasource", "--to-schema", "prisma/schema.prisma"]).ok).toBe(true);
    expect(cli(ROOT, db, ["migrate", "deploy"]).code).toBe(0);
    expect(inspect(db).newObjects).toHaveLength(8);
  });

  it("a migration that fails part-way leaves no partial schema and no data change; deploy then refuses until resolved", async () => {
    const db = copy(base, "failing.db");
    const broken = MIGRATION.replace("\nCOMMIT;", `\nCREATE TABLE "Conversation" ("x" TEXT);\n\nCOMMIT;`);
    expect(broken).not.toBe(MIGRATION);
    const bad = workspace((p) => fs.writeFileSync(path.join(p, "migrations", NAME, "migration.sql"), broken));
    const r = cli(bad, db, ["migrate", "deploy"]);
    expect(r.code).not.toBe(0);
    const a = inspect(db);
    report.failing = { code: r.code, newObjects: a.newObjects, migrationRow: a.thisMigration };
    expect(a.newObjects).toEqual([]); // the CREATE TABLEs before the error were rolled back
    expect([a.data, a.oldSchema, a.oldMigrations]).toEqual([before.data, before.oldSchema, before.oldMigrations]);
    expect(a.integrity).toBe("ok");
    expect(ftsIntegrity(db)).toBe(true);
    const again = cli(ROOT, db, ["migrate", "deploy"]);
    report.failing = { ...(report.failing as object), redeployRefused: again.code !== 0, p3009: /P3009/.test(again.out) };
    expect(again.code).not.toBe(0);
    expect(cli(ROOT, db, ["migrate", "resolve", "--rolled-back", NAME]).code).toBe(0);
    expect(cli(ROOT, db, ["migrate", "deploy"]).code).toBe(0);
    const f = inspect(db);
    expect(f.newObjects).toHaveLength(8);
    expect(f.data).toBe(before.data);
  });

  it("path guards: a project's default database and any non-temporary path are refused before anything opens them", () => {
    // Never the real database, not even to prove it is refused: a decoy project root.
    const decoyRoot = fs.mkdtempSync(path.join(tmp, "decoy-root-"));
    const decoy = realDatabasePath(decoyRoot);
    fs.mkdirSync(path.dirname(decoy));
    fs.writeFileSync(decoy, "DECOY");
    expect(() => assertDatabaseIsolation({ env: { THREADATLAS_TEST: "1" }, root: decoyRoot, dbPath: decoy })).toThrow(/never use the real database/);
    const r = cli(decoyRoot, decoy, ["migrate", "deploy", "--config", path.join(ROOT, "prisma.config.ts")]); // the config refuses first
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/never use the real database/);
    expect(fs.readFileSync(decoy, "utf8")).toBe("DECOY");
    expect(fs.readdirSync(path.dirname(decoy))).toEqual(["threadatlas.db"]);
    const outside = path.join(ROOT, "test-results", "rehearsal-never-created.db");
    expect(() => assertDatabaseIsolation({ env: { THREADATLAS_TEST: "1" }, root: ROOT, dbPath: outside })).toThrow(/inside the system temp directory/);
    expect(fs.existsSync(outside)).toBe(false);
  });
});
