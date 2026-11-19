import { expect, test, type Page } from "@playwright/test";
import { attachPrivacyGuards } from "./support/guards";

/** Light and dark theme: the header switch, the system setting, persistence (synthetic, read-only). */

const theme = (p: Page) => p.locator("html").getAttribute("data-theme");
const bodyBackground = (p: Page) => p.evaluate(() => getComputedStyle(document.body).backgroundColor);
const switchButton = (p: Page, name: string) => p.getByRole("group", { name: "Theme" }).getByRole("button", { name: `${name} theme` });

test("follows the system setting until a theme is chosen", async ({ page, baseURL }) => {
  const guards = attachPrivacyGuards(page, baseURL);
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  expect(await theme(page)).toBe("light");
  const light = await bodyBackground(page);
  await expect(switchButton(page, "System")).toHaveAttribute("aria-pressed", "true");

  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => theme(page)).toBe("dark");
  expect(await bodyBackground(page)).not.toBe(light);
  await guards.assertClean();
});

test("a chosen theme applies at once, survives reloads and navigation, and System goes back to the setting", async ({ page, baseURL }) => {
  const guards = attachPrivacyGuards(page, baseURL);
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/conversations");
  const light = await bodyBackground(page);

  await switchButton(page, "Dark").click();
  expect(await theme(page)).toBe("dark");
  await expect(switchButton(page, "Dark")).toHaveAttribute("aria-pressed", "true");
  await expect(switchButton(page, "System")).toHaveAttribute("aria-pressed", "false");
  expect(await bodyBackground(page)).not.toBe(light);

  // Applied before the page is painted: already set when the document has been parsed.
  await page.reload({ waitUntil: "domcontentloaded" });
  expect(await theme(page)).toBe("dark");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  expect(await theme(page)).toBe("dark");

  await switchButton(page, "Light").click();
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await theme(page)).toBe("light"); // a chosen theme ignores the setting

  await switchButton(page, "System").click();
  expect(await theme(page)).toBe("dark");
  expect(await page.evaluate(() => localStorage.length)).toBe(0); // System stores nothing
  await guards.assertClean();
});
