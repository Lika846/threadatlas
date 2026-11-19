import { execFileSync } from "node:child_process";
import path from "node:path";
import { toDatabaseUrl } from "../../src/lib/db/path";

/**
 * Applies the committed migrations to a test database with
 * `prisma migrate deploy`. Shared by the Vitest integration setup and
 * Playwright. Runs with the test flag, so prisma.config.ts refuses anything
 * that is not an isolated temporary file; telemetry is off and stdin is not a
 * terminal (no survey prompts). Output is captured, never printed, on success.
 */
export function migrateTestDatabase(dbPath: string, root: string = process.cwd()): void {
  const cli = path.join(root, "node_modules", "prisma", "build", "index.js");
  execFileSync(process.execPath, [cli, "migrate", "deploy"], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: toDatabaseUrl(dbPath),
      THREADATLAS_TEST: "1",
      CHECKPOINT_DISABLE: "1",
      PRISMA_HIDE_UPDATE_MESSAGE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
