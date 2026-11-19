import { request as httpRequest } from "node:http";
import { expect, test, type Page } from "@playwright/test";
import { fixtureText } from "../tests/helpers/fixtures";
import { exportText, syntheticConversation } from "../tests/helpers/synthetic-export";
import { importViaRoute, tableCounts } from "./support/data";
import { attachPrivacyGuards } from "./support/guards";

/**
 * M1.7 delete-all and storage cleanup on the production build. Runs last
 * (project "delete-all" in playwright.config.ts), after every spec that reads
 * the shared e2e database, and seeds its own synthetic fixtures. Database
 * counts are read directly (read-only) from the run's temporary database.
 */
test.describe.configure({ mode: "serial" });

const FIXTURES = ["linear.json", "branching.json"];
const seed = async (baseURL: string) => {
  for (const f of FIXTURES) await importViaRoute(baseURL, fixtureText(f));
};

type Captured = { headers: Record<string, string>; body: Buffer };

/**
 * Submits a Settings form once in a throwaway page and captures the real
 * Server Action request without sending it (aborted in the browser), so raw
 * variations of it can be replayed.
 */
async function captureAction(page: Page, submit: (p: Page) => Promise<void>): Promise<Captured> {
  let captured: Captured | undefined;
  await page.route(
    (url) => url.pathname === "/settings",
    async (route) => {
      const req = route.request();
      if (req.method() !== "POST") return route.continue();
      // Headers the network stack adds (Host, Sec-Fetch-*) are not visible
      // to a route handler; add the values Chromium sends for this request
      // (measured in M1.7 step 0).
      const headers: Record<string, string> = { host: new URL(req.url()).host, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" };
      for (const [k, v] of Object.entries(await req.allHeaders())) if (!k.startsWith(":")) headers[k] = v;
      captured = { headers, body: req.postDataBuffer() ?? Buffer.alloc(0) };
      await route.abort();
    },
  );
  await page.goto("/settings");
  await submit(page);
  await expect.poll(() => captured !== undefined).toBe(true);
  await page.close();
  return captured!;
}

/** Raw POST to /settings with hand-set headers (no compression, so the RSC body is readable). */
function post(baseURL: string, headers: Record<string, string>, body: Buffer): Promise<{ status: number; body: string }> {
  const u = new URL(baseURL);
  const h = { ...headers };
  delete h["accept-encoding"];
  delete h["content-length"];
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: u.hostname, port: u.port, path: "/settings", method: "POST", headers: h, setHost: false, agent: false }, (res) => {
      let b = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** The no-JavaScript form fields Next.js renders into the Settings page HTML. */
async function noJsFields(baseURL: string): Promise<[string, string][]> {
  const html = await (await fetch(`${baseURL}/settings`)).text();
  return [...html.matchAll(/<input[^>]*type="hidden"[^>]*>/g)].map((m) => {
    const name = m[0].match(/name="([^"]*)"/)?.[1] ?? "";
    const value = (m[0].match(/value="([^"]*)"/)?.[1] ?? "").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    return [name, value];
  });
}

async function multipart(fields: [string, string][]): Promise<{ body: Buffer; type: string }> {
  const fd = new FormData();
  for (const [k, v] of fields) fd.append(k, v);
  const r = new Response(fd);
  return { body: Buffer.from(await r.arrayBuffer()), type: r.headers.get("content-type")! };
}

const typePhrase = async (p: Page, text: string) => p.getByLabel("Type DELETE to confirm").fill(text);
const deleteButton = (p: Page) => p.getByRole("button", { name: "Delete all imported data" });

test.beforeAll(async ({ baseURL }) => {
  await seed(baseURL!);
});

test("shows what will be deleted; Delete stays disabled until exactly DELETE; Cancel deletes nothing", async ({ page, baseURL }) => {
  const guards = attachPrivacyGuards(page, baseURL);
  const before = tableCounts();
  expect(before.conversations).toBeGreaterThan(0);
  await page.goto("/settings");
  await expect(page.getByRole("heading", { level: 2, name: "Delete all imported data" })).toBeVisible();
  await expect(page.getByText(`This deletes ${before.conversations.toLocaleString("en-US")} conversation`)).toBeVisible();
  await expect(deleteButton(page)).toBeDisabled();
  for (const wrong of ["delete", "Delete", "DELET", "DELETE ", " DELETE"]) {
    await typePhrase(page, wrong);
    await expect(deleteButton(page)).toBeDisabled();
  }
  await typePhrase(page, "DELETE");
  await expect(deleteButton(page)).toBeEnabled();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByLabel("Type DELETE to confirm")).toHaveValue("");
  await expect(page.getByLabel("Type DELETE to confirm")).toBeFocused();
  await expect(deleteButton(page)).toBeDisabled();
  expect(tableCounts()).toEqual(before);
  await page.goto("/conversations");
  await expect(page.getByRole("heading", { name: "No conversations yet" })).toHaveCount(0);
  await guards.assertClean();
});

test("forged, cross-origin and malformed Server Action requests delete nothing", async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const base = baseURL!;
  const host = new URL(base).host;
  const context = await browser.newContext();
  const valid = await captureAction(await context.newPage(), async (p) => {
    await typePhrase(p, "DELETE");
    await deleteButton(p).click();
  });
  expect(valid.headers["next-action"]).toBeTruthy();
  expect(valid.headers.origin).toBe(base);
  const before = tableCounts();
  expect(before.conversations).toBeGreaterThan(0);

  const without = (h: Record<string, string>, k: string) => {
    const c = { ...h };
    delete c[k];
    return c;
  };
  const wrongPhraseBody = Buffer.from(valid.body.toString("latin1").replace("\r\n\r\nDELETE\r\n", "\r\n\r\ndelete\r\n"), "latin1");
  expect(wrongPhraseBody.equals(valid.body)).toBe(false);

  const fields = await noJsFields(base);
  expect(fields.length).toBeGreaterThan(0);
  const noJs = await multipart([...fields, ["confirm", "DELETE"]]);

  const cases: [string, Record<string, string>, Buffer, RegExp | null][] = [
    // [label, headers, body, expected marker in our action's reply (null: rejected by Next.js or the proxy)]
    ["missing Origin", without(valid.headers, "origin"), valid.body, /REQUEST_FORBIDDEN/],
    ["forged Origin", { ...valid.headers, origin: "http://evil.example" }, valid.body, null],
    ["Origin of the other loopback name", { ...valid.headers, origin: `http://localhost:${new URL(base).port}` }, valid.body, null],
    ["Sec-Fetch-Site cross-site", { ...valid.headers, "sec-fetch-site": "cross-site" }, valid.body, /REQUEST_FORBIDDEN/],
    ["missing Next-Action", without(valid.headers, "next-action"), valid.body, null],
    ["forged Next-Action", { ...valid.headers, "next-action": "7f".padEnd(42, "0") }, valid.body, null],
    ["forged Host", { ...valid.headers, host: "rebind.example" }, valid.body, null],
    ["wrong confirmation phrase", valid.headers, wrongPhraseBody, /CONFIRMATION_REQUIRED/],
    ["no-JavaScript form post, same Origin", { host, origin: base, "content-type": noJs.type }, noJs.body, /REQUEST_FORBIDDEN/],
    ["no-JavaScript form post, no Origin", { host, "content-type": noJs.type }, noJs.body, /REQUEST_FORBIDDEN/],
  ];
  for (const [label, headers, body, marker] of cases) {
    const r = await post(base, headers, body);
    expect(tableCounts(), label).toEqual(before);
    if (marker) expect(r.body, label).toMatch(marker);
    else expect(r.status, label).toBeGreaterThanOrEqual(400);
  }

  // A real browser on another origin (intercepted locally; nothing leaves the machine).
  const attacker = await context.newPage();
  const inputs = fields.map(([k, v]) => `<input type="hidden" name="${k}" value='${v.replace(/'/g, "&#39;")}'>`).join("");
  await attacker.route("http://attacker.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><form id="f" method="POST" enctype="multipart/form-data" action="${base}/settings">${inputs}<input name="confirm" value="DELETE"></form>`,
    }),
  );
  await attacker.goto("http://attacker.test/");
  const navigated = attacker.waitForNavigation({ timeout: 10_000 }).catch(() => null);
  await attacker.evaluate(() => (document.getElementById("f") as HTMLFormElement).submit());
  await navigated;
  expect(tableCounts(), "cross-origin form").toEqual(before);

  // Positive control: the captured request itself is accepted and deletes everything.
  const ok = await post(base, valid.headers, valid.body);
  expect(ok.body).toMatch(/"outcome":"complete"/);
  expect(tableCounts()).toEqual({ conversations: 0, messages: 0, imports: 0 });
  await context.close();
  await seed(base);
});

test("confirming deletes everything, reports success, and Conversations shows the empty state", async ({ page, baseURL }) => {
  const guards = attachPrivacyGuards(page, baseURL);
  const before = tableCounts();
  expect(before.conversations).toBeGreaterThan(0);
  await page.goto("/settings");
  await typePhrase(page, "DELETE");
  await deleteButton(page).click();
  const result = page.locator("[data-outcome]");
  await expect(result).toHaveAttribute("data-outcome", "complete");
  await expect(result).toHaveAttribute("role", "status");
  await expect(result).toBeFocused();
  await expect(result).toContainText(
    `All imported data was deleted: ${before.conversations} conversation${before.conversations === 1 ? "" : "s"}, ${before.messages} messages and ${before.imports} import record${before.imports === 1 ? "" : "s"}. Storage cleanup finished and its checks passed.`,
  );
  expect(tableCounts()).toEqual({ conversations: 0, messages: 0, imports: 0 });
  // The page now offers cleanup instead of deletion; a verified run shows no warning.
  await expect(page.getByText("There is no imported data.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Finish storage cleanup" })).toBeEnabled();
  await expect(page.getByText(/Cleanup may be incomplete/)).toHaveCount(0);
  await expect(deleteButton(page)).toHaveCount(0);

  await result.getByRole("link", { name: "View conversations" }).click();
  await expect(page.getByRole("heading", { name: "No conversations yet" })).toBeVisible();
  await guards.assertClean();
});

test("Finish storage cleanup is available with no data, is repeatable, and reports its own result", async ({ page, baseURL }) => {
  const guards = attachPrivacyGuards(page, baseURL);
  await page.goto("/settings");
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "Finish storage cleanup" }).click();
    const result = page.locator("[data-outcome]");
    await expect(result).toHaveAttribute("data-outcome", "cleanup_complete");
    await expect(result).toContainText("Storage cleanup finished and its checks passed. No records were deleted.");
  }
  expect(tableCounts()).toEqual({ conversations: 0, messages: 0, imports: 0 });
  await guards.assertClean();
});

test("cleanup called directly never deletes data, and importing works again after deletion", async ({ browser, baseURL }) => {
  const base = baseURL!;
  const context = await browser.newContext();
  const cleanup = await captureAction(await context.newPage(), (p) => p.getByRole("button", { name: "Finish storage cleanup" }).click());
  await context.close();

  await seed(base); // the normal import pipeline after delete-all
  const after = tableCounts();
  expect(after.conversations).toBeGreaterThan(0);

  const r = await post(base, cleanup.headers, cleanup.body);
  expect(r.body).toMatch(/IMPORTED_DATA_PRESENT/);
  expect(tableCounts()).toEqual(after);
  const forbidden = await post(base, { ...cleanup.headers, "sec-fetch-site": "cross-site" }, cleanup.body);
  expect(forbidden.body).toMatch(/REQUEST_FORBIDDEN/);
  expect(tableCounts()).toEqual(after);

  const page = await browser.newPage();
  await page.goto("/conversations");
  await expect(page.getByRole("heading", { name: "No conversations yet" })).toHaveCount(0);
  await page.close();
});

test("a search result opened after delete-all shows the not-found page; Search shows nothing stale (M2.3)", async ({ browser, page, baseURL }) => {
  const guards = attachPrivacyGuards(page, baseURL);
  const stale = syntheticConversation({ id: "stale-search", title: "Zqstale planning", messages: 2, tag: "zqstale" });
  await importViaRoute(baseURL!, exportText([stale]));
  await page.goto("/search");
  await page.getByRole("searchbox", { name: "Search conversations" }).fill("zqstale");
  await page.getByRole("searchbox", { name: "Search conversations" }).press("Enter");
  const link = page.getByRole("link", { name: "Zqstale planning" });
  await expect(link).toBeVisible();

  // Everything is deleted from another tab while the results are on screen.
  const other = await browser.newPage();
  await other.goto("/settings");
  await typePhrase(other, "DELETE");
  await deleteButton(other).click();
  await expect(other.locator("[data-outcome]")).toHaveAttribute("data-outcome", "complete");
  await other.close();
  expect(tableCounts().conversations).toBe(0);

  await link.click();
  await expect(page.getByRole("heading", { level: 1, name: "Conversation not found" })).toBeVisible();
  await expect(page.getByText("This conversation no longer exists.")).toBeVisible();

  // Back to the search page: the remembered query runs again, so the deleted result is gone.
  await page.goBack();
  await expect(page).toHaveURL("/search");
  await expect(page.getByRole("link", { name: "Zqstale planning" })).toHaveCount(0);
  await expect(page.getByText("No matching conversations").or(page.getByText("Nothing to search yet"))).toBeVisible();

  await page.goForward();
  await page.getByRole("link", { name: "Search again" }).click();
  await expect(page.getByRole("heading", { name: "Nothing to search yet" })).toBeVisible();
  await guards.assertClean();
  await seed(baseURL!); // leave data behind, as the previous test did
});
