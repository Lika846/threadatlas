import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { E5_SMALL_MANIFEST } from "../../src/lib/semantic/model-manifest";

/**
 * Semantic-index e2e support (M5.1b-2). Servers under test run the fake inference child
 * (`tests/helpers/fake-inference-child.mts`, honoured only under THREADATLAS_TEST=1 with a
 * temporary database) and see a fake model directory: sparse files with the approved
 * sizes, so the size check passes without the 135 MB model. The fake child never reads them.
 * The opt-in real-model run (THREADATLAS_E2E_REAL_MODEL=1) uses the installed model instead.
 */

export const REAL_MODEL = process.env.THREADATLAS_E2E_REAL_MODEL === "1";

/** Sparse files of exactly the manifest's sizes (no content, no disk blocks). */
export function createFakeModelDir(dir: string): void {
  for (const f of E5_SMALL_MANIFEST.files) {
    const file = path.join(dir, f.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, "w", 0o600);
    try {
      fs.ftruncateSync(fd, f.size);
    } finally {
      fs.closeSync(fd);
    }
  }
}

/** Server environment for the fake inference child and the fake model directory. */
export function fakeInferenceEnv(modelDir: string, options: Record<string, unknown>): Record<string, string> {
  return {
    THREADATLAS_MODEL_DIR: modelDir,
    THREADATLAS_INFERENCE_ENTRY: "tests/helpers/fake-inference-child.mts",
    THREADATLAS_INFERENCE_TEST_OPTIONS: JSON.stringify({ pipeline: "index", ...options }),
  };
}

/** The fake child's event names (static strings only). */
export function inferenceEvents(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { name: string }).name);
}

/** Runs a read-only query on a temporary test database. */
export function query<T>(dbFile: string, sql: string, ...params: unknown[]): T[] {
  const d = new Database(dbFile, { readonly: true, fileMustExist: true, timeout: 5_000 });
  try {
    return d.prepare(sql).all(...params) as T[];
  } finally {
    d.close();
  }
}

export type StatusRow = { conversationId: string; state: string; attempts: number; claimToken: string | null; lastErrorCode: string | null; chunkCount: number | null };

export function statusRows(dbFile: string): StatusRow[] {
  return query<StatusRow>(dbFile, `SELECT "conversationId", "state", "attempts", "claimToken", "lastErrorCode", "chunkCount" FROM "EmbeddingStatus" ORDER BY "conversationId"`);
}

/** Checks that every stored chunk belongs to the current version of its conversation and epoch, with no duplicates. */
export function indexIntegrity(dbFile: string): { chunks: number; expected: number; stale: number } {
  const [r] = query<{ chunks: number; expected: number; stale: number }>(
    dbFile,
    `SELECT
       (SELECT COUNT(*) FROM "EmbeddingChunk") AS chunks,
       (SELECT COALESCE(SUM("chunkCount"), 0) FROM "EmbeddingStatus" WHERE "state" = 'indexed') AS expected,
       (SELECT COUNT(*) FROM "EmbeddingChunk" ch JOIN "Conversation" c ON c."id" = ch."conversationId"
          WHERE ch."contentHash" <> c."contentHash" OR ch."parserVersion" <> c."parserVersion"
             OR ch."epoch" <> (SELECT "epoch" FROM "EmbeddingIndex" WHERE "id" = 'main')) AS stale`,
  );
  return r!;
}
