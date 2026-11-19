import { expect, test } from "@playwright/test";

/**
 * End-to-end DNS-rebinding simulation. Chromium is told that `rebind.test`
 * resolves to 127.0.0.1, which is what an attacker's DNS would do. The browser
 * then sends `Host: rebind.test:<port>`, and the app must refuse to serve.
 * Nothing leaves the machine: the name is resolved locally by Chromium.
 */
test.use({
  launchOptions: { args: ["--host-resolver-rules=MAP rebind.test 127.0.0.1"] },
});

test("app refuses to serve a page loaded via a rebound domain", async ({
  page,
  baseURL,
}) => {
  const port = new URL(baseURL!).port;

  const rebound = await page.goto(`http://rebind.test:${port}/`);
  expect(rebound?.status()).toBe(403);
  await expect(
    page.getByRole("heading", { name: "ThreadAtlas" }),
  ).toHaveCount(0);

  // Control: the same browser reaches the app normally via loopback.
  const direct = await page.goto(`http://127.0.0.1:${port}/`);
  expect(direct?.status()).toBe(200);
  await expect(
    page.getByRole("heading", { level: 1, name: "ThreadAtlas" }),
  ).toBeVisible();
});

test("a rebound page cannot read app data via fetch", async ({
  page,
  baseURL,
}) => {
  const port = new URL(baseURL!).port;
  // Attacker's page on the rebound origin (here: the app's own 403 page).
  await page.goto(`http://rebind.test:${port}/`);
  const result = await page.evaluate(async () => {
    const res = await fetch("/conversations");
    return { status: res.status, body: await res.text() };
  });
  expect(result.status).toBe(403);
  expect(result.body).not.toContain("Conversations");
});
