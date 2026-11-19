import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { assertDatabaseIsolation, toDatabaseUrl } from "../src/lib/db/path";
import { exportText, syntheticConversation } from "../tests/helpers/synthetic-export";
import { importViaRoute } from "./support/data";
import { attachPrivacyGuards } from "./support/guards";

/**
 * M2.3 privacy check in development mode: `next dev` prints every request,
 * and by default every Server Function call with its arguments. With
 * `logging.serverFunctions: false` (next.config.ts) a search must leave no
 * search term, title or snippet in the server's terminal output.
 *
 * Starts its own `next dev` on port 3101 with its own temporary database
 * (migrated with `npm run db:deploy`, checked by the isolation guard) and
 * captures stdout and stderr. Next.js allows one `next dev` per project
 * directory: stop any ThreadAtlas dev server before running the e2e suite.
 */

const PORT = 3101;
const BASE = `http://127.0.0.1:${PORT}`;
const TERM = "zqdevsecret";
const TITLE_WORD = "Zqdevtitle";
const SNIPPET_WORD = "zqdevsnippetword";

function stop(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.pid === undefined) return resolve();
    child.once("exit", () => resolve());
    try {
      process.kill(-child.pid, "SIGTERM"); // the whole group: next dev starts a child server
    } catch {
      child.kill("SIGTERM");
    }
    setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        /* already gone */
      }
    }, 10_000).unref();
  });
}

async function waitForServer(child: ChildProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      const busy = /already running/.test(output());
      throw new Error(busy ? "Another `next dev` is running in this project; stop it and rerun the e2e suite." : "`next dev` exited before it was ready.");
    }
    try {
      const r = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(30_000) });
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("`next dev` did not become ready in time.");
}

test("next dev prints no search terms, titles or snippets (logging.serverFunctions: false)", async ({ page }) => {
  test.setTimeout(300_000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "threadatlas-devlog-"));
  const db = path.join(dir, "dev.db");
  const env = { ...process.env, THREADATLAS_TEST: "1", DATABASE_URL: toDatabaseUrl(db), NEXT_TELEMETRY_DISABLED: "1" };
  assertDatabaseIsolation({ env, root: process.cwd(), dbPath: db });
  execFileSync("npm", ["run", "db:deploy"], { env, stdio: "ignore" });

  const chunks: string[] = [];
  const child = spawn(process.execPath, [path.join("node_modules", "next", "dist", "bin", "next"), "dev", "--hostname", "127.0.0.1", "--port", String(PORT)], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout!.on("data", (d: Buffer) => chunks.push(d.toString("utf8")));
  child.stderr!.on("data", (d: Buffer) => chunks.push(d.toString("utf8")));
  const output = () => chunks.join("");

  try {
    await waitForServer(child, output);
    const c = syntheticConversation({ id: "devlog", title: `${TITLE_WORD} planning`, messages: 3, tag: `${TERM} ${SNIPPET_WORD}` });
    await importViaRoute(BASE, exportText([c]));

    const guards = attachPrivacyGuards(page, BASE);
    await page.goto(`${BASE}/search`);
    await expect(page.getByRole("button", { name: "Search", exact: true })).toBeEnabled({ timeout: 60_000 });
    const box = page.getByRole("searchbox", { name: "Search conversations" });
    await box.fill(TERM);
    await box.press("Enter");
    await expect(page.locator("#search-results-heading")).toHaveText("1 matching conversation", { timeout: 60_000 });
    await expect(page.locator("main mark").first()).toHaveText(TERM);
    // Open the result and come back: the search runs again (a second action call).
    await page.getByRole("link", { name: `${TITLE_WORD} planning` }).click();
    await expect(page).toHaveURL(/\/conversations\//);
    await page.goBack();
    await expect(page.locator("#search-results-heading")).toHaveText("1 matching conversation", { timeout: 60_000 });
    await guards.assertClean();
    await new Promise((r) => setTimeout(r, 1_500)); // let the request log lines flush

    const log = output();
    // Positive control: the request log is captured, including the action's POST.
    expect(log).toMatch(/POST \/search/);
    expect(log).toMatch(/GET \/search/);
    for (const secret of [TERM, SNIPPET_WORD, TITLE_WORD]) expect(log, `terminal output contains ${secret}`).not.toContain(secret);
    expect(log, "no Server Function call line").not.toContain("searchAction(");
    expect(log).not.toContain("└─ ƒ");
  } finally {
    await stop(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
