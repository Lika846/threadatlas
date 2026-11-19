import { expect, test } from "@playwright/test";
import { attachPrivacyGuards } from "./support/guards";

/**
 * Empty-database states. Runs first (project "empty-db" in playwright.config.ts),
 * before any test imports data into the shared e2e database.
 */
test.describe("empty database", () => {
  test("home: the first-run steps start with getting and importing the export", async ({ page, baseURL }) => {
    const guards = attachPrivacyGuards(page, baseURL);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "ThreadAtlas" })).toBeVisible();
    const steps = page.getByRole("list", { name: "Getting started" });
    const state = (id: string) => steps.locator(`[data-step="${id}"]`).getAttribute("data-state");
    expect([await state("export"), await state("import"), await state("index"), await state("explore")]).toEqual(["current", "current", "waiting", "waiting"]);
    await expect(steps).toContainText("conversations.json");
    await expect(steps.getByRole("link", { name: "OpenAI's export instructions" })).toHaveAttribute("href", /^https:\/\/help\.openai\.com\//);
    await expect(steps.getByRole("link", { name: "Open the map" })).toHaveCount(0);
    for (const viewport of [{ width: 375, height: 812 }, { width: 640, height: 400 }]) {
      await page.setViewportSize(viewport);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await steps.getByRole("link", { name: "Import a file" }).click();
    await expect(page).toHaveURL("/import");
    await guards.assertClean();
  });

  test("the conversation list shows its empty state, linking to import", async ({ page, baseURL }) => {
    const guards = attachPrivacyGuards(page, baseURL);
    await page.goto("/conversations");
    await expect(page.getByRole("heading", { name: "No conversations yet" })).toBeVisible();
    await page.getByRole("link", { name: "import a ChatGPT export" }).click();
    await expect(page).toHaveURL("/import");
    await guards.assertClean();
  });

  test("search shows that there is nothing to search yet, linking to import, with no form", async ({ page, baseURL }) => {
    const guards = attachPrivacyGuards(page, baseURL);
    await page.goto("/search");
    await expect(page.getByRole("heading", { level: 1, name: "Search" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Nothing to search yet" })).toBeVisible();
    await expect(page.getByRole("searchbox")).toHaveCount(0);
    await page.getByRole("link", { name: "import a ChatGPT export" }).click();
    await expect(page).toHaveURL("/import");
    await guards.assertClean();
  });

  test("the import page shows that nothing has been imported", async ({ page, baseURL }) => {
    const guards = attachPrivacyGuards(page, baseURL);
    await page.goto("/import");
    await expect(page.getByTestId("last-import")).toContainText("No imports yet.");
    await guards.assertClean();
  });
});
