import { expect, test } from "@playwright/test";
import { attachPrivacyGuards } from "./support/guards";

const SECTIONS = [
  { label: "Conversations", path: "/conversations" },
  { label: "Search", path: "/search" },
  { label: "Map", path: "/map" },
  { label: "Import", path: "/import" },
  { label: "Settings", path: "/settings" },
] as const;

test.describe("navigation shell", () => {
  for (const { label, path } of SECTIONS) {
    test(`nav link "${label}" opens its page`, async ({ page, baseURL }) => {
      const guards = attachPrivacyGuards(page, baseURL);
      await page.goto("/");

      const nav = page.getByRole("navigation", { name: "Main" });
      await nav.getByRole("link", { name: label }).click();

      await expect(page).toHaveURL(path);
      await expect(page).toHaveTitle(`${label} · ThreadAtlas`);
      await expect(
        page.getByRole("heading", { level: 1, name: label }),
      ).toBeVisible();

      // Exactly the current section is marked as the current page.
      for (const other of SECTIONS) {
        const link = nav.getByRole("link", { name: other.label });
        if (other.label === label) {
          await expect(link).toHaveAttribute("aria-current", "page");
        } else {
          await expect(link).not.toHaveAttribute("aria-current", /.*/);
        }
      }

      await guards.assertClean();
    });

    test(`direct load of ${path} renders its heading`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await expect(
        page.getByRole("heading", { level: 1, name: label }),
      ).toBeVisible();
    });
  }

  test("page exposes one of each landmark", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("banner")).toHaveCount(1);
    await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(1);
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page.getByRole("contentinfo")).toHaveCount(1);
  });
});

test.describe("keyboard access", () => {
  test("skip link is the first tab stop and moves focus to main content", async ({
    page,
  }) => {
    await page.goto("/settings");

    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();

    await page.keyboard.press("Enter");
    await expect(page.locator("#main-content")).toBeFocused();
    await expect(page).toHaveURL(/#main-content$/);
  });

  test("skip link is visually hidden until focused, then shown", async ({
    page,
  }) => {
    await page.goto("/");
    const skip = page.getByRole("link", { name: "Skip to content" });

    // sr-only shrinks the element to 1×1 px while unfocused.
    const hidden = await skip.boundingBox();
    expect(hidden?.width ?? 0).toBeLessThanOrEqual(1);

    await page.keyboard.press("Tab");
    await expect(skip).toBeFocused();
    const shown = await skip.boundingBox();
    expect(shown?.width ?? 0).toBeGreaterThan(40);
    expect(shown?.height ?? 0).toBeGreaterThan(20);
  });

  test("tab order follows skip link, home, then main navigation", async ({
    page,
  }) => {
    await page.goto("/");
    const expected = [
      "Skip to content",
      "ThreadAtlas",
      ...SECTIONS.map((s) => s.label),
    ];
    for (const name of expected) {
      await page.keyboard.press("Tab");
      await expect(page.getByRole("link", { name, exact: true })).toBeFocused();
    }
  });

  test("navigation links are activated with the keyboard", async ({ page }) => {
    await page.goto("/");
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Import" })
      .focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL("/import");
    await expect(
      page.getByRole("heading", { level: 1, name: "Import" }),
    ).toBeVisible();
  });
});
