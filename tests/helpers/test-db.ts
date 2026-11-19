import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inject } from "vitest";
import { createPrismaClient, type DbClient, type WriterDb } from "../../src/lib/db/client";
import { toDatabaseUrl } from "../../src/lib/db/path";
import { indexLockPathFor, lockPathFor } from "../../src/lib/db/write-lock";

export type TestDb = {
  db: DbClient;
  file: string;
  /** The test client as an import writer (its own connection). */
  writer: WriterDb;
  /** A second client on the same file: a separate connection, like a page render. */
  reader: () => DbClient;
  cleanup: () => Promise<void>;
};

export const testEnv = (file: string) => ({ THREADATLAS_TEST: "1", DATABASE_URL: toDatabaseUrl(file) });

/**
 * A fresh copy of the migrated template, opened through the real client
 * factory, so the isolation guard runs exactly as in the app.
 */
export function createTestDb(): TestDb {
  const template = inject("templateDb");
  const file = path.join(path.dirname(template), `${randomUUID()}.db`);
  fs.copyFileSync(template, file);
  const open = () => createPrismaClient({ env: testEnv(file), root: process.cwd() });
  const db = open();
  const readers: DbClient[] = [];
  return {
    db,
    file,
    writer: { db, dbPath: file },
    reader() {
      const r = open();
      readers.push(r);
      return r;
    },
    async cleanup() {
      for (const r of readers) await r.$disconnect();
      await db.$disconnect();
      const locks = [lockPathFor(file), indexLockPathFor(file)].flatMap((l) => [l, `${l}-journal`]);
      for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`, ...locks]) fs.rmSync(f, { force: true });
    },
  };
}

/**
 * True when the checkout itself lies inside the system temp directory (a clone into /tmp). A few
 * tests use a path inside the checkout as their example of a path *outside* the temp directory;
 * they skip that premise there. The real-database checks run either way.
 */
export function checkoutInTempDir(root: string = process.cwd()): boolean {
  const rel = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(root));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
