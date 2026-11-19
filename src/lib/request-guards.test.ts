import { describe, expect, it } from "vitest";
import { checkSameOriginRequest, checkServerActionRequest, expectedOrigin, IMPORT_REQUEST_HEADER } from "./request-guards";

const OPTS = { customHeader: IMPORT_REQUEST_HEADER, contentType: "application/json" };
const good: Record<string, string> = {
  host: "127.0.0.1:3000",
  origin: "http://127.0.0.1:3000",
  "sec-fetch-site": "same-origin",
  [IMPORT_REQUEST_HEADER]: "1",
  "content-type": "application/json",
};
const check = (over: Record<string, string | null>) => {
  const h = new Headers();
  for (const [k, v] of Object.entries({ ...good, ...over })) if (v !== null) h.set(k, v);
  return checkSameOriginRequest(h, OPTS);
};
const FORBIDDEN = { ok: false, status: 403, code: "REQUEST_FORBIDDEN" };

describe("checkSameOriginRequest", () => {
  it("accepts a same-origin request from the app's own page", () => {
    expect(check({})).toEqual({ ok: true });
    expect(check({ host: "localhost:3100", origin: "http://localhost:3100" })).toEqual({ ok: true });
    expect(check({ "content-type": "application/json; charset=utf-8" })).toEqual({ ok: true });
    expect(check({ "sec-fetch-site": null })).toEqual({ ok: true }); // older browsers omit it
    expect(check({ host: "LOCALHOST:3100", origin: "http://localhost:3100" })).toEqual({ ok: true });
  });

  it.each<[string, Record<string, string | null>]>([
    ["a forged Host (route excluded from the proxy)", { host: "rebind.example:3000", origin: "http://rebind.example:3000" }],
    ["a missing Host", { host: null }],
    ["a foreign X-Forwarded-Host", { "x-forwarded-host": "rebind.example" }],
    ["a missing Origin", { origin: null }],
    ["Origin \"null\"", { origin: "null" }],
    ["another port (same site, other origin)", { origin: "http://127.0.0.1:3001" }],
    ["the other loopback name", { origin: "http://localhost:3000" }],
    ["https", { origin: "https://127.0.0.1:3000" }],
    ["an Origin with a path", { origin: "http://127.0.0.1:3000/import" }],
    ["a foreign Origin", { origin: "http://evil.example" }],
    ["Sec-Fetch-Site same-site", { "sec-fetch-site": "same-site" }],
    ["Sec-Fetch-Site cross-site", { "sec-fetch-site": "cross-site" }],
    ["Sec-Fetch-Site none", { "sec-fetch-site": "none" }],
    ["no custom header (simple, no-cors, beacon, form requests)", { [IMPORT_REQUEST_HEADER]: null }],
    ["a wrong custom header value", { [IMPORT_REQUEST_HEADER]: "true" }],
  ])("rejects %s with 403", (_label, over) => {
    expect(check(over)).toEqual(FORBIDDEN);
  });

  it.each(["text/plain", "multipart/form-data; boundary=x", "", "application/jsonx", "application/json-seq"])(
    "rejects content type %j with 415",
    (type) => {
      expect(check({ "content-type": type })).toEqual({ ok: false, status: 415, code: "REQUEST_CONTENT_TYPE" });
    },
  );

  it("checks the origin before the content type (a cross-site form gets 403, not 415)", () => {
    expect(check({ origin: "http://evil.example", "content-type": "text/plain", [IMPORT_REQUEST_HEADER]: null })).toEqual(FORBIDDEN);
  });

  it("derives the expected origin from the validated Host", () => {
    expect(expectedOrigin("LocalHost:3100")).toBe("http://localhost:3100");
  });
});

describe("checkServerActionRequest (M1.7)", () => {
  // As sent by Chromium for a real same-origin Server Action (M1.7 step 0).
  const action: Record<string, string> = {
    host: "127.0.0.1:3100",
    origin: "http://127.0.0.1:3100",
    "sec-fetch-site": "same-origin",
    "next-action": "603050175a323a449b206d55ff6efb440cf68b642d",
    "content-type": "multipart/form-data; boundary=x",
  };
  const run = (over: Record<string, string | null>) => {
    const h = new Headers();
    for (const [k, v] of Object.entries({ ...action, ...over })) if (v !== null) h.set(k, v);
    return checkServerActionRequest(h);
  };

  it("accepts a same-origin Server Action request", () => {
    expect(run({})).toEqual({ ok: true });
    expect(run({ host: "localhost:3100", origin: "http://localhost:3100" })).toEqual({ ok: true });
    expect(run({ "sec-fetch-site": null })).toEqual({ ok: true });
  });

  it.each<[string, Record<string, string | null>]>([
    ["a missing Origin (Next.js itself allows it)", { origin: null }],
    ["a forged Origin", { origin: "http://evil.example" }],
    ["Origin \"null\"", { origin: "null" }],
    ["the other loopback name", { origin: "http://localhost:3100" }],
    ["another port", { origin: "http://127.0.0.1:3101" }],
    ["Sec-Fetch-Site cross-site with a correct Origin (Next.js itself allows it)", { "sec-fetch-site": "cross-site" }],
    ["Sec-Fetch-Site same-site", { "sec-fetch-site": "same-site" }],
    ["a forged Host", { host: "rebind.example:3100", origin: "http://rebind.example:3100" }],
    ["a missing Host", { host: null }],
    ["a foreign X-Forwarded-Host", { "x-forwarded-host": "evil.example" }],
    ["no Next-Action header (the no-JavaScript form path)", { "next-action": null }],
    ["an empty Next-Action header", { "next-action": " " }],
  ])("rejects %s", (_label, over) => {
    expect(run(over)).toEqual({ ok: false, code: "REQUEST_FORBIDDEN" });
  });

  it("never relies on Next-Action alone", () => {
    expect(run({ origin: null, "next-action": "anything" })).toEqual({ ok: false, code: "REQUEST_FORBIDDEN" });
  });
});
