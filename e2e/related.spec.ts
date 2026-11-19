import { expect, test, type Page } from "@playwright/test";
import { exportText, syntheticConversation } from "../tests/helpers/synthetic-export";
import { E2E_DB, importViaRoute, internalId } from "./support/data";
import { attachPrivacyGuards } from "./support/guards";
import { query } from "./support/semantic";

/**
 * Related conversations on the conversation page (knowledge-graph MVP, step 1), on the shared
 * production server after the map project. The fake inference child gives one pseudo-random
 * vector per chunk text, so conversations sharing messages are close in meaning and a
 * conversation with only its own text is close to none. Synthetic data only.
 */

// The indexing wait allows 120 s; the test timeout must be longer (see semantic-index.spec.ts).
test.describe.configure({ mode: "serial", timeout: 180_000 });

type Node = { message: { content: { parts: string[] } } | null };
const LONG = "with enough words in it to count as a full passage for the semantic index";
function conversation(id: string, title: string, texts: string[]) {
  const c = syntheticConversation({ id, title, messages: texts.length });
  texts.forEach((t, i) => ((c.mapping as Record<string, Node>)[`n${i + 1}`]!.message!.content.parts = [t]));
  return c;
}
const family = (i: number) =>
  conversation(`related-zq-${i}`, `Zqfern care ${i}`, [`How often should I water a zqfern ${LONG}?`, `Water a zqfern when the top soil is dry ${LONG}.`, `My own zqfern question number ${i} ${LONG}.`]);
const page = (sourceId: string) => `/conversations/${internalId(sourceId)}`;
const section = (p: Page) => p.getByTestId("related-conversations");
const count = () => query<{ n: number }>(E2E_DB, `SELECT COUNT(*) AS n FROM "Conversation"`)[0]!.n;

async function indexAll(p: Page) {
  await p.goto("/import");
  const start = p.getByRole("button", { name: /^(Start|Resume) indexing$/ });
  if (await start.isEnabled()) await start.click();
  await expect(p.getByTestId("semantic-status")).toHaveText(`All ${count().toLocaleString("en-US")} conversations are indexed.`, { timeout: 120_000 });
}

test("a conversation that isn't indexed says so and links to the Import page", async ({ page: p, baseURL }) => {
  const guards = attachPrivacyGuards(p, baseURL);
  await importViaRoute(baseURL!, exportText([family(0), family(1), family(2), conversation("related-zq-alone", "Zqlonely question", [`Nobody else asks about zqcomets ${LONG}.`, `Zqcomets are rare ${LONG}.`])]));
  await p.goto(page("related-zq-0"));
  await expect(section(p).getByRole("heading", { level: 2, name: "Related conversations" })).toBeVisible();
  await expect(section(p)).toContainText("isn't in the semantic index");
  await expect(section(p).getByRole("link", { name: "Index it on the Import page" })).toHaveAttribute("href", "/import");
  await guards.assertClean();
});

test("after indexing: related conversations with links, 'Why related' passages that open their message, and No close conversations", async ({ page: p, baseURL }) => {
  const guards = attachPrivacyGuards(p, baseURL);
  await indexAll(p);
  await p.goto(page("related-zq-0"));
  const links = section(p).locator("ol > li > a");
  await expect(links.first()).toBeVisible();
  const titles = await links.allTextContents();
  expect(titles.slice(0, 2).sort()).toEqual(["Zqfern care 1", "Zqfern care 2"]);
  expect(titles.length).toBeLessThanOrEqual(5);
  expect(titles).not.toContain("Zqfern care 0");

  // Keyboard: open "Why related" on the first link and follow the passage from the related conversation.
  const first = section(p).locator("ol > li").first();
  const summary = first.locator("summary", { hasText: "Why related" });
  await summary.focus();
  await p.keyboard.press("Enter");
  await expect(first.locator("details")).toHaveAttribute("open", "");
  await expect(first.locator("blockquote")).toHaveCount(2);
  await expect(first.locator("blockquote").first()).toContainText("zqfern");
  const passageLink = first.getByRole("link", { name: /^message \d+$/ }).nth(1);
  const href = (await passageLink.getAttribute("href"))!;
  expect(href).toMatch(/^\/conversations\/[^/#?]+#m-\d+$/);
  await passageLink.focus();
  await p.keyboard.press("Enter");
  await expect(p).toHaveURL(new RegExp(`${href}$`));
  await expect(p.locator("article[data-linked]")).toHaveCount(1);

  await p.goto(page("related-zq-alone"));
  await expect(section(p)).toContainText("No close conversations.");
  await guards.assertClean();
});

test("works without JavaScript", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
  const p = await context.newPage();
  await p.goto(page("related-zq-1"));
  await expect(section(p).locator("ol > li > a").first()).toBeVisible();
  const details = section(p).locator("details").first();
  await details.locator("summary").click(); // native disclosure, no script
  await expect(details.locator("blockquote").first()).toBeVisible();
  await context.close();
});

// ---------------------------------------------------------------- reading layout (phase 3)

const HOSTILE_MD = [
  "Here is **bold**, *italic*, `inline code` and a [safe link](https://example.org/docs).",
  "",
  '<img src="x" onerror="window.__xss = 1"> <script>window.__xss = 2</script> [bad](javascript:window.__xss=3) ![pixel](https://tracker.example/p.gif)',
  "",
  "| Column | Another column with a very long header to force sideways scrolling inside the table | Third |",
  "|---|---|---|",
  "| a | b | c |",
  "",
  "```python",
  `print("a very long line of code that must scroll inside its block instead of widening the whole page ${"x".repeat(120)}")`,
  "```",
].join("\n");

test("reading: assistant Markdown is rendered safely in the browser; your own text is shown as typed", async ({ page: p, baseURL }) => {
  const guards = attachPrivacyGuards(p, baseURL);
  await importViaRoute(baseURL!, exportText([conversation("reading-md", "Zqmarkdown reading", ["Please answer with **markdown** <b>as is</b>", HOSTILE_MD])]));
  await p.goto(page("reading-md"));
  const [user, assistant] = [p.locator('article[data-role="user"]'), p.locator('article[data-role="assistant"]')];
  await expect(user.getByTestId("message-body")).toHaveText("Please answer with **markdown** <b>as is</b>");
  await expect(assistant.locator("strong")).toHaveText("bold");
  await expect(assistant.locator("table th").first()).toHaveText("Column");
  await expect(assistant.locator("pre code")).toContainText("print(");
  const safe = assistant.getByRole("link", { name: "safe link" });
  await expect(safe).toHaveAttribute("href", "https://example.org/docs");
  await expect(safe).toHaveAttribute("target", "_blank");
  await expect(safe).toHaveAttribute("rel", "noopener noreferrer nofollow");
  await expect(assistant.getByRole("link", { name: "bad" })).toHaveCount(0);
  await expect(assistant).toContainText("[Image: pixel]");
  await expect(assistant).toContainText('<img src="x" onerror="window.__xss = 1">');
  await expect(p.locator("main img, main script, main iframe")).toHaveCount(0);
  expect(await p.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  await guards.assertClean(); // includes: no request left the machine (the pixel was never loaded)
});

test("reading: related conversations beside the conversation on wide screens, after it on phones; nothing overflows at 200%", async ({ browser, baseURL }) => {
  for (const [viewport, scale] of [[{ width: 1440, height: 900 }, 1], [{ width: 375, height: 812 }, 2], [{ width: 640, height: 400 }, 2]] as const) {
    const context = await browser.newContext({ baseURL, viewport, deviceScaleFactor: scale });
    const p = await context.newPage();
    await p.goto(page("related-zq-0"));
    const aside = p.getByRole("complementary", { name: "Related conversations" });
    const firstMessage = p.locator("main article").first();
    await expect(aside.locator("ol > li > a").first()).toBeVisible();
    const [a, m] = [(await aside.boundingBox())!, (await firstMessage.boundingBox())!];
    if (viewport.width >= 1024) {
      expect(a.x).toBeGreaterThan(m.x + m.width - 1); // a column to the right
      expect(a.y).toBeLessThan(m.y + m.height); // alongside, not below
    } else {
      expect(a.y).toBeGreaterThan(m.y); // after the conversation
      const jump = p.getByRole("link", { name: /^\d+ related conversations?$/ });
      await expect(jump).toBeVisible();
      await expect(jump).toHaveAttribute("href", "#related-title");
    }
    // The conversation comes before related conversations in the page order (screen readers, Tab).
    expect(await p.evaluate(() => {
      const main = document.querySelector("main article");
      const aside = document.querySelector("aside");
      return !!main && !!aside && !!(main.compareDocumentPosition(aside) & Node.DOCUMENT_POSITION_FOLLOWING);
    })).toBe(true);
    await p.goto(page("reading-md"));
    expect(await p.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0); // wide tables and code scroll inside
    await context.close();
  }
});
