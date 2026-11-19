import { request as httpRequest } from "node:http";
import { expect, test } from "@playwright/test";

/**
 * Sends raw HTTP requests with hand-set Host headers. Playwright's own request
 * client and browsers derive Host from the URL, so node:http is used here to
 * exercise the server-side check directly.
 */
function rawRequest(
  baseURL: string,
  opts: { path?: string; method?: string; headers: Record<string, string> },
): Promise<{ status: number; body: string }> {
  const url = new URL(baseURL);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path: opts.path ?? "/",
        method: opts.method ?? "GET",
        headers: opts.headers,
        setHost: false,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test.describe("Host-header validation (DNS rebinding defence)", () => {
  test("loopback hosts are served", async ({ baseURL }) => {
    const port = new URL(baseURL!).port;
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      const res = await rawRequest(baseURL!, { headers: { host } });
      expect(res.status, host).toBe(200);
      expect(res.body).toContain("ThreadAtlas");
    }
  });

  test("foreign hosts are rejected on pages", async ({ baseURL }) => {
    const port = new URL(baseURL!).port;
    for (const host of [
      `rebind.example:${port}`,
      "rebind.example",
      `localhost.rebind.example:${port}`,
      `0.0.0.0:${port}`,
    ]) {
      const res = await rawRequest(baseURL!, { headers: { host } });
      expect(res.status, host).toBe(403);
      expect(res.body).not.toContain("<html");
      expect(res.body).not.toContain(host); // rejected value is not echoed
    }
  });

  test("foreign hosts are rejected on every route type", async ({ baseURL }) => {
    const headers = { host: "rebind.example" };
    for (const path of ["/conversations", "/settings", "/does-not-exist"]) {
      const res = await rawRequest(baseURL!, { path, headers });
      expect(res.status, path).toBe(403);
    }
    // State-changing methods (where Server Functions and future routes live).
    const post = await rawRequest(baseURL!, {
      path: "/",
      method: "POST",
      headers: { ...headers, "content-length": "0" },
    });
    expect(post.status).toBe(403);
  });

  test("static assets are rejected for foreign hosts", async ({
    baseURL,
    page,
  }) => {
    await page.goto("/");
    const asset = await page
      .locator('script[src^="/_next/static/"]')
      .first()
      .getAttribute("src");
    expect(asset).toBeTruthy();

    const ok = await rawRequest(baseURL!, {
      path: asset!,
      headers: { host: new URL(baseURL!).host },
    });
    expect(ok.status).toBe(200);

    const blocked = await rawRequest(baseURL!, {
      path: asset!,
      headers: { host: "rebind.example" },
    });
    expect(blocked.status).toBe(403);
  });

  test("a foreign X-Forwarded-Host is rejected", async ({ baseURL }) => {
    const res = await rawRequest(baseURL!, {
      headers: {
        host: new URL(baseURL!).host,
        "x-forwarded-host": "rebind.example",
      },
    });
    expect(res.status).toBe(403);
  });
});
