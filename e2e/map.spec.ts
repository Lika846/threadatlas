import { expect, test, type Page } from "@playwright/test";
import { attachPrivacyGuards } from "./support/guards";

/**
 * The map (phase 2): the outline of themes and topics, the map and the selected conversations,
 * on the shared production server after the semantic project has indexed it (fake,
 * deterministic vectors) and imported one conversation late, which is therefore not grouped yet.
 * Synthetic data only.
 */

test.describe.configure({ mode: "serial" });

const MAX_THEMES = 15; // THEME_CUT.maxThemes
const FIT_MIN_ZOOM = 0.8;

const outlineThemes = (page: Page) => page.getByTestId("atlas-outline").locator(":scope > ol > li > a");
const mapThemes = (page: Page) => page.getByTestId("topic-map").locator(".react-flow__node-theme a");
const zoom = async (page: Page) => Number(((await page.locator(".react-flow__viewport").getAttribute("style")) ?? "").match(/scale\(([\d.]+)\)/)?.[1]);

test("outline, map and panel show the same themes; selecting one is in the URL; nothing leaves the machine", async ({ page, baseURL }) => {
  const guards = attachPrivacyGuards(page, baseURL);
  await page.goto("/map");
  await expect(page.getByRole("heading", { level: 1, name: "Map" })).toBeVisible();
  await expect(page.getByText(/indexed\s+yet, so (it isn't|they aren't) on the map/)).toBeVisible(); // the late import
  await expect(mapThemes(page).first()).toBeVisible();
  const n = await outlineThemes(page).count();
  expect(n).toBeGreaterThan(1);
  expect(n).toBeLessThanOrEqual(MAX_THEMES);
  const names = (await outlineThemes(page).locator("span:first-child").allTextContents()).sort();
  const onMap = (await mapThemes(page).locator("span:first-child").allTextContents()).sort();
  expect(onMap).toEqual(names); // one source of data
  await expect(page.locator("#atlas-panel-title")).toHaveText("All themes");

  const first = outlineThemes(page).first();
  const name = (await first.locator("span:first-child").textContent())!;
  await first.click();
  await expect(page).toHaveURL(/\/map\?theme=th-[0-9a-z-]+$/);
  await expect(page.locator("#atlas-panel-title")).toHaveText(name);
  await expect(first).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("topic-map").locator(`.react-flow__node-theme a[aria-current="true"]`)).toContainText(name);
  expect(await page.getByTestId("topic-map").locator(".react-flow__node-topic").count()).toBeLessThanOrEqual(12);
  await expect(page.getByTestId("atlas-panel").getByRole("status")).toContainText(/conversations?/);
  await guards.assertClean();
});

test("Back and reload restore the selected theme and topic", async ({ page }) => {
  await page.goto("/map");
  await outlineThemes(page).first().click();
  await expect(page).toHaveURL(/theme=/);
  const topic = page.getByTestId("topic-map").locator(".react-flow__node-topic a").first();
  test.skip((await topic.count()) === 0, "the first theme has no topics in this data");
  await topic.click();
  await expect(page).toHaveURL(/theme=th-[^&]+&topic=th-[^&]+\.tp-/);
  const url = page.url();
  const title = await page.locator("#atlas-panel-title").textContent();
  await page.getByTestId("atlas-panel").locator("ol[aria-label=Conversations] a").first().click();
  await expect(page).toHaveURL(/\/conversations\//);
  await page.goBack();
  await expect(page).toHaveURL(url);
  await expect(page.locator("#atlas-panel-title")).toHaveText(title!);
  await expect(page.getByTestId("topic-map").locator('.react-flow__node-topic a[aria-current="true"]')).toHaveCount(1);
  await page.reload();
  await expect(page.locator("#atlas-panel-title")).toHaveText(title!);
  // The breadcrumb goes back up to the theme, then to all themes.
  await page.getByRole("navigation", { name: "Map breadcrumb" }).getByRole("link").last().click();
  await expect(page).toHaveURL(/\/map\?theme=th-[0-9a-z-]+$/);
  await page.getByRole("navigation", { name: "Map breadcrumb" }).getByRole("link", { name: "All themes" }).click();
  await expect(page).toHaveURL(/\/map$/);
});

test("keyboard: the map's links are its only focus stops, with no editing announcements; Enter selects", async ({ page }) => {
  await page.goto("/map");
  const map = page.getByTestId("topic-map");
  await expect(mapThemes(page).first()).toBeVisible();
  await expect(map.locator(".react-flow__edge[tabindex], .react-flow__node[tabindex='0']")).toHaveCount(0);
  await expect(page.getByText(/press delete|arrow keys to move/i)).toHaveCount(0);
  await map.locator("a").first().focus();
  const stops: string[] = [];
  for (let i = 0; i < 4; i++) {
    stops.push(await page.evaluate(() => `${document.activeElement?.tagName}:${document.activeElement?.closest(".react-flow__node")?.getAttribute("data-id") ?? ""}`));
    await page.keyboard.press("Tab");
  }
  expect(stops[0]).toBe("A:root");
  for (const s of stops.slice(1)) expect(s).toMatch(/^A:theme:/);
  await mapThemes(page).first().focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/theme=/);
});

test("a large selection keeps labels readable; reduced motion changes the view without animation", async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto("/map");
  await expect(mapThemes(page).first()).toBeVisible();
  await outlineThemes(page).first().click(); // the largest theme
  await expect(page).toHaveURL(/theme=/);
  await expect(page.getByTestId("topic-map").locator(`.react-flow__node-theme a[aria-current="true"]`)).toBeVisible();
  const before = await page.locator(".react-flow__viewport").getAttribute("style");
  await page.waitForTimeout(80);
  expect(await page.locator(".react-flow__viewport").getAttribute("style")).toBe(before); // already settled
  expect(await zoom(page)).toBeGreaterThanOrEqual(FIT_MIN_ZOOM);
  await expect(page.getByTestId("topic-map").locator(`.react-flow__node-theme a[aria-current="true"]`)).toBeInViewport();
  await context.close();
});

test("phones and 200% zoom: the list first, the selection's conversations next, the map on request", async ({ browser }) => {
  // 640 × 400 and 640 × 360: 1280 × 800 and 1280 × 720 at 200% zoom. The map starts near or
  // below the bottom of the window there, so the Map tab has to scroll it into view.
  for (const viewport of [{ width: 375, height: 812 }, { width: 640, height: 400 }, { width: 640, height: 360 }]) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await page.goto("/map");
    await expect(page.getByTestId("atlas-outline")).toBeVisible();
    await expect(page.getByTestId("topic-map")).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    await outlineThemes(page).first().click();
    await expect(page).toHaveURL(/theme=/);
    await expect(page.getByTestId("atlas-panel")).toBeVisible();
    await expect(page.getByTestId("atlas-outline")).toBeHidden();
    // Back up to the tabs, as a reader does (clicking the theme scrolled the page for us).
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.getByRole("navigation", { name: "Map view" }).getByRole("link", { name: "Map" }).click();
    await expect(page).toHaveURL(/view=map/);
    await expect(page.getByTestId("topic-map")).toBeVisible();
    await expect(page.getByTestId("topic-map")).toBeInViewport({ ratio: 0.75 });
    await expect(page.getByTestId("topic-map").locator(`.react-flow__node-theme a[aria-current="true"]`)).toBeInViewport();
    await context.close();
  }
});

test("the map follows the dark theme", async ({ page }) => {
  await page.goto("/map");
  const flow = page.getByTestId("topic-map").locator(".react-flow");
  await page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Dark theme" }).click();
  await expect(flow).toHaveClass(/\bdark\b/);
  await page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Light theme" }).click();
  await expect(flow).toHaveClass(/\blight\b/);
});

test("Other and Not grouped yet are in the outline; the k-means baseline is one click away", async ({ page, baseURL }) => {
  const guards = attachPrivacyGuards(page, baseURL);
  await page.goto("/map");
  await page.getByTestId("atlas-outline").getByRole("link", { name: /^Not grouped yet/ }).click();
  await expect(page).toHaveURL(/theme=ungrouped/);
  await expect(page.locator("#atlas-panel-title")).toHaveText("Not grouped yet");
  await expect(page.getByTestId("atlas-panel").locator("ol[aria-label=Conversations] a").first()).toBeVisible();

  await page.getByRole("link", { name: "Compare with the k-means baseline" }).click();
  await expect(page).toHaveURL(/\/map\?method=kmeans$/);
  await expect(page.getByText(/Showing the k-means baseline/)).toBeVisible();
  const km = outlineThemes(page);
  expect(await km.count()).toBeGreaterThan(1);
  await km.first().click();
  await expect(page).toHaveURL(/method=kmeans&theme=km-/);
  await expect(page.getByTestId("atlas-panel").locator("ol[aria-label=Conversations] a").first()).toBeVisible();
  await page.getByRole("link", { name: "Back to themes and topics" }).click();
  await expect(page).toHaveURL(/\/map$/);
  await guards.assertClean();
});
