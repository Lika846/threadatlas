import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { assertDatabaseIsolation, toDatabaseUrl } from "../src/lib/db/path";
import { exportText, syntheticExport } from "../tests/helpers/synthetic-export";
import { importViaRoute } from "./support/data";
import { REAL_MODEL, createFakeModelDir, fakeInferenceEnv, indexIntegrity, inferenceEvents, query, statusRows } from "./support/semantic";

/**
 * The semantic index across server lifecycles (M5.1b-2), on production servers started by
 * this spec (port 3102, its own temporary database):
 * - a normal shutdown (SIGTERM, Next.js's default handling) during indexing refunds the
 *   attempt of the conversation being indexed, and its inference child exits;
 * - SIGKILL during indexing: shown as interrupted after a restart; Resume recovers, the
 *   attempt kept;
 * - an inference crash leaves Next.js running; the conversation becomes failed after three
 *   Starts; Retry failed;
 * - the servers' output contains no conversation text, titles, ids or paths.
 * Fake inference child by default; THREADATLAS_E2E_REAL_MODEL=1 uses the installed model
 * (the crash test then is skipped).
 */

const ROOT = process.cwd();
const PORT = 3102;
const BASE = `http://127.0.0.1:${PORT}`;
const NEXT_BIN = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
const CANARY = "lifecyclecanary";
const CRASH = "LIFECYCLECRASH";
const QUERY_CANARY = "zqqueryprivacy";

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

let dir: string;
let db: string;
let events: string;
let server: Server | null = null;
const output: string[] = [];

type Server = { proc: ChildProcess; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> };

function serverEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NEXT_TELEMETRY_DISABLED: "1", THREADATLAS_TEST: "1", DATABASE_URL: toDatabaseUrl(db) };
  for (const k of ["THREADATLAS_INFERENCE_ENTRY", "THREADATLAS_INFERENCE_TEST_OPTIONS", "THREADATLAS_MODEL_DIR"]) delete env[k];
  if (!REAL_MODEL) Object.assign(env, fakeInferenceEnv(path.join(dir, "model"), { batchDelayMs: 300, eventLog: events, crashMarker: CRASH }));
  return env;
}

async function startServer(): Promise<Server> {
  const proc = spawn(process.execPath, [NEXT_BIN, "start", "--hostname", "127.0.0.1", "--port", String(PORT)], {
    cwd: ROOT,
    env: serverEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  proc.stdout!.on("data", (d) => output.push(String(d)));
  proc.stderr!.on("data", (d) => output.push(String(d)));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => proc.once("exit", (code, signal) => r({ code, signal })));
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error("the server exited before it was ready");
    try {
      if ((await fetch(`${BASE}/`, { signal: AbortSignal.timeout(5_000) })).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("the server did not start");
    await new Promise((r) => setTimeout(r, 250));
  }
  server = { proc, exited };
  return server;
}

/** Sends a signal to the server process only (as a service manager would), then waits for it. */
async function stopServer(s: Server, signal: NodeJS.Signals): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  s.proc.kill(signal);
  const e = await Promise.race([s.exited, new Promise<null>((r) => setTimeout(() => r(null), 20_000))]);
  if (!e) {
    process.kill(-s.proc.pid!, "SIGKILL");
    throw new Error("the server did not exit");
  }
  server = null;
  return e;
}

/** No inference process is left (fake: by the pids it logged; real: by its entry file). */
async function expectNoInferenceProcess() {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const remaining = () => {
    if (REAL_MODEL) {
      const ps = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
      return ps.split("\n").filter((l) => l.includes("src/lib/semantic/inference-child.ts")).length;
    }
    return inferenceEvents(events).filter((e) => e.startsWith("pid:")).map((e) => Number(e.slice(4))).filter(alive).length;
  };
  await expect.poll(remaining, { timeout: 10_000 }).toBe(0);
}

async function waitForRunningRow(): Promise<string> {
  let id = "";
  await expect
    .poll(() => (id = statusRows(db).find((r) => r.state === "running")?.conversationId ?? ""), { timeout: 60_000, intervals: [50] })
    .not.toBe("");
  return id;
}

const status = (p: Page) => p.getByTestId("semantic-status");
const startButton = (p: Page) => p.getByRole("button", { name: /^(Start|Resume) indexing$/ });
const total = () => query<{ n: number }>(db, `SELECT COUNT(*) AS n FROM "Conversation"`)[0]!.n;
const allIndexed = (p: Page) => expect(status(p)).toHaveText(`All ${total()} conversations are indexed.`, { timeout: 120_000 });

function expectIntact() {
  const r = indexIntegrity(db);
  expect(r.stale).toBe(0);
  expect(r.chunks).toBe(r.expected);
}

test.beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "threadatlas-lifecycle-"));
  db = path.join(dir, "lifecycle.db");
  events = path.join(dir, "inference-events.log");
  assertDatabaseIsolation({ env: { THREADATLAS_TEST: "1" }, root: ROOT, dbPath: db });
  execFileSync("npm", ["run", "db:deploy"], { cwd: ROOT, env: { ...process.env, THREADATLAS_TEST: "1", DATABASE_URL: toDatabaseUrl(db) }, stdio: "ignore" });
  if (!REAL_MODEL) createFakeModelDir(path.join(dir, "model"));
});

test.afterAll(() => {
  if (server?.proc.pid) {
    try {
      process.kill(-server.proc.pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  const tmp = fs.realpathSync(os.tmpdir());
  if (dir && path.dirname(fs.realpathSync(dir)) === tmp && path.basename(dir).startsWith("threadatlas-lifecycle-")) fs.rmSync(dir, { recursive: true, force: true });
});

test("a normal shutdown during indexing refunds the attempt; the child exits; Resume finishes with an intact index", async ({ page }) => {
  let s = await startServer();
  await importViaRoute(BASE, exportText(syntheticExport(4, { messages: 12, textLength: 900, idPrefix: "lc", tag: CANARY })));
  await page.goto(`${BASE}/import`);
  await expect(status(page)).toContainText("4 conversations not indexed yet");
  await startButton(page).click();
  const claimed = await waitForRunningRow();
  await page.waitForTimeout(100); // inside the conversation's inference
  const e = await stopServer(s, "SIGTERM");
  expect(e.signal === "SIGTERM" || e.code !== null).toBe(true);
  const rows = statusRows(db);
  expect(rows.filter((r) => r.state === "running")).toEqual([]);
  expect(rows.find((r) => r.conversationId === claimed)).toMatchObject({ state: "pending", attempts: 0, claimToken: null });
  await expectNoInferenceProcess();
  if (!REAL_MODEL) expect(inferenceEvents(events)).toContain("exit:0");

  s = await startServer();
  await page.goto(`${BASE}/import`);
  await expect(status(page)).toContainText("not indexed yet"); // not "interrupted": nothing was left running
  await startButton(page).click();
  await allIndexed(page);
  expect(statusRows(db).find((r) => r.conversationId === claimed)).toMatchObject({ state: "indexed", attempts: 1 });
  expectIntact();
  await stopServer(s, "SIGTERM");
});

test("SIGKILL during indexing: interrupted after a restart; Resume recovers with the attempt kept", async ({ page }) => {
  let s = await startServer();
  await importViaRoute(BASE, exportText(syntheticExport(3, { messages: 12, textLength: 900, idPrefix: "lk", tag: CANARY })));
  await page.goto(`${BASE}/import`);
  await startButton(page).click();
  const claimed = await waitForRunningRow();
  await stopServer(s, "SIGKILL");
  expect(statusRows(db).find((r) => r.conversationId === claimed)).toMatchObject({ state: "running", attempts: 1 });
  await expectNoInferenceProcess(); // the child drained when its parent vanished

  s = await startServer();
  await page.goto(`${BASE}/import`);
  await expect(status(page)).toContainText("Indexing was interrupted");
  await startButton(page).click();
  await allIndexed(page);
  expect(statusRows(db).find((r) => r.conversationId === claimed)).toMatchObject({ state: "indexed", attempts: 2 });
  expectIntact();
  await stopServer(s, "SIGTERM");
});

test("an inference crash leaves Next.js running; failed after three Starts; Retry failed", async ({ page }) => {
  test.skip(REAL_MODEL, "the crash marker exists only in the fake inference child");
  const s = await startServer();
  await importViaRoute(BASE, exportText(syntheticExport(1, { messages: 2, idPrefix: "crash", tag: CRASH, title: "Lifecycle crash conversation" })));
  await page.goto(`${BASE}/import`);
  const poison = () => statusRows(db).find((r) => r.state !== "indexed");
  for (let k = 1; k <= 3; k++) {
    await expect(startButton(page)).toBeEnabled({ timeout: 30_000 });
    await startButton(page).click();
    await expect.poll(() => (poison()?.attempts === k && poison()?.state !== "running" ? "recorded" : ""), { timeout: 30_000 }).toBe("recorded");
    await expect(status(page)).toHaveText("Indexing stopped. The embedding worker stopped unexpectedly.", { timeout: 30_000 });
    expect(s.proc.exitCode).toBeNull(); // the server survived the crash
    expect((await fetch(`${BASE}/`)).status).toBe(200);
  }
  const poisoned = statusRows(db).find((r) => r.lastErrorCode === "WORKER_FAILED")!;
  expect(poisoned).toMatchObject({ state: "failed", attempts: 3 });
  // Keyword search still finds it.
  await page.goto(`${BASE}/conversations`);
  await expect(page.getByText("Lifecycle crash conversation")).toBeVisible();
  await page.goto(`${BASE}/import`);
  await startButton(page).click(); // nothing left to do: the result is recorded, the error cleared
  await expect(status(page)).toContainText("1 failed; keyword search still finds them.", { timeout: 30_000 });
  await page.getByRole("button", { name: "Retry failed" }).click();
  await expect(page.getByTestId("semantic-notice")).toHaveText("1 failed conversation will be indexed again at the next Start.");
  await expect(status(page)).toHaveText("1 conversation not indexed yet.");
  expect(statusRows(db).find((r) => r.conversationId === poisoned.conversationId)).toMatchObject({ state: "pending", attempts: 0 });
  expectIntact();
  await stopServer(s, "SIGTERM");
  await expectNoInferenceProcess();
});

test("search by meaning on a production server: results, and the query never reaches the output", async ({ page }) => {
  const s = await startServer();
  await page.goto(`${BASE}/search`);
  await expect(page.getByRole("radio", { name: "By meaning" })).toBeChecked();
  await page.getByRole("searchbox", { name: "Search conversations" }).fill(`${QUERY_CANARY} synthetic message`);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2 })).toContainText("matching conversation");
  await stopServer(s, "SIGTERM");
  await expectNoInferenceProcess();
});

test("the servers' output contains no conversation text, titles, ids or paths", () => {
  const text = output.join("");
  expect(text.length).toBeGreaterThan(0);
  expect(text).not.toContain(CANARY);
  expect(text).not.toContain(CRASH);
  expect(text).not.toContain(QUERY_CANARY);
  expect(text).not.toContain("Synthetic l");
  expect(text).not.toContain("Lifecycle crash conversation");
  expect(text).not.toContain(dir);
  for (const { id } of query<{ id: string }>(db, `SELECT "id" FROM "Conversation"`)) expect(text).not.toContain(id);
});
