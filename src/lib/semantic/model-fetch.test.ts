import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EmbeddingError } from "./errors";
import { provisionModel } from "./model-fetch";
import type { ModelManifest } from "./model-manifest";

// A loopback server stands in for the hub; every file is synthetic.
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const CONTENT: Record<string, Buffer> = {
  "config.json": Buffer.from('{"synthetic":true}'),
  "onnx/model.bin": Buffer.alloc(200_000, 7),
};
const manifest: ModelManifest = {
  id: "test/model",
  revision: "a".repeat(40),
  license: "MIT",
  files: Object.entries(CONTENT).map(([p, b]) => ({ path: p, size: b.length, sha256: sha(b) })),
};

type Behaviour = "ok" | "wrong-content" | "too-long-chunked" | "bad-length" | "404" | "redirect";
let behaviour: Behaviour = "ok";
const requests: { url: string; headers: http.IncomingHttpHeaders }[] = [];
let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push({ url: req.url ?? "", headers: req.headers });
    const prefix = `/${manifest.id}/resolve/${manifest.revision}/`;
    const url = req.url ?? "";
    if (url.startsWith("/cdn/")) {
      const b = CONTENT[url.slice("/cdn/".length)];
      res.writeHead(200, { "content-length": String(b!.length) });
      return res.end(b);
    }
    const file = url.startsWith(prefix) ? CONTENT[url.slice(prefix.length)] : undefined;
    if (!file || behaviour === "404") {
      res.writeHead(404);
      return res.end();
    }
    if (behaviour === "redirect") {
      res.writeHead(302, { location: `/cdn/${url.slice(prefix.length)}` });
      return res.end();
    }
    if (behaviour === "wrong-content") {
      res.writeHead(200, { "content-length": String(file.length) });
      return res.end(Buffer.alloc(file.length, 1));
    }
    if (behaviour === "bad-length") {
      res.writeHead(200, { "content-length": String(file.length + 1) });
      return res.end(Buffer.concat([file, Buffer.from("x")]));
    }
    if (behaviour === "too-long-chunked") {
      res.writeHead(200); // no content-length: chunked
      res.write(file);
      return res.end(Buffer.alloc(10, 0));
    }
    res.writeHead(200, { "content-length": String(file.length) });
    res.end(file);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

let dest: string;
beforeEach(() => {
  behaviour = "ok";
  requests.length = 0;
  dest = fs.mkdtempSync(path.join(os.tmpdir(), "ta-model-fetch-"));
});
afterEach(() => fs.rmSync(dest, { recursive: true, force: true }));

const leftovers = () => fs.readdirSync(dest, { recursive: true }).map(String).filter((f) => f.includes(".partial-"));

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (err) {
    expect(err).toBeInstanceOf(EmbeddingError);
    expect((err as Error).message).not.toContain(dest);
    expect((err as Error).message).not.toContain("127.0.0.1");
    return (err as EmbeddingError).code;
  }
}

describe("provisionModel from the hub", () => {
  it("downloads the pinned revision, verifies and installs every file", async () => {
    const r = await provisionModel({ manifest, dest, source: { kind: "hub", baseUrl: base } });
    expect(r).toEqual([
      { path: "config.json", status: "downloaded" },
      { path: "onnx/model.bin", status: "downloaded" },
    ]);
    for (const [p, b] of Object.entries(CONTENT)) expect(fs.readFileSync(path.join(dest, p)).equals(b)).toBe(true);
    expect(requests.map((q) => q.url)).toEqual([
      `/test/model/resolve/${"a".repeat(40)}/config.json`,
      `/test/model/resolve/${"a".repeat(40)}/onnx/model.bin`,
    ]);
    for (const q of requests) {
      expect(q.headers.cookie).toBeUndefined();
      expect(q.headers.authorization).toBeUndefined();
    }
    expect(leftovers()).toEqual([]);
  });

  it("skips files that are already present and valid, without any request", async () => {
    await provisionModel({ manifest, dest, source: { kind: "hub", baseUrl: base } });
    requests.length = 0;
    const r = await provisionModel({ manifest, dest, source: { kind: "hub", baseUrl: base } });
    expect(r.map((x) => x.status)).toEqual(["present", "present"]);
    expect(requests).toEqual([]);
  });

  it("replaces a corrupt existing file", async () => {
    await provisionModel({ manifest, dest, source: { kind: "hub", baseUrl: base } });
    fs.writeFileSync(path.join(dest, "config.json"), '{"synthetic":fals}');
    const r = await provisionModel({ manifest, dest, source: { kind: "hub", baseUrl: base } });
    expect(r.map((x) => x.status)).toEqual(["downloaded", "present"]);
    expect(fs.readFileSync(path.join(dest, "config.json")).equals(CONTENT["config.json"]!)).toBe(true);
  });

  it("follows redirects", async () => {
    behaviour = "redirect";
    const r = await provisionModel({ manifest, dest, source: { kind: "hub", baseUrl: base } });
    expect(r.map((x) => x.status)).toEqual(["downloaded", "downloaded"]);
  });

  it.each([
    ["wrong-content", "FETCH_VERIFY_FAILED"],
    ["bad-length", "FETCH_VERIFY_FAILED"],
    ["too-long-chunked", "FETCH_VERIFY_FAILED"],
    ["404", "FETCH_FAILED"],
  ] as const)("on %s fails with %s and leaves no file behind", async (b, code) => {
    behaviour = b;
    expect(await codeOf(provisionModel({ manifest, dest, source: { kind: "hub", baseUrl: base } }))).toBe(code);
    expect(fs.existsSync(path.join(dest, "config.json"))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it("refuses plain http except on loopback, before any request", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    expect(await codeOf(provisionModel({ manifest, dest, source: { kind: "hub", baseUrl: "http://example.invalid" }, fetchImpl }))).toBe(
      "FETCH_FAILED",
    );
    expect(called).toBe(false);
  });

  it("refuses a redirect from https to http", async () => {
    const fetchImpl = (async () => {
      const r = new Response("x", { status: 200 });
      Object.defineProperty(r, "url", { value: "http://downgraded.invalid/file" });
      return r;
    }) as unknown as typeof fetch;
    expect(await codeOf(provisionModel({ manifest, dest, source: { kind: "hub", baseUrl: "https://hub.invalid" }, fetchImpl }))).toBe(
      "FETCH_FAILED",
    );
    expect(leftovers()).toEqual([]);
  });
});

describe("provisionModel from a local directory", () => {
  it("copies and verifies without using the network", async () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "ta-model-src-"));
    try {
      for (const [p, b] of Object.entries(CONTENT)) {
        fs.mkdirSync(path.dirname(path.join(src, p)), { recursive: true });
        fs.writeFileSync(path.join(src, p), b);
      }
      const r = await provisionModel({ manifest, dest, source: { kind: "local", dir: src } });
      expect(r.map((x) => x.status)).toEqual(["copied", "copied"]);
      expect(requests).toEqual([]);

      fs.rmSync(path.join(dest, "onnx"), { recursive: true });
      fs.writeFileSync(path.join(src, "onnx/model.bin"), Buffer.alloc(200_000, 8)); // tampered source
      expect(await codeOf(provisionModel({ manifest, dest, source: { kind: "local", dir: src } }))).toBe("FETCH_VERIFY_FAILED");
      expect(fs.existsSync(path.join(dest, "onnx/model.bin"))).toBe(false);
      expect(leftovers()).toEqual([]);
    } finally {
      fs.rmSync(src, { recursive: true, force: true });
    }
  });

  it("fails cleanly when the source is missing", async () => {
    expect(await codeOf(provisionModel({ manifest, dest, source: { kind: "local", dir: path.join(dest, "none") } }))).toBe(
      "FETCH_FAILED",
    );
  });
});
