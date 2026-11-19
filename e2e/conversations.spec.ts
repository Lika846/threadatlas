import { expect, test } from "@playwright/test";
import { fixtureText } from "../tests/helpers/fixtures";
import { exportText, syntheticConversation } from "../tests/helpers/synthetic-export";
import { parseExportText } from "../src/lib/import/validate-export";
import { importViaRoute, internalId } from "./support/data";
import { attachPrivacyGuards } from "./support/guards";

/**
 * M1.6 conversation list and detail, on the production build. Runs after the
 * import tests (project "conversations" in playwright.config.ts) and seeds its
 * own synthetic data through the real import route.
 */
test.describe.configure({ mode: "serial" });

const NOW = Math.floor(Date.now() / 1000);
const RUN = `${Date.now()}`;
const PAGING = Array.from({ length: 55 }, (_, i) =>
  syntheticConversation({ id: `paging-${RUN}-${i}`, title: `Paging ${i}`, messages: 1, updateTime: NOW - 1_000 + i }),
);
const LONG_ID = `long-${RUN}`;
const XSS_ID = `xss-${RUN}`;
const XSS_TITLE = `<img src=x onerror=alert('title')> Title`;
const XSS_TEXT = `<script>alert('text')</script> <img src=x onerror=alert('img')> https://example.com/tracker.png`;

function longConversation() {
  // 2,050 messages; every 10th is a system message (hidden by default): 1,845 shown.
  const conv = syntheticConversation({ id: LONG_ID, title: "Long synthetic conversation", messages: 2_050, updateTime: NOW - 5_000 });
  const mapping = conv.mapping as Record<string, { message: { author: { role: string } } }>;
  for (let k = 10; k <= 2_050; k += 10) mapping[`n${k}`]!.message.author.role = "system";
  return conv;
}
function xssConversation() {
  const conv = syntheticConversation({ id: XSS_ID, title: XSS_TITLE, messages: 2, tag: XSS_TEXT, updateTime: NOW - 6_000 });
  const mapping = conv.mapping as Record<string, { message: Record<string, unknown> }>;
  mapping.n1!.message.author = { role: "<b>role</b>", name: "<i>author</i>" };
  mapping.n2!.message.content = { content_type: "code", language: "<svg onload=alert(1)>", text: XSS_TEXT };
  return conv;
}

test.beforeAll(async ({ baseURL }) => {
  for (const f of ["branching.json", "hidden-messages.json", "unsupported-content.json", "malformed-messages.json", "path-fallback.json"]) {
    await importViaRoute(baseURL!, fixtureText(f));
  }
  await importViaRoute(baseURL!, exportText([...PAGING, longConversation(), xssConversation()]));
});

test.describe("conversation list", () => {
  test("newest first, 50 per page, with accessible Newer/Older navigation", async ({ page, baseURL }) => {
    const guards = attachPrivacyGuards(page, baseURL);
    await page.goto("/conversations");
    const links = page.locator("main ol > li a");
    await expect(links).toHaveCount(50);
    await expect(links.first()).toHaveText("Paging 54");
    await expect(links.nth(49)).toHaveText("Paging 5");
    const nav = page.getByRole("navigation", { name: "Conversation pages" });
    await expect(nav).toContainText("Page 1 of");
    await nav.getByRole("link", { name: "Older" }).click();
    await expect(page).toHaveURL(/\/conversations\?page=2$/);
    await expect(page.locator("main ol > li a").first()).toHaveText("Paging 4");
    await page.getByRole("navigation", { name: "Conversation pages" }).getByRole("link", { name: "Newer" }).click();
    await expect(page.locator("main ol > li a").first()).toHaveText("Paging 54");
    // A list entry opens its conversation by internal id.
    await page.locator("main ol > li a").first().click();
    await expect(page).toHaveURL(/\/conversations\/[a-z0-9]+$/);
    await expect(page.getByRole("heading", { level: 1, name: "Paging 54" })).toBeVisible();
    await guards.assertClean();
  });

  test("invalid and out-of-range pages are handled safely", async ({ page }) => {
    await page.goto("/conversations?page=abc");
    await expect(page.locator("main ol > li a").first()).toHaveText("Paging 54");
    await page.goto("/conversations?page=99999");
    const text = await page.getByRole("navigation", { name: "Conversation pages" }).textContent();
    const [, current, total] = /Page (\d+) of (\d+)/.exec(text ?? "") ?? [];
    expect(current).toBe(total);
  });
});

test.describe("conversation detail", () => {
  test("shows the stored visible path in order, with roles, times and branch markers (R55, R56)", async ({ page, baseURL }) => {
    const guards = attachPrivacyGuards(page, baseURL);
    const text = fixtureText("branching.json");
    const parsed = parseExportText(text);
    if (!parsed.ok) throw new Error("parse");
    const c = parsed.conversations[0]!;
    const expected = c.nodes.filter((n) => n.pathIndex !== null && !n.isStructural && !n.isHidden).sort((a, b) => a.pathIndex! - b.pathIndex!);

    await page.goto(`/conversations/${internalId(c.sourceId)}`);
    await expect(page.getByRole("heading", { level: 1, name: c.title! })).toBeVisible();
    const articles = page.locator("main article");
    await expect(articles).toHaveCount(expected.length);
    for (let i = 0; i < expected.length; i++) {
      await expect(articles.nth(i).getByTestId("message-body")).toHaveText(expected[i]!.contentText, { useInnerText: true });
      await expect(articles.nth(i).getByRole("heading", { level: 3 })).toHaveText(expected[i]!.role === "user" ? "User" : "Assistant");
    }
    await expect(page.getByText(/2 versions exist/)).toHaveCount(2);
    await expect(articles.first().locator("time")).toHaveCount(1);
    await expect(page.locator("main")).not.toContainText(c.sourceId); // ChatGPT IDs are not shown
    await expect(page.getByRole("link", { name: "All conversations" })).toBeVisible();
    await guards.assertClean();
  });

  test("explains a fallback path", async ({ page }) => {
    const parsed = parseExportText(fixtureText("path-fallback.json"));
    if (!parsed.ok) throw new Error("parse");
    const fallback = parsed.conversations.find((c) => c.pathStrategy === "latest_leaf")!;
    await page.goto(`/conversations/${internalId(fallback.sourceId)}`);
    await expect(page.getByText(/may not be the branch you last viewed/)).toBeVisible();
  });

  test("hides hidden messages by default, with a toggle that keeps counts", async ({ page, baseURL }) => {
    const guards = attachPrivacyGuards(page, baseURL);
    const parsed = parseExportText(fixtureText("hidden-messages.json"));
    if (!parsed.ok) throw new Error("parse");
    const conv = parsed.conversations.find((c) => c.nodes.some((n) => n.pathIndex !== null && n.isHidden))!;
    const hidden = conv.nodes.filter((n) => n.pathIndex !== null && !n.isStructural && n.isHidden).length;
    const shown = conv.nodes.filter((n) => n.pathIndex !== null && !n.isStructural && !n.isHidden).length;
    await page.goto(`/conversations/${internalId(conv.sourceId)}`);
    await expect(page.locator("main article")).toHaveCount(shown);
    await expect(page.getByText("Hidden by default")).toHaveCount(0);
    await page.getByRole("link", { name: new RegExp(`^Show ${hidden} hidden message`) }).click();
    await expect(page).toHaveURL(/hidden=show/);
    await expect(page.locator("main article")).toHaveCount(shown + hidden);
    await expect(page.getByText("Hidden by default")).toHaveCount(hidden);
    await page.getByRole("link", { name: new RegExp(`^Hide ${hidden} hidden message`) }).click();
    await expect(page.locator("main article")).toHaveCount(shown);
    await guards.assertClean();
  });

  test("marks unsupported and malformed content", async ({ page }) => {
    for (const [fixture, marker] of [["unsupported-content.json", "Contains unsupported content"], ["malformed-messages.json", "Malformed in the export"]] as const) {
      const parsed = parseExportText(fixtureText(fixture));
      if (!parsed.ok) throw new Error("parse");
      const flag = fixture.startsWith("unsupported") ? "hasUnsupportedParts" : "isMalformed";
      const conv = parsed.conversations.find((c) => c.nodes.some((n) => n.pathIndex !== null && !n.isHidden && n[flag]))!;
      await page.goto(`/conversations/${internalId(conv.sourceId)}`);
      await expect(page.getByText(marker).first()).toBeVisible();
    }
  });

  test("paginates long conversations 1,000 messages per page, after filtering hidden ones", async ({ page, baseURL }) => {
    const guards = attachPrivacyGuards(page, baseURL);
    const base = `/conversations/${internalId(LONG_ID)}`;
    await page.goto(base);
    const articles = page.locator("main article");
    await expect(articles).toHaveCount(1_000);
    await expect(page.getByText("Messages 1–1000 of 1845")).toBeVisible();
    await expect(articles.first().getByText("Message 1", { exact: true })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Message pages", exact: true });
    await expect(nav).toContainText("Page 1 of 2");
    await nav.getByRole("link", { name: "Next messages" }).click();
    await expect(page).toHaveURL(`${base}?page=2`);
    await expect(articles).toHaveCount(845);
    await expect(page.getByText("Messages 1001–1845 of 1845")).toBeVisible();
    // Showing hidden messages starts again at page 1, with more pages.
    await page.getByRole("link", { name: /^Show 205 hidden messages/ }).click();
    await expect(page).toHaveURL(`${base}?hidden=show`);
    await expect(page.getByRole("navigation", { name: "Message pages", exact: true })).toContainText("Page 1 of 3");
    await page.goto(`${base}?hidden=show&page=3`);
    await expect(articles).toHaveCount(50);
    await page.goto(`${base}?page=-4`);
    await expect(page.getByText("Messages 1–1000 of 1845")).toBeVisible();
    await page.goto(`${base}?page=12`);
    await expect(page.getByText("Messages 1001–1845 of 1845")).toBeVisible();
    await guards.assertClean();
  });

  test("renders markup from the export as literal text, with no requests or scripts", async ({ page, baseURL }) => {
    const guards = attachPrivacyGuards(page, baseURL);
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    await page.goto("/conversations?page=2");
    await page.goto(`/conversations/${internalId(XSS_ID)}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(XSS_TITLE);
    await expect(page).toHaveTitle(new RegExp(XSS_TITLE.replace(/[()[\]\\^$.|?*+{}]/g, "\\$&")));
    await expect(page.getByText(XSS_TEXT, { exact: false }).first()).toBeVisible();
    await expect(page.getByRole("heading", { level: 3 }).first()).toHaveText("<b>role</b> (<i>author</i>)");
    await expect(page.getByText("Code (<svg onload=alert(1)>)")).toBeVisible();
    await expect(page.locator("main img, main script, main svg, main a[href^='http']")).toHaveCount(0);
    expect(dialogs).toEqual([]);
    await guards.assertClean(); // includes: no request left this machine
  });

  test("unknown and malformed ids give a 404", async ({ page }) => {
    for (const id of ["cunknown0000000000000000", "UPPER", "a".repeat(80)]) {
      const res = await page.goto(`/conversations/${id}`);
      expect(res?.status(), id).toBe(404);
    }
  });
});
