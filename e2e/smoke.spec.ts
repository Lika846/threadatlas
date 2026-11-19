import { expect, test } from "@playwright/test";
import { attachPrivacyGuards } from "./support/guards";

test.describe("smoke", () => {
  test("home page renders without errors or off-machine requests", async ({
    page,
    baseURL,
  }) => {
    const guards = attachPrivacyGuards(page, baseURL);

    const response = await page.goto("/");
    expect(response?.status()).toBe(200);

    await expect(page).toHaveTitle("ThreadAtlas");
    await expect(
      page.getByRole("heading", { level: 1, name: "ThreadAtlas" }),
    ).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");

    await guards.assertClean();
  });

  test("responses carry the privacy headers", async ({ request }) => {
    const response = await request.get("/");
    const headers = response.headers();

    expect(headers["content-security-policy"]).toContain("connect-src 'self'");
    expect(headers["content-security-policy"]).not.toContain("unsafe-eval");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["x-powered-by"]).toBeUndefined();
  });
});
