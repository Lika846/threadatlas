import { request as httpRequest } from "node:http";
import { expect, test, type Page, type Request } from "@playwright/test";
import { exportText, syntheticConversation } from "../tests/helpers/synthetic-export";
import { importViaRoute, internalId } from "./support/data";
import { attachPrivacyGuards } from "./support/guards";

/**
 * M2.3 search page on the production build. Runs after the specs that read
 * the shared e2e database (project "search" in playwright.config.ts) and
 * before delete-all, and seeds its own synthetic conversations through the
 * real import route. Planted words start with "zq" and occur nowhere else.
 */
test.describe.configure({ mode: "serial" });

const OLD = Math.floor(Date.now() / 1000) - 10_000_000; // sorts after every other spec's data
type Node = { message: { content: { parts: string[] }; author: { role: string } } | null };

function conv(id: string, title: string, texts: Record<number, string>, messages = 4, updateTime = OLD) {
  const c = syntheticConversation({ id, title, messages, updateTime });
  const mapping = c.mapping as Record<string, Node>;
  for (const [k, text] of Object.entries(texts)) mapping[`n${k}`]!.message!.content.parts = [text];
  return c;
}
function longConversation() {
  // 2,100 messages; every 10th is a system message (hidden). n1501 is displayed as message 1,351 (page 2).
  const c = conv("search-long", "Zqlong synthetic history", { 1_501: "zqdeepterm sits on the second page" }, 2_100);
  const mapping = c.mapping as Record<string, Node>;
  for (let k = 10; k <= 2_100; k += 10) mapping[`n${k}`]!.message!.author.role = "system";
  return c;
}

const SEED = [
  conv("search-marker", "Budget meeting notes", { 2: "We discussed the zqmarker budget <b>draft</b> and <script>alert(1)</script> travel." }),
  conv("search-title", "Zqtitleonly roadmap", {}),
  longConversation(),
  ...Array.from({ length: 25 }, (_, i) => conv(`search-page-${i}`, `Paging result ${i}`, { 1: `zqpaging item ${i}` }, 2, OLD + i)),
];

test.beforeAll(async ({ baseURL }) => {
  await importViaRoute(baseURL!, exportText(SEED));
});

const searchBox = (p: Page) => p.getByRole("searchbox", { name: "Search conversations" });
const results = (p: Page) => p.getByRole("region", { name: /matching conversation/ }).getByRole("listitem");
const heading = (p: Page) => p.locator("#search-results-heading");
const status = (p: Page) => p.getByRole("status");
const isSearchPost = (r: Request) => r.method() === "POST" && new URL(r.url()).pathname === "/search";

async function search(p: Page, q: string) {
  await searchBox(p).fill(q);
  await searchBox(p).press("Enter");
}

/** Everything the browser keeps about this page that could hold a query. */
async function browserTraces(p: Page): Promise<string> {
  const inPage = await p.evaluate(async () => {
    const out: string[] = [location.href, document.cookie, JSON.stringify(history.state ?? null)];
    for (const s of [localStorage, sessionStorage]) {
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i)!;
        out.push(k, s.getItem(k) ?? "");
      }
    }
    const dbs = typeof indexedDB.databases === "function" ? await indexedDB.databases() : [];
    out.push(JSON.stringify(dbs));
    out.push(...performance.getEntries().map((e) => e.name));
    return out.join("\n");
  });
  const cookies = JSON.stringify(await p.context().cookies());
  const storage = JSON.stringify(await p.context().storageState());
  return [inPage, cookies, storage].join("\n");
}

test.describe("results and navigation", () => {
  test("a message match: highlighted snippet as text, opening the exact message", async ({ page, baseURL }) => {
    const guards = attachPrivacyGuards(page, baseURL);
    await page.goto("/search");
    await expect(page).toHaveTitle("Search · ThreadAtlas");
    await search(page, "zqmarker");
    await expect(heading(page)).toHaveText("1 matching conversation");
    const item = results(page).first();
    await expect(item.getByRole("link")).toHaveText("Budget meeting notes");
    await expect(item.locator("mark")).toHaveText(["zqmarker"]);
    await expect(item).toContainText("1 matching message");
    await expect(item).toContainText("Best match: message 2");
    // Imported markup stays text.
    await expect(item).toContainText("<b>draft</b>");
    await expect(item.locator("b, script")).toHaveCount(0);
    const id = internalId("search-marker");
    await expect(item.getByRole("link")).toHaveAttribute("href", `/conversations/${id}#m-2`);
    await item.getByRole("link").click();
    await expect(page).toHaveURL(`/conversations/${id}#m-2`);
    const message = page.locator("article", { has: page.locator("#m-2") });
    await expect(message).toContainText("zqmarker");
    await expect(page.locator("#m-2")).toBeInViewport();
    // In-app navigation uses history.pushState (no :target); LinkedMessageMarker marks it.
    await expect(page.locator("article[data-linked]")).toHaveCount(1);
    await expect(page.locator("article[data-linked]")).toContainText("zqmarker");
    await expect(page.locator("article[data-linked]")).toHaveCSS("outline-style", "solid");
    await expect(page.locator("article:not([data-linked])").first()).toHaveCSS("outline-style", "none");
    // A directly loaded link is also marked by CSS :target.
    await page.goto(`/conversations/${id}#m-2`);
    await expect(page.locator("article:has(h3:target)")).toContainText("zqmarker");
    await expect(page.locator("article:has(h3:target)")).toHaveCSS("outline-style", "solid");
    await guards.assertClean();
  });

  test("a title-only match links to the conversation's top, with no snippet", async ({ page, baseURL }) => {
    const guards = attachPrivacyGuards(page, baseURL);
    await page.goto("/search");
    await search(page, "zqtitleonly");
    const item = results(page).first();
    await expect(item.getByRole("link")).toHaveText("Zqtitleonly roadmap");
    await expect(item.locator("h3 mark")).toHaveText(["Zqtitleonly"]);
    await expect(item).toContainText("Title match");
    await expect(item).not.toContainText("matching message");
    await expect(item).not.toContainText("Best match");
    await expect(item.getByRole("link")).toHaveAttribute("href", `/conversations/${internalId("search-title")}`);
    await guards.assertClean();
  });

  test("a long conversation: the link opens page 2 at the displayed message number", async ({ page, baseURL }) => {
    const guards = attachPrivacyGuards(page, baseURL);
    await page.goto("/search");
    await search(page, "zqdeepterm");
    await expect(results(page).first()).toContainText("Best match: message 1,351");
    const link = results(page).first().getByRole("link");
    const id = internalId("search-long");
    await expect(link).toHaveAttribute("href", `/conversations/${id}?page=2#m-1351`);
    await link.click();
    await expect(page).toHaveURL(`/conversations/${id}?page=2#m-1351`);
    const message = page.locator("article", { has: page.locator("#m-1351") });
    await expect(message).toContainText("zqdeepterm");
    await expect(message).toContainText("Message 1351");
    await expect(page.locator("#m-1351")).toBeInViewport();
    await expect(page.locator("article[data-linked]")).toHaveCount(1);
    await expect(page.locator("article[data-linked]")).toContainText("Message 1351");
    await guards.assertClean();
  });

  test("the linked message stays marked through Back and Forward; a page without an anchor marks nothing", async ({ page, baseURL }) => {
    const guards = attachPrivacyGuards(page, baseURL);
    const marked = page.locator("article[data-linked]");
    const id = internalId("search-long");
    await page.goto("/search");
    await search(page, "zqdeepterm");
    await results(page).first().getByRole("link").click();
    await expect(page).toHaveURL(`/conversations/${id}?page=2#m-1351`);
    await expect(marked).toHaveCount(1);
    await expect(marked).toContainText("Message 1351");

    // Back to the results, then Forward to the same message.
    await page.goBack();
    await expect(page).toHaveURL("/search");
    await expect(heading(page)).toHaveText("1 matching conversation");
    await page.goForward();
    await expect(page).toHaveURL(`/conversations/${id}?page=2#m-1351`);
    await expect(marked).toHaveCount(1);
    await expect(marked).toContainText("Message 1351");
    await expect(page.locator("#m-1351")).toBeInViewport();

    // Page 1 of the same conversation (no anchor): nothing is marked.
    await page.getByRole("navigation", { name: "Message pages", exact: true }).getByRole("link", { name: "Previous messages" }).click();
    await expect(page).toHaveURL(`/conversations/${id}`);
    await expect(page.getByText("Messages 1–1000")).toBeVisible();
    await expect(marked).toHaveCount(0);

    // Back (a history traversal within the conversation) marks the message again.
    await page.goBack();
    await expect(page).toHaveURL(`/conversations/${id}?page=2#m-1351`);
    await expect(marked).toHaveCount(1);
    await expect(marked).toContainText("Message 1351");

    // Another result in the same session marks only its own message.
    await page.goBack();
    await expect(page).toHaveURL("/search");
    // Back runs the remembered search again once the page has hydrated; until then the form
    // ignores Enter. Wait for the restored results before typing the next query…
    await expect(heading(page)).toHaveText("1 matching conversation");
    await expect(results(page).first().getByRole("link")).toHaveAttribute("href", `/conversations/${id}?page=2#m-1351`);
    await search(page, "zqmarker");
    // …and for the new query's result (the marker conversation's message 2) before clicking.
    const markerLink = results(page).first().getByRole("link");
    await expect(markerLink).toHaveAttribute("href", new RegExp(`^/conversations/${internalId("search-marker")}#m-2$`));
    await markerLink.click();
    await expect(page).toHaveURL(new RegExp(`/conversations/${internalId("search-marker")}#m-2$`));
    await expect(marked).toHaveCount(1);
    await expect(marked).toContainText("zqmarker");
    await guards.assertClean();
  });
});

test.describe("validation, empty results, loading and errors", () => {
  test("invalid queries get a message, are not sent, and are never cut short", async ({ page, baseURL }) => {
    const guards = attachPrivacyGuards(page, baseURL);
    const posts: string[] = [];
    page.on("request", (r) => isSearchPost(r) && posts.push(r.url()));
    await page.goto("/search");
    const long = "zqlong".repeat(50); // 300 characters
    const cases: [string, RegExp][] = [
      ["", /Enter a word or phrase/],
      ["!!! ???", /no words to look for/],
      [long, /is 300 characters long\. The limit is 256/],
      [Array.from({ length: 17 }, (_, i) => `w${i}`).join(" "), /has 17 words or phrases\. The limit is 16/],
      ["z*", /at least 2 letters or digits before \*/],
    ];
    for (const [q, message] of cases) {
      await search(page, q);
      const alert = page.locator("#search-error");
      await expect(alert).toHaveText(message);
      await expect(alert).toHaveAttribute("role", "alert");
      await expect(searchBox(page)).toHaveAttribute("aria-invalid", "true");
      await expect(searchBox(page)).toHaveAttribute("aria-describedby", "search-help search-error");
      await expect(searchBox(page)).toHaveValue(q); // nothing truncated
    }
    expect(posts, "no request for an invalid query").toEqual([]);
    await search(page, "zqmarker");
    await expect(heading(page)).toHaveText("1 matching conversation");
    await expect(searchBox(page)).not.toHaveAttribute("aria-invalid", /.*/);
    await guards.assertClean();
  });

  test("no matches: a clear message showing the query as text", async ({ page, baseURL }) => {
    const guards = attachPrivacyGuards(page, baseURL);
    await page.goto("/search");
    await search(page, "zqnothingmatches <i>x</i>");
    await expect(heading(page)).toHaveText("No matching conversations");
    await expect(page.locator("main q")).toHaveText("zqnothingmatches <i>x</i>");
    await expect(page.getByText("hidden messages and other branches are not searched")).toBeVisible();
    await expect(status(page)).toHaveText("No conversations match.");
    await guards.assertClean();
  });

  test("loading: the button and status say Searching…, results are busy until the response", async ({ page, baseURL }) => {
    const guards = attachPrivacyGuards(page, baseURL);
    await page.goto("/search");
    await search(page, "zqpaging");
    await expect(heading(page)).toHaveText("25 matching conversations");
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route((u) => u.pathname === "/search", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await held;
      await route.continue();
    });
    await search(page, "zqmarker");
    const button = page.getByRole("button", { name: "Searching…" });
    await expect(button).toBeDisabled();
    await expect(status(page)).toHaveText("Searching…");
    await expect(page.getByRole("region", { name: /matching conversation/ })).toHaveAttribute("aria-busy", "true");
    release();
    await expect(heading(page)).toHaveText("1 matching conversation");
    await expect(page.getByRole("button", { name: "Search", exact: true })).toBeEnabled();
    await expect(page.getByRole("region", { name: /matching conversation/ })).toHaveAttribute("aria-busy", "false");
    await guards.assertClean();
  });

  test("a failed request shows a fixed error and clears the previous results", async ({ page, baseURL }) => {
    // The aborted request is logged by Chromium, and Next.js reports the failed action call.
    const guards = attachPrivacyGuards(page, baseURL, { allowConsoleErrors: [/Failed to load resource/, /ERR_FAILED/, /Failed to fetch/i, /server action/i] });
    await page.goto("/search");
    await search(page, "zqpaging");
    await expect(heading(page)).toHaveText("25 matching conversations");
    // Refusals by the action's own guard are checked with raw requests below (the browser
    // always adds Origin and Sec-Fetch-Site); here the request fails on the way.
    await page.route((u) => u.pathname === "/search", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.abort("failed");
    });
    await search(page, "zqmarker");
    const alert = page.getByRole("main").getByRole("alert");
    await expect(alert).toHaveText("Search failed unexpectedly. Try again.");
    await expect(heading(page)).toHaveCount(0);
    await expect(page.locator("main mark")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Search", exact: true })).toBeEnabled();
    await guards.assertClean();
  });
});

test.describe("pagination, keyboard and overlapping searches", () => {
  test("keyboard only: search, focus moves to the results, pages change without the URL", async ({ page, baseURL }) => {
    const guards = attachPrivacyGuards(page, baseURL);
    await page.goto("/search");
    await expect(page.getByRole("button", { name: "Search", exact: true })).toBeEnabled(); // hydrated
    for (let i = 0; i < 20 && !(await searchBox(page).evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
    await expect(searchBox(page)).toBeFocused();
    await page.keyboard.type("zqpaging");
    await page.keyboard.press("Enter");
    await expect(heading(page)).toHaveText("25 matching conversations");
    await expect(heading(page)).toBeFocused();
    await expect(status(page)).toHaveText("25 conversations match. Page 1 of 2, results 1–20.");
    await expect(results(page)).toHaveCount(20);
    await expect(page.getByText("Results 1–20 of 25")).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Search result pages" });
    await expect(nav.getByRole("button", { name: "Previous results" })).toBeDisabled();
    await nav.getByRole("button", { name: "Next results" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Results 21–25 of 25")).toBeVisible();
    await expect(heading(page)).toBeFocused();
    await expect(status(page)).toHaveText("25 conversations match. Page 2 of 2, results 21–25.");
    await expect(nav).toContainText("Page 2 of 2");
    await expect(results(page)).toHaveCount(5);
    await expect(page).toHaveURL("/search");
    // Deterministic order: newest update first; page 2 holds the five oldest.
    await expect(results(page).getByRole("link")).toHaveText(["Paging result 4", "Paging result 3", "Paging result 2", "Paging result 1", "Paging result 0"]);
    // Tab from the heading reaches the first result's link; Enter opens it.
    await page.keyboard.press("Tab");
    await expect(results(page).first().getByRole("link")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/conversations/${internalId("search-page-4")}#m-1$`));
    await guards.assertClean();
  });

  test("overlapping searches: only the latest response updates the page", async ({ page, baseURL }) => {
    const guards = attachPrivacyGuards(page, baseURL);
    await page.goto("/search");
    await expect(page.getByRole("button", { name: "Search", exact: true })).toBeEnabled();
    // Flag any moment at which the older search's result is on screen.
    await page.evaluate(() => {
      const w = window as unknown as { staleSeen: boolean };
      w.staleSeen = false;
      new MutationObserver(() => {
        if (document.querySelector("main ol")?.textContent?.includes("Budget meeting notes")) w.staleSeen = true;
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((r) => (releaseFirst = r));
    let n = 0;
    await page.route((u) => u.pathname === "/search", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const i = n++;
      if (i === 0) await firstHeld;
      await route.continue();
    });

    // The first search (zqmarker) is held; the second is typed and submitted meanwhile.
    const firstRequest = page.waitForRequest(isSearchPost);
    await searchBox(page).fill("zqmarker");
    await searchBox(page).press("Enter");
    await expect.poll(() => n).toBe(1);
    const first = await firstRequest;
    // The submit button is disabled while a search is pending, so the second search is
    // started the way a user can: editing the query and pressing Enter in the field.
    await searchBox(page).fill("zqtitleonly");
    await page.evaluate(() => document.querySelector("form[role=search]")!.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true })));
    // Does Next.js send the second request while the first is pending?
    const parallel = await expect
      .poll(() => n, { timeout: 3_000 })
      .toBe(2)
      .then(() => true)
      .catch(() => false);
    if (parallel) {
      // Reversed completion: the second response arrives first, then the first.
      await expect(heading(page)).toHaveText("1 matching conversation");
      await expect(results(page).first().getByRole("link")).toHaveText("Zqtitleonly roadmap");
      releaseFirst();
      await first.response();
    } else {
      // Next.js queues Server Action calls: the second is sent after the first completes.
      test.info().annotations.push({ type: "measured", description: "Next.js sent the second Server Action only after the first completed" });
      releaseFirst();
      await first.response();
      await expect.poll(() => n).toBe(2);
    }
    await expect(page.getByRole("button", { name: "Search", exact: true })).toBeEnabled(); // the latest search finished
    await expect(results(page).first().getByRole("link")).toHaveText("Zqtitleonly roadmap");
    await expect(results(page)).toHaveCount(1);
    expect(await page.evaluate(() => (window as unknown as { staleSeen: boolean }).staleSeen), "older results were never shown").toBe(false);
    test.info().annotations.push({ type: "measured", description: `second request sent ${parallel ? "before" : "after"} the first completed` });
    await guards.assertClean();
  });
});

test.describe("state across navigation", () => {
  test("Back from a conversation restores the query and page and searches again (fresh results); reload clears it", async ({ page, baseURL }) => {
    const guards = attachPrivacyGuards(page, baseURL);
    const posts: number[] = [];
    page.on("request", (r) => isSearchPost(r) && posts.push(Date.now()));
    await page.goto("/search");
    await search(page, "zqpaging");
    await expect(heading(page)).toHaveText("25 matching conversations");
    await page.getByRole("button", { name: "Next results" }).click();
    await expect(page.getByText("Results 21–25 of 25")).toBeVisible();
    await results(page).first().getByRole("link").click();
    await expect(page).toHaveURL(/\/conversations\//);
    const before = posts.length;

    // While the conversation is open, a new matching conversation is imported.
    await importViaRoute(baseURL!, exportText([conv("search-page-late", "Paging result late", { 1: "zqpaging late" }, 2, OLD - 1)]));

    await page.goBack();
    await expect(page).toHaveURL("/search");
    await expect(searchBox(page)).toHaveValue("zqpaging");
    // Fresh: the new conversation is counted, so the results were not replayed from memory.
    await expect(heading(page)).toHaveText("26 matching conversations");
    await expect(page.getByText("Results 21–26 of 26")).toBeVisible();
    expect(posts.length, "the search ran again on return").toBe(before + 1);
    await expect(heading(page)).not.toBeFocused(); // focus is not pulled on restore

    await page.reload();
    await expect(searchBox(page)).toHaveValue("");
    await expect(heading(page)).toHaveCount(0);
    await guards.assertClean();
  });
});

test.describe("privacy", () => {
  test("search terms never reach URLs, history state, cookies or browser storage; responses are not cached", async ({ page, baseURL }) => {
    const guards = attachPrivacyGuards(page, baseURL);
    const TERM = "zqmarker";
    const urls: string[] = [];
    page.on("request", (r) => urls.push(r.url()));
    page.on("framenavigated", (f) => urls.push(f.url()));
    const pageResponse = await page.goto("/search");
    expect(pageResponse!.headers()["cache-control"]).toMatch(/no-store/);

    const actionResponse = page.waitForResponse((r) => isSearchPost(r.request()));
    await search(page, TERM);
    const res = await actionResponse;
    await expect(heading(page)).toHaveText("1 matching conversation");
    const cacheControl = res.headers()["cache-control"] ?? "";
    expect(cacheControl, "Server Action response").toMatch(/no-store/);
    test.info().annotations.push({ type: "measured", description: `Cache-Control: page "${pageResponse!.headers()["cache-control"]}", action "${cacheControl}"` });
    expect(res.request().postData() ?? "", "the query travels in the POST body").toContain(TERM);

    expect(await browserTraces(page)).not.toContain(TERM);
    await results(page).first().getByRole("link").click();
    await expect(page).toHaveURL(/\/conversations\//);
    expect(await browserTraces(page)).not.toContain(TERM);
    await page.goBack();
    await expect(heading(page)).toHaveText("1 matching conversation");
    expect(await browserTraces(page)).not.toContain(TERM);
    expect(urls.filter((u) => u.includes(TERM))).toEqual([]);
    await guards.assertClean();
  });

  test("forged, cross-origin and Origin-less Server Action requests return no results", async ({ browser, baseURL }) => {
    const base = baseURL!;
    const context = await browser.newContext();
    const page = await context.newPage();
    let captured: { headers: Record<string, string>; body: Buffer } | undefined;
    await page.route((u) => u.pathname === "/search", async (route) => {
      const req = route.request();
      if (req.method() !== "POST") return route.continue();
      const headers: Record<string, string> = { host: new URL(req.url()).host, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" };
      for (const [k, v] of Object.entries(await req.allHeaders())) if (!k.startsWith(":")) headers[k] = v;
      captured = { headers, body: req.postDataBuffer() ?? Buffer.alloc(0) };
      await route.abort();
    });
    await page.goto("/search");
    await search(page, "zqmarker");
    await expect.poll(() => captured !== undefined).toBe(true);
    await context.close();

    const post = (headers: Record<string, string>) =>
      new Promise<string>((resolve, reject) => {
        const u = new URL(base);
        const h = { ...headers };
        delete h["accept-encoding"];
        delete h["content-length"];
        const req = httpRequest({ host: u.hostname, port: u.port, path: "/search", method: "POST", headers: h, setHost: false, agent: false }, (r) => {
          let b = "";
          r.setEncoding("utf8");
          r.on("data", (c: string) => (b += c));
          r.on("end", () => resolve(b));
        });
        req.on("error", reject);
        req.end(captured!.body);
      });
    const without = (h: Record<string, string>, k: string) => Object.fromEntries(Object.entries(h).filter(([key]) => key !== k));

    // Positive control: the captured request returns the result.
    expect(await post(captured!.headers)).toContain("Budget meeting notes");
    const refused: [string, Record<string, string>, RegExp | null][] = [
      ["missing Origin", without(captured!.headers, "origin"), /REQUEST_FORBIDDEN/],
      ["foreign Origin", { ...captured!.headers, origin: "http://evil.example" }, null],
      ["cross-site fetch", { ...captured!.headers, "sec-fetch-site": "cross-site" }, /REQUEST_FORBIDDEN/],
      ["missing Next-Action", without(captured!.headers, "next-action"), null],
    ];
    for (const [label, headers, marker] of refused) {
      const body = await post(headers);
      expect(body, label).not.toContain("Budget meeting notes");
      expect(body, label).not.toContain("zqmarker budget");
      if (marker) expect(body, label).toMatch(marker);
    }
  });
});
