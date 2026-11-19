import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, test, type TestInfo } from "@playwright/test";
import { exportText, syntheticConversation, syntheticExport } from "../tests/helpers/synthetic-export";
import { attachPrivacyGuards } from "./support/guards";

/**
 * M1.5 import route and page, against the production build and its
 * temporary database. Serial: the e2e server has one database, and parallel
 * imports would legitimately collide (IMPORT_BUSY) or race the Last import
 * panel. Synthetic data only; every test uses its own conversation IDs.
 */
test.describe.configure({ mode: "serial" });

const E2E_DB = path.join(process.env.THREADATLAS_E2E_DIR!, "e2e.db");
const PENDING = "Importing… This may take up to a minute. Keep this tab open to see the result.";
const EXPECTED_4XX = [/Failed to load resource: the server responded with a status of 4\d\d/];

function db(readonly = true) {
  return new Database(E2E_DB, { readonly, fileMustExist: true, timeout: 5_000 });
}
function conversationExists(sourceId: string): boolean {
  const d = db();
  try {
    return d.prepare('SELECT 1 FROM "Conversation" WHERE "sourceId" = ?').get(sourceId) !== undefined;
  } finally {
    d.close();
  }
}
function writeFile(info: TestInfo, name: string, text: string | Buffer): string {
  const file = info.outputPath(name);
  fs.writeFileSync(file, text);
  return file;
}
const uid = (info: TestInfo) => `e2e-${info.testId}-${Date.now()}`;

/** Raw request with hand-set headers (browsers and Playwright derive Host and Origin themselves). */
function raw(baseURL: string, opts: { path?: string; headers: Record<string, string>; body?: Buffer; chunked?: boolean }): Promise<{ status: number; body: string }> {
  const url = new URL(baseURL);
  return new Promise((resolve, reject) => {
    const req = http.request(
      // agent: false → one connection per request. A request that declares a body it
      // never sends must not leave a half-read keep-alive socket for the next one.
      { host: url.hostname, port: url.port, path: opts.path ?? "/api/import", method: "POST", headers: opts.headers, setHost: false, agent: false },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
function goodHeaders(baseURL: string, body: Buffer): Record<string, string> {
  const u = new URL(baseURL);
  return { host: u.host, origin: u.origin, "x-threadatlas-import": "1", "content-type": "application/json", "content-length": String(body.length) };
}

test.describe("import page", () => {
  test("imports a synthetic export: pending state, summary with focus, last-import panel", async ({ page, baseURL }, info) => {
    const guards = attachPrivacyGuards(page, baseURL);
    const prefix = uid(info);
    const file = writeFile(info, "conversations.json", exportText(syntheticExport(3, { idPrefix: prefix })));
    // Hold the request briefly so the pending state can be observed.
    await page.route("**/api/import", async (route) => {
      await new Promise((r) => setTimeout(r, 1_000));
      await route.continue();
    });
    await page.goto("/import");
    await expect(page.getByRole("heading", { level: 1, name: "Import" })).toBeVisible();
    await page.getByLabel("ChatGPT export file").setInputFiles(file);
    await page.getByRole("button", { name: "Import" }).click();

    // Scoped to the import form: the Import page also has the semantic index panel's status (M5.1b-2).
    await expect(page.getByRole("region", { name: "Import a file" }).getByRole("status")).toHaveText(PENDING);
    await expect(page.getByRole("button", { name: "Importing…" })).toBeDisabled();

    const heading = page.getByRole("heading", { name: "Import summary" });
    await expect(heading).toBeFocused();
    const result = page.getByRole("region", { name: "Import summary" });
    await expect(result.getByText("Import complete.")).toBeVisible();
    const table = result.getByRole("table");
    await expect(table.getByRole("row", { name: /^Added 3$/ })).toBeVisible();
    await expect(table.getByText("3 conversations in the file")).toBeVisible();
    await expect(page.getByTestId("last-import")).toContainText("3 conversations: 3 added");
    expect(conversationExists(`${prefix}-0`)).toBe(true);
    // M1.6: the summary links to the conversation list.
    await result.getByRole("link", { name: "View conversations" }).click();
    await expect(page).toHaveURL("/conversations");
    await expect(page.getByRole("heading", { level: 1, name: "Conversations" })).toBeVisible();
    await guards.assertClean();
  });

  test("re-importing the same file changes nothing", async ({ page, baseURL }, info) => {
    const guards = attachPrivacyGuards(page, baseURL);
    const file = writeFile(info, "conversations.json", exportText(syntheticExport(2, { idPrefix: uid(info) })));
    await page.goto("/import");
    for (const expected of [/^Added 2$/, /^Unchanged 2$/]) {
      await page.getByLabel("ChatGPT export file").setInputFiles(file);
      await page.getByRole("button", { name: "Import" }).click();
      await expect(page.getByRole("region", { name: "Import summary" }).getByRole("row", { name: expected })).toBeVisible();
    }
    await guards.assertClean();
  });

  test("shows warnings and plain-text details, never markup from the file", async ({ page, baseURL }, info) => {
    const guards = attachPrivacyGuards(page, baseURL);
    const id = `${uid(info)}-<img src=x onerror=alert(1)>`;
    // current_node outside the mapping → a warning whose sample shows the (markup-like) ID.
    const file = writeFile(info, "conversations.json", exportText([syntheticConversation({ id, extra: { current_node: "missing-node" } }), 42]));
    await page.goto("/import");
    await page.getByLabel("ChatGPT export file").setInputFiles(file);
    await page.getByRole("button", { name: "Import" }).click();
    // Scoped to the result: the Last import panel repeats the status sentence once refreshed.
    const result = page.getByRole("region", { name: "Import summary" });
    await expect(result.getByText("Import complete, with warnings or notes.")).toBeVisible();
    await expect(result.getByRole("row", { name: /^Skipped 1$/ })).toBeVisible();
    await expect(result.getByRole("heading", { name: "Warnings and notes" })).toBeVisible();
    await result.getByText(/^Details \(/).click();
    await expect(result.getByText(/CONVERSATION_NOT_OBJECT · entry 2/)).toBeVisible();
    await expect(result.getByText(`CURRENT_NODE_NOT_IN_MAPPING · entry 1 · conversation ID ${id}`)).toBeVisible();
    await expect(page.locator("main img")).toHaveCount(0);
    await guards.assertClean();
  });

  test("an invalid file shows an accessible error and writes nothing", async ({ page, baseURL }, info) => {
    const guards = attachPrivacyGuards(page, baseURL, { allowConsoleErrors: EXPECTED_4XX });
    const file = writeFile(info, "broken.json", `[{"conversation_id": "${uid(info)}"`);
    await page.goto("/import");
    await page.getByLabel("ChatGPT export file").setInputFiles(file);
    await page.getByRole("button", { name: "Import" }).click();
    const alert = page.locator("main").getByRole("alert");
    await expect(alert).toHaveText("The file is not valid JSON.");
    await expect(alert).toBeFocused();
    await guards.assertClean();
  });

  test("an oversized file is refused in the browser without being sent", async ({ page, baseURL }, info) => {
    const guards = attachPrivacyGuards(page, baseURL);
    const file = info.outputPath("huge.json");
    fs.writeFileSync(file, "");
    fs.truncateSync(file, 52_428_801); // sparse: no 50 MiB write
    const sent: string[] = [];
    page.on("request", (r) => r.url().includes("/api/import") && sent.push(r.method()));
    await page.goto("/import");
    await page.getByLabel("ChatGPT export file").setInputFiles(file);
    await page.getByRole("button", { name: "Import" }).click();
    await expect(page.locator("main").getByRole("alert")).toHaveText("The file is larger than the allowed upload size.");
    expect(sent).toEqual([]);
    await guards.assertClean();
  });

  test("an unfinished batch shows durable accounting, and the next import marks it interrupted", async ({ page, baseURL }, info) => {
    const guards = attachPrivacyGuards(page, baseURL);
    const stale = `e2e-stale-${Date.now()}`;
    const w = db(false);
    try {
      w.prepare(`INSERT INTO "ImportBatch" ("id","startedAt","status","adapter","adapterVersion","sourceFilename","sourceSha256","sourceBytes","conversationsSeen","conversationsAdded") VALUES (?, ?, 'running', 'chatgpt', '0.3.0', 'synthetic.json', ?, 1, 10, 4)`)
        .run(stale, new Date(Date.now() + 60_000).toISOString().replace("Z", "+00:00"), "0".repeat(64));
    } finally {
      w.close();
    }
    await page.goto("/import");
    const panel = page.getByTestId("last-import");
    await expect(panel).toContainText("This import has not finished.");
    await expect(panel).toContainText("Accounted for 4 of 10; 6 not accounted for.");
    await expect(panel).not.toContainText("conversations: ");

    const file = writeFile(info, "conversations.json", exportText(syntheticExport(1, { idPrefix: uid(info) })));
    await page.getByLabel("ChatGPT export file").setInputFiles(file);
    await page.getByRole("button", { name: "Import" }).click();
    await expect(page.getByRole("heading", { name: "Import summary" })).toBeFocused();
    const r = db();
    try {
      const row = r.prepare('SELECT status, errorCode FROM "ImportBatch" WHERE id = ?').get(stale);
      expect(row).toEqual({ status: "interrupted", errorCode: "IMPORT_INTERRUPTED" });
    } finally {
      r.close();
    }
    // The stale batch is still the newest by start time: the panel now shows it as interrupted.
    await expect(panel).toContainText("The import was interrupted before it finished.");
    await expect(panel).toContainText("Accounted for 4 of 10; 6 not accounted for.");
    await guards.assertClean();
  });
});

test.describe("import route (raw requests)", () => {
  test("imports a 12 MiB upload completely (no proxy truncation, A14)", async ({ baseURL }, info) => {
    const prefix = uid(info);
    const convs = syntheticExport(400, { idPrefix: prefix, messages: 25, textLength: 1_100 });
    const body = Buffer.from(exportText(convs));
    expect(body.length).toBeGreaterThan(12 * 2 ** 20);
    const r = await raw(baseURL!, { headers: goodHeaders(baseURL!, body), body });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ ok: true, batch: { status: "succeeded", complete: true, seen: 400, counts: { added: 400 } } });
    expect(conversationExists(`${prefix}-399`)).toBe(true);
  });

  test("the route enforces Host, Origin and CSRF checks itself", async ({ baseURL }, info) => {
    const id = uid(info);
    const body = Buffer.from(exportText([syntheticConversation({ id })]));
    const g = goodHeaders(baseURL!, body);
    const port = new URL(baseURL!).port;
    const cases: [string, Record<string, string>, number][] = [
      ["forged Host", { ...g, host: `rebind.example:${port}`, origin: `http://rebind.example:${port}` }, 403],
      ["foreign Origin", { ...g, origin: "http://evil.example" }, 403],
      ["other local origin", { ...g, origin: `http://localhost:${port}` }, 403],
      ["no Origin", Object.fromEntries(Object.entries(g).filter(([k]) => k !== "origin")), 403],
      ["cross-site fetch metadata", { ...g, "sec-fetch-site": "cross-site" }, 403],
      ["no custom header", Object.fromEntries(Object.entries(g).filter(([k]) => k !== "x-threadatlas-import")), 403],
      ["text/plain", { ...g, "content-type": "text/plain" }, 415],
      ["declared size over the limit", { ...g, "content-length": "52428801" }, 413],
    ];
    for (const [label, headers, status] of cases) {
      const r = await raw(baseURL!, { headers, body: label.includes("over the limit") ? undefined : body });
      expect([label, r.status]).toEqual([label, status]);
      expect(r.body).not.toContain("rebind.example");
      expect(r.body).not.toContain("evil.example");
    }
    expect(conversationExists(id)).toBe(false);
  });

  test("a request without Content-Length is refused (411)", async ({ baseURL }) => {
    const u = new URL(baseURL!);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: u.hostname, port: u.port, path: "/api/import", method: "POST", agent: false, headers: { origin: u.origin, "x-threadatlas-import": "1", "content-type": "application/json", "transfer-encoding": "chunked" } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
      req.write("[");
      req.end("]");
    });
    expect(status).toBe(411);
  });

  test("proxy coverage: only the exact path skips the proxy", async ({ baseURL }) => {
    const port = new URL(baseURL!).port;
    const forged = { host: `rebind.example:${port}`, "content-type": "application/json", "content-length": "2" };
    const expected: [string, number][] = [
      ["/api/import", 403], // route's own check
      ["/api/import/", 308],
      ["//api/import", 308],
      ["/API/import", 403],
      ["/api/Import", 403],
      ["/api/%69mport", 403],
      ["/api/import.rsc", 403],
      ["/api/import;x", 403],
      ["/api/import/extra", 403],
      ["/api/importx", 403],
      ["/", 403],
    ];
    for (const [p, status] of expected) {
      const r = await raw(baseURL!, { path: p, headers: forged, body: Buffer.from("[]") });
      expect([p, r.status]).toEqual([p, status]);
    }
  });

  test("requests from another origin in the browser never import", async ({ page, baseURL }, info) => {
    const id = uid(info);
    const target = `${baseURL}/api/import`;
    const payload = JSON.stringify(exportText([syntheticConversation({ id })]));
    const attackerPage = `<!doctype html><meta charset=utf-8><body><iframe name=sink></iframe><form id=f method=POST enctype=text/plain target=sink action="${target}"><input name='[{"a' value='":1}]'></form><script>
      window.attack = async () => {
        const body = ${payload};
        const r = {};
        try { await fetch(${JSON.stringify(target)}, { method: 'POST', headers: { 'content-type': 'application/json', 'x-threadatlas-import': '1' }, body }); r.preflighted = 'resolved'; } catch (e) { r.preflighted = 'blocked'; }
        try { await fetch(${JSON.stringify(target)}, { method: 'POST', body }); r.simple = 'resolved'; } catch (e) { r.simple = 'blocked'; }
        try { await fetch(${JSON.stringify(target)}, { method: 'POST', mode: 'no-cors', body }); r.nocors = 'sent'; } catch (e) { r.nocors = 'blocked'; }
        r.beacon = navigator.sendBeacon(${JSON.stringify(target)}, new Blob([body], { type: 'text/plain' }));
        document.getElementById('f').submit();
        await new Promise((ok) => setTimeout(ok, 1500));
        return r;
      };
    </script>`;
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(attackerPage);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const { port } = server.address() as { port: number };
      await page.goto(`http://localhost:${port}/`);
      const result = await page.evaluate(() => (window as unknown as { attack: () => Promise<Record<string, unknown>> }).attack());
      expect(result.preflighted).toBe("blocked");
      expect(conversationExists(id)).toBe(false);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
