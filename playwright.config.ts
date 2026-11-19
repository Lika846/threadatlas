import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { assertDatabaseIsolation, toDatabaseUrl } from "./src/lib/db/path";
import { removeE2eDatabaseDir } from "./e2e/global-teardown";
import { createFakeModelDir, fakeInferenceEnv } from "./e2e/support/semantic";

const PORT = 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * Database isolation (A41). Each run gets its own temporary database, created
 * here and migrated by the web server command. The directory is kept in an
 * environment variable, so workers re-reading this config reuse it, and is
 * removed in global teardown. If isolation cannot be confirmed, the config
 * throws before anything starts (fail closed). The server is never reused, so
 * a dev server on the real database can never be attached to.
 */
process.env.THREADATLAS_E2E_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "threadatlas-e2e-"));
const E2E_DB = path.join(process.env.THREADATLAS_E2E_DIR, "e2e.db");
// Semantic index (M5.1b-2): the fake inference child and a fake model directory (sparse files
// of the approved sizes), so indexing runs without the model. See e2e/support/semantic.ts.
const E2E_MODEL_DIR = path.join(process.env.THREADATLAS_E2E_DIR, "model");
if (process.env.TEST_WORKER_INDEX === undefined && !fs.existsSync(E2E_MODEL_DIR)) createFakeModelDir(E2E_MODEL_DIR);
const E2E_INFERENCE_EVENTS = path.join(process.env.THREADATLAS_E2E_DIR, "inference-events.log");
const SERVER_ENV = {
  THREADATLAS_TEST: "1",
  DATABASE_URL: toDatabaseUrl(E2E_DB),
  ...fakeInferenceEnv(E2E_MODEL_DIR, { slowMarker: "pausetest", slowMs: 250, eventLog: E2E_INFERENCE_EVENTS }),
};
assertDatabaseIsolation({ env: SERVER_ENV, root: process.cwd(), dbPath: E2E_DB });
// Workers re-read this config (TEST_WORKER_INDEX is set there) and must not delete the shared directory.
if (process.env.TEST_WORKER_INDEX === undefined) {
  const dir = process.env.THREADATLAS_E2E_DIR;
  process.on("exit", () => removeE2eDatabaseDir(dir));
}

const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
);

/**
 * E2E tests run against a production build so the production CSP and headers
 * are what get exercised. Only Chromium is installed for now.
 */
export default defineConfig({
  testDir: "./e2e",
  globalTeardown: "./e2e/global-teardown.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  // One server database for the whole run. Tests that depend on its contents run
  // in a fixed order, whatever the file order: the empty state first, then the
  // tests that import, then browsing. Each project waits for the one before it.
  // Every other spec only reads, and runs in parallel as before. Search (M2.3)
  // seeds its own conversations after the readers. Delete-all (M1.7) runs last,
  // after all of them. "dev-logging" starts its own `next dev` server on its
  // own temporary database and shares nothing with the others.
  projects: [
    { name: "empty-db", testMatch: /empty-state\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
    { name: "imports", testMatch: /import\.spec\.ts/, dependencies: ["empty-db"], use: { ...devices["Desktop Chrome"] } },
    { name: "conversations", testMatch: /conversations\.spec\.ts/, dependencies: ["imports"], use: { ...devices["Desktop Chrome"] } },
    {
      name: "chromium",
      testIgnore: [/empty-state\.spec\.ts/, /import\.spec\.ts/, /conversations\.spec\.ts/, /search\.spec\.ts/, /delete-all\.spec\.ts/, /dev-logging\.spec\.ts/, /semantic-.*\.spec\.ts/, /map\.spec\.ts/, /related\.spec\.ts/],
      use: { ...devices["Desktop Chrome"] },
    },
    // Semantic index and search by meaning (M5.1b-2, M5.2) on the shared database: indexes what the
    // earlier projects imported. Runs after the keyword search spec, which expects no index (the
    // search page then defaults to exact words).
    { name: "semantic", testMatch: /semantic-index\.spec\.ts/, dependencies: ["conversations", "chromium", "search"], use: { ...devices["Desktop Chrome"] } },
    // The topic map (Mind Map MVP) on the indexed shared database.
    { name: "map", testMatch: /map\.spec\.ts/, dependencies: ["semantic"], use: { ...devices["Desktop Chrome"] } },
    // Related conversations on the conversation page: imports and indexes its own conversations, after the map.
    { name: "related", testMatch: /related\.spec\.ts/, dependencies: ["map"], use: { ...devices["Desktop Chrome"] } },
    { name: "search", testMatch: /search\.spec\.ts/, dependencies: ["conversations", "chromium"], use: { ...devices["Desktop Chrome"] } },
    // Deletes the shared database's contents, so it runs after everything else.
    { name: "delete-all", testMatch: /delete-all\.spec\.ts/, dependencies: ["conversations", "chromium", "semantic", "search", "map", "related"], use: { ...devices["Desktop Chrome"] } },
    { name: "dev-logging", testMatch: /dev-logging\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
    // Starts, stops, kills and restarts its own production servers on its own temporary database.
    { name: "semantic-lifecycle", testMatch: /semantic-lifecycle\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: `npm run db:deploy && npm run build && npm run start -- --port ${PORT}`,
    env: { ...inheritedEnv, ...SERVER_ENV },
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
