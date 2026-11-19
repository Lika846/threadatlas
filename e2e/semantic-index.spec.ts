import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { exportText, syntheticConversation, syntheticExport } from "../tests/helpers/synthetic-export";
import { E2E_DB, importViaRoute } from "./support/data";
import { attachPrivacyGuards } from "./support/guards";
import { indexIntegrity, inferenceEvents, query, statusRows } from "./support/semantic";

/**
 * Semantic index on the Import page (M5.1b-2; moved from Settings) on the shared production server: Start, progress,
 * Pause and Resume, two Starts at once, the model-missing state, and what the browser
 * receives. Inference runs in the fake child (see playwright.config.ts); it indexes the
 * conversations the earlier projects imported plus its own. Synthetic data only.
 */

const EVENTS = path.join(process.env.THREADATLAS_E2E_DIR!, "inference-events.log");
const MODEL_FILE = path.join(process.env.THREADATLAS_E2E_DIR!, "model", "config.json");

// The indexing waits below allow 120 s; the test timeout must be longer, or under load (a busy
// machine, slower CI) the default 30 s ends the test first.
test.describe.configure({ mode: "serial", timeout: 180_000 });

const status = (p: Page) => p.getByTestId("semantic-status");
const notice = (p: Page) => p.getByTestId("semantic-notice");
const startButton = (p: Page) => p.getByRole("button", { name: /^(Start|Resume) indexing$/ });
const conversationCount = () => query<{ n: number }>(E2E_DB, `SELECT COUNT(*) AS n FROM "Conversation"`)[0]!.n;

function expectIntact() {
  const r = indexIntegrity(E2E_DB);
  expect(r.stale).toBe(0);
  expect(r.chunks).toBe(r.expected);
  expect(r.chunks).toBeGreaterThan(0);
}

test("Start indexes every conversation; counts update; the browser receives only counts and static text", async ({ page, baseURL }) => {
  const guards = attachPrivacyGuards(page, baseURL);
  const actionBodies: string[] = [];
  page.on("response", async (r) => {
    if (r.request().method() === "POST" && new URL(r.url()).pathname === "/import") actionBodies.push(await r.text().catch(() => ""));
  });
  await page.goto("/import");
  await expect(page.getByRole("heading", { name: "Semantic index" })).toBeVisible();
  const total = conversationCount();
  expect(total).toBeGreaterThan(0);
  await expect(status(page)).toContainText("not indexed yet");
  await expect(startButton(page)).toBeEnabled();
  await startButton(page).click();
  await expect(notice(page)).toHaveText("Indexing started.");
  // The run outlives the Server Action and a reload of Settings (owner's condition 4).
  await page.reload();
  await expect(status(page)).toContainText(/^Indexing… \d+ of /);
  await expect(page.getByRole("button", { name: "Pause" })).toBeEnabled();
  await expect(status(page)).toHaveText(`All ${total.toLocaleString("en-US")} conversations are indexed.`, { timeout: 120_000 });
  await expect(page.getByTestId("semantic-indexed")).toHaveText(`${total} of ${total}`);
  await expect(startButton(page)).toBeDisabled();
  expectIntact();
  // Server Action replies: no titles, conversation ids or paths.
  const titles = query<{ title: string; id: string }>(E2E_DB, `SELECT "title", "id" FROM "Conversation"`);
  const bodies = actionBodies.join("\n");
  expect(bodies.length).toBeGreaterThan(0);
  for (const t of titles) {
    expect(bodies).not.toContain(t.title);
    expect(bodies).not.toContain(t.id);
  }
  expect(bodies).not.toContain(process.env.THREADATLAS_E2E_DIR!);
  await guards.assertClean();
});

test("Pause stops after the current batch; Resume finishes with no stale or duplicate vectors", async ({ page, baseURL }) => {
  await importViaRoute(baseURL!, exportText(syntheticExport(6, { messages: 30, textLength: 900, idPrefix: "pause", tag: "pausetest" })));
  await page.goto("/import");
  await expect(status(page)).toContainText("6 conversations not indexed yet");
  await startButton(page).click();
  const pause = page.getByRole("button", { name: "Pause" });
  await expect(pause).toBeEnabled();
  await pause.click();
  await expect(status(page)).toContainText(/^Paused\. \d+ conversations? waiting\.$/, { timeout: 30_000 });
  expect(statusRows(E2E_DB).filter((r) => r.state === "running")).toEqual([]);
  expect(statusRows(E2E_DB).every((r) => r.attempts <= 1)).toBe(true); // the paused claim was refunded
  await expect(startButton(page)).toHaveText("Resume indexing");
  await startButton(page).click();
  const total = conversationCount();
  await expect(status(page)).toHaveText(`All ${total.toLocaleString("en-US")} conversations are indexed.`, { timeout: 120_000 });
  expectIntact();
});

test("two Starts at the same moment start one session and one inference process", async ({ browser, baseURL }) => {
  await importViaRoute(baseURL!, exportText(syntheticExport(3, { messages: 20, textLength: 600, idPrefix: "twice", tag: "twicetest" })));
  const [a, b] = [await browser.newPage(), await browser.newPage()];
  await Promise.all([a.goto(`${baseURL}/import`), b.goto(`${baseURL}/import`)]);
  await expect(startButton(a)).toBeEnabled();
  await expect(startButton(b)).toBeEnabled();
  const inits = inferenceEvents(EVENTS).filter((e) => e === "init").length;
  await Promise.all([startButton(a).click(), startButton(b).click()]);
  await expect.poll(async () => [await notice(a).innerText(), await notice(b).innerText()].sort()).toEqual(["Indexing is already running.", "Indexing started."]);
  const total = conversationCount();
  await expect(status(a)).toHaveText(`All ${total.toLocaleString("en-US")} conversations are indexed.`, { timeout: 120_000 });
  expect(inferenceEvents(EVENTS).filter((e) => e === "init").length).toBe(inits + 1);
  expectIntact();
  await a.close();
  await b.close();
});

const homeStep = (page: Page, id: string) => page.getByRole("list", { name: "Getting started" }).locator(`[data-step="${id}"]`);

test("a missing model file: the panel and the home page say how to install it, and Start is disabled", async ({ page, baseURL }) => {
  await importViaRoute(baseURL!, exportText(syntheticExport(1, { messages: 3, idPrefix: "nomodel" })));
  // Partly indexed: indexing is the next step, and what is indexed can already be explored.
  await page.goto("/");
  await expect(homeStep(page, "index")).toHaveAttribute("data-state", "current");
  await expect(homeStep(page, "index").getByRole("link", { name: "Continue indexing" })).toHaveAttribute("href", "/import#semantic-index-title");
  await expect(homeStep(page, "explore")).toHaveAttribute("data-state", "available");
  const aside = `${MODEL_FILE}.aside`;
  fs.renameSync(MODEL_FILE, aside);
  try {
    await page.goto("/import");
    await expect(status(page)).toContainText("npm run model:fetch");
    await expect(startButton(page)).toBeDisabled();
    await expect(page.getByTestId("model-help")).toContainText("npm run model:fetch");
    await expect(page.getByTestId("model-help").getByRole("button", { name: "Copy command" })).toBeVisible();
    await page.goto("/");
    await expect(homeStep(page, "index")).toHaveAttribute("data-state", "blocked");
    await expect(homeStep(page, "index").getByTestId("model-help")).toContainText("isn't installed yet");
  } finally {
    fs.renameSync(aside, MODEL_FILE);
  }
  await page.goto("/import");
  await expect(status(page)).toContainText("1 conversation not indexed yet");
  await expect(page.getByTestId("model-help")).toHaveCount(0);
  await startButton(page).click();
  await expect(status(page)).toContainText("conversations are indexed.", { timeout: 120_000 });
  expectIntact();
  // Everything indexed: exploring is the next step, and the map is the main action.
  await page.goto("/");
  await expect(homeStep(page, "index")).toHaveAttribute("data-state", "done");
  await expect(homeStep(page, "explore")).toHaveAttribute("data-state", "current");
  await homeStep(page, "explore").getByRole("link", { name: "Open the map" }).click();
  await expect(page).toHaveURL("/map");
});

// ---- Search by meaning (M5.2) ----------------------------------------------------------

type Node = { message: { content: { parts: string[] } } | null };
/** A conversation whose message 2 has exactly `text` (one chunk, so a query equal to it matches it). */
function conversationWith(id: string, title: string, text: string) {
  const c = syntheticConversation({ id, title, messages: 3 });
  (c.mapping as Record<string, Node>)["n2"]!.message!.content.parts = [text];
  return c;
}
const MEANING_TEXT = "Zqlantern keepers write every storm into a weathered logbook.";

async function indexAll(page: Page) {
  await page.goto("/import");
  const start = startButton(page);
  if (await start.isEnabled()) await start.click();
  await expect(status(page)).toHaveText(`All ${conversationCount().toLocaleString("en-US")} conversations are indexed.`, { timeout: 120_000 });
}
async function searchFor(page: Page, q: string) {
  await page.getByRole("searchbox", { name: "Search conversations" }).fill(q);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
}

test("search by meaning: the matching conversation first, why it matched, the passage, a link to the message", async ({ page, baseURL }) => {
  const guards = attachPrivacyGuards(page, baseURL);
  await importViaRoute(baseURL!, exportText([conversationWith("meaning-target", "Zqlantern log", MEANING_TEXT)]));
  await indexAll(page);
  await page.goto("/search");
  await expect(page.getByRole("radio", { name: "By meaning" })).toBeChecked();
  await searchFor(page, MEANING_TEXT);
  const first = page.locator("ol > li").first();
  await expect(first.getByRole("link")).toHaveText("Zqlantern log");
  await expect(first.getByTestId("matched-by")).toHaveText("Similar meaning · matches your words");
  await expect(first).toContainText("weathered logbook");
  await first.getByRole("link").click();
  await expect(page).toHaveURL(/\/conversations\/[^/?#]+#m-2$/);
  await guards.assertClean();
});

test("search by meaning: close matches first; Other results expands on the same page without searching again", async ({ page }) => {
  await page.goto("/search");
  await searchFor(page, "qzv nothing anywhere has all these words");
  const close = await page.locator("ol").first().locator("> li").count();
  expect(close).toBeGreaterThanOrEqual(1);
  expect(close).toBeLessThan(50);
  await expect(page.getByRole("heading", { level: 2 })).toHaveText(`${close} matching conversation${close === 1 ? "" : "s"}`);
  const toggle = page.getByRole("button", { name: `Other results (${50 - close})` });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("list", { name: "Other results" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Search result pages" })).toHaveCount(0); // no paging by meaning
  let requests = 0;
  page.on("request", (r) => {
    if (r.method() === "POST") requests++;
  });
  await toggle.click();
  const others = page.getByRole("list", { name: "Other results" });
  await expect(others.locator("> li")).toHaveCount(50 - close);
  await expect(page.getByRole("button", { name: "Hide other results" })).toHaveAttribute("aria-expanded", "true");
  expect(requests).toBe(0); // expanded from the same response
  const labels = await page.getByTestId("matched-by").allInnerTexts();
  expect(labels).toHaveLength(50);
  expect(new Set(labels)).toEqual(new Set(["Similar meaning"]));
});

test("search by meaning says when conversations aren't indexed yet", async ({ page, baseURL }) => {
  await importViaRoute(baseURL!, exportText([conversationWith("meaning-late", "Zqlate arrival", "A conversation imported after indexing.")]));
  await page.goto("/search");
  await searchFor(page, MEANING_TEXT);
  await expect(page.getByTestId("search-notice")).toContainText("1 conversation isn't indexed yet; it appears only when the exact words match.");
  await expect(page.getByTestId("search-notice").getByRole("link", { name: "Index them on the Import page." })).toHaveAttribute("href", "/import");
});

test("without the model: the page starts in exact words, and search by meaning falls back and says why", async ({ page }) => {
  const aside = `${MODEL_FILE}.aside`;
  fs.renameSync(MODEL_FILE, aside);
  try {
    await page.goto("/search");
    await expect(page.getByRole("radio", { name: "Exact words" })).toBeChecked();
    await page.getByRole("radio", { name: "By meaning" }).check();
    await searchFor(page, "Zqlantern");
    await expect(page.getByTestId("search-notice")).toContainText("Search by meaning needs the semantic model");
    await expect(page.locator("ol > li").first().getByRole("link")).toHaveText("Zqlantern log");
    await expect(page.getByTestId("matched-by")).toHaveCount(0);
  } finally {
    fs.renameSync(aside, MODEL_FILE);
  }
});
