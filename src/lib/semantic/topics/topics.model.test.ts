/**
 * Topic grouping with the REAL model (Mind Map MVP; opt-in, `npm run test:model`): the
 * synthetic chat corpus (34 everyday conversations) indexed by the production inference
 * child, then grouped. The groups are an exploratory aid; this pins the coarse structure
 * the small model does find (programming and data conversations together; the two
 * language-learning conversations together) and that the result is deterministic.
 * Set THREADATLAS_TOPICS_REPORT=<file> to write the groups as JSON.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { CHAT_CORPUS } from "../../../../tests/helpers/chat-corpus";
import { importText } from "../../../../tests/helpers/import";
import { migrateTestDatabase } from "../../../../tests/helpers/migrate";
import { conversationWithTexts } from "../../../../tests/helpers/semantic-index";
import { exportText } from "../../../../tests/helpers/synthetic-export";
import { testEnv } from "../../../../tests/helpers/test-db";
import { createPrismaClient, type DbClient } from "../../db/client";
import { runIndexer } from "../index/indexer";
import { InferenceProcess, productionChildEntry } from "../inference-process";
import { resolveModelDir } from "../model-files";
import { dropVectorCache } from "../search/vector-cache";
import { buildTopicMap } from "./topics";

const ROOT = process.cwd();
let dir = "";
const clients: DbClient[] = [];
afterAll(async () => {
  for (const c of clients) await c.$disconnect();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

it("groups the chat corpus deterministically, with recognisable coarse topics", async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "threadatlas-topics-model-"));
  const file = path.join(dir, "t.db");
  migrateTestDatabase(file);
  const env = testEnv(file);
  const db = createPrismaClient({ env, root: ROOT });
  const reader = createPrismaClient({ env, root: ROOT });
  clients.push(db, reader);
  const titled = CHAT_CORPUS.map((c) => ({ ...conversationWithTexts(c.id, c.messages), title: c.id.replace(/-/g, " ").replace(/^./, (x) => x.toUpperCase()) }));
  expect((await importText(exportText(titled), { writer: { db, dbPath: file } })).complete).toBe(true);
  const modelDir = resolveModelDir({ env: process.env, root: ROOT });
  expect((await runIndexer({ writer: { db, dbPath: file }, reader, openEmbedder: () => InferenceProcess.start({ entry: productionChildEntry(ROOT), modelDir }) })).status).toBe("finished");
  dropVectorCache();

  const t0 = performance.now();
  const map = await buildTopicMap(db);
  const ms = Math.round(performance.now() - t0);
  const src = new Map((await db.conversation.findMany({ select: { id: true, sourceId: true } })).map((c) => [c.id, c.sourceId]));
  const groups = map.topics.map((t) => ({ label: t.label, members: t.conversations.map((c) => src.get(c.id)!) }));
  const out = process.env.THREADATLAS_TOPICS_REPORT;
  if (out) fs.writeFileSync(out, JSON.stringify({ ms, groups }, null, 1));

  expect(map.topics).toHaveLength(6);
  expect(map.ungrouped).toEqual([]);
  const groupOf = (id: string) => groups.findIndex((g) => g.members.includes(id));
  const together = (...ids: string[]) => expect(new Set(ids.map(groupOf)).size, ids.join(", ")).toBe(1);
  together("python-keyerror", "react-render", "sql-query", "excel-formula");
  together("spanish-translation", "norwegian-phrases");
  dropVectorCache();
  expect(await buildTopicMap(db)).toEqual(map);
}, 300_000);
