import fs from "node:fs";
import path from "node:path";
import util from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureText } from "../../../tests/helpers/fixtures";
import { exportText, syntheticConversation, syntheticExport } from "../../../tests/helpers/synthetic-export";
import { createTestDb, type TestDb } from "../../../tests/helpers/test-db";
import { createWriterClient, type DbClient } from "../db/client";
import { toDatabaseUrl } from "../db/path";
import { acquireWriteLock } from "../db/write-lock";
import { IMPORT_REQUEST_HEADER } from "../request-guards";
import { handleImportRequest, IMPORT_FILENAME_HEADER, statusForCode, type ImportHttpDeps } from "./http";
import type { ImportResponseBody } from "./summary";

const ORIGIN = "http://127.0.0.1:3000";
const enc = new TextEncoder();

function request(body: string | Uint8Array | null, over: Record<string, string | null> = {}): Request {
  const bytes = typeof body === "string" ? enc.encode(body) : body;
  const headers: Record<string, string> = {
    host: "127.0.0.1:3000",
    origin: ORIGIN,
    "sec-fetch-site": "same-origin",
    [IMPORT_REQUEST_HEADER]: "1",
    "content-type": "application/json",
    [IMPORT_FILENAME_HEADER]: encodeURIComponent("conversations.json"),
    ...(bytes ? { "content-length": String(bytes.byteLength) } : {}),
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === null) delete headers[k];
    else headers[k] = v;
  }
  return new Request(`${ORIGIN}/api/import`, {
    method: "POST",
    headers,
    body: bytes ? new ReadableStream({ start: (c) => (c.enqueue(bytes), c.close()) }) : null,
    duplex: "half",
  } as RequestInit);
}

let t: TestDb;
let deps: ImportHttpDeps;
beforeEach(() => {
  t = createTestDb();
  deps = { importDeps: { writer: t.writer }, readDb: () => t.db, env: {} };
});
afterEach(async () => {
  await t.cleanup();
});

async function send(req: Request, d: ImportHttpDeps = deps) {
  const res = await handleImportRequest(req, d);
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, body: JSON.parse(text) as ImportResponseBody };
}

describe("POST /api/import handler", () => {
  it("imports a valid fixture and returns the stored summary", async () => {
    const r = await send(request(fixtureText("branching.json")));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
    if (!r.body.ok) throw new Error("expected ok");
    expect(r.body.batch).toMatchObject({ complete: true, accountingText: null, counts: { added: 1 }, reportAvailable: true });
    expect(await t.db.conversation.count()).toBe(1);
    // Re-import: unchanged.
    const again = await send(request(fixtureText("branching.json")));
    expect(again.body).toMatchObject({ ok: true, batch: { status: "succeeded", counts: { unchanged: 1, added: 0 } } });
  });

  it("stores the decoded, sanitised file name, and never returns it", async () => {
    const r = await send(request(exportText(syntheticExport(1)), { [IMPORT_FILENAME_HEADER]: encodeURIComponent("../Exports/my chats é.json") }));
    expect(r.text).not.toContain("my chats");
    expect((await t.db.importBatch.findFirstOrThrow()).sourceFilename).toBe("my chats é.json");
    // Malformed or oversized name headers fall back to a neutral name.
    await send(request(exportText(syntheticExport(1, { idPrefix: "x" })), { [IMPORT_FILENAME_HEADER]: "%E0%A4%A" }));
    await send(request(exportText(syntheticExport(1, { idPrefix: "y" })), { [IMPORT_FILENAME_HEADER]: "a".repeat(5_000) }));
    const names = (await t.db.importBatch.findMany({ orderBy: { startedAt: "asc" } })).map((b) => b.sourceFilename);
    expect(names.slice(1)).toEqual(["upload.json", "upload.json"]);
  });

  it.each<[string, Record<string, string | null>]>([
    ["a forged Host", { host: "rebind.example:3000", origin: "http://rebind.example:3000" }],
    ["a foreign Origin", { origin: "http://evil.example" }],
    ["another local port", { origin: "http://127.0.0.1:3001" }],
    ["a missing Origin", { origin: null }],
    ["cross-site Sec-Fetch-Site", { "sec-fetch-site": "cross-site" }],
    ["a missing custom header", { [IMPORT_REQUEST_HEADER]: null }],
  ])("403 for %s, nothing written, body not read", async (_l, over) => {
    let pulled = 0;
    const req = request(null, over);
    const r = await handleImportRequest(
      new Request(req.url, { method: "POST", headers: { ...Object.fromEntries(req.headers), "content-length": "2" }, body: new ReadableStream({ pull: (c) => (pulled++, c.enqueue(enc.encode("[]")), c.close()) }, { highWaterMark: 0 }), duplex: "half" } as RequestInit),
      deps,
    );
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ ok: false, code: "REQUEST_FORBIDDEN" });
    expect(pulled).toBe(0);
    expect(await t.db.importBatch.count()).toBe(0);
  });

  it("415 for a non-JSON content type (CSRF hardening, not validation)", async () => {
    const r = await send(request("[]", { "content-type": "text/plain" }));
    expect(r).toMatchObject({ status: 415, body: { ok: false, code: "REQUEST_CONTENT_TYPE" } });
  });

  it("411 without a Content-Length", async () => {
    const r = await send(request("[]", { "content-length": null }));
    expect(r).toMatchObject({ status: 411, body: { code: "REQUEST_LENGTH_REQUIRED" } });
    expect((await send(request("[]", { "content-length": "-1" }))).status).toBe(411);
    expect((await send(request("[]", { "content-length": "1e3" }))).status).toBe(411);
  });

  it("413 for a declared size over the limit, before reading", async () => {
    const r = await send(request("[]", { "content-length": "52428801" }));
    expect(r).toMatchObject({ status: 413, body: { code: "FILE_TOO_LARGE" } });
    const small = await send(request("[1,2,3,4,5,6,7,8]"), { ...deps, env: { IMPORT_MAX_BYTES: "10" } });
    expect(small).toMatchObject({ status: 413, body: { code: "FILE_TOO_LARGE" } });
    expect(await t.db.importBatch.count()).toBe(0);
  });

  it("400 FILE_INCOMPLETE when fewer bytes arrive than declared (truncation guard)", async () => {
    const text = exportText(syntheticExport(2));
    const r = await send(request(text.slice(0, 100), { "content-length": String(Buffer.byteLength(text)) }));
    expect(r).toMatchObject({ status: 400, body: { code: "FILE_INCOMPLETE" } });
    expect(await t.db.importBatch.count()).toBe(0);
  });

  it.each([
    ["invalid JSON", "{not json", "FILE_INVALID_JSON"],
    ["unsupported structure", '{"a":1}', "FILE_UNSUPPORTED_STRUCTURE"],
    ["empty export", "[]", "FILE_NO_CONVERSATIONS"],
    ["not UTF-8", new Uint8Array([0x5b, 0xff, 0x5d]), "FILE_NOT_UTF8"],
  ] as const)("400 for %s, with a static message", async (_l, body, code) => {
    const r = await send(request(body as string | Uint8Array));
    expect(r).toMatchObject({ status: 400, body: { ok: false, code } });
    if (!r.body.ok) expect(r.body.message.length).toBeGreaterThan(10);
    expect(await t.db.importBatch.count()).toBe(0);
  });

  it("409 IMPORT_BUSY while another import holds the lock", async () => {
    const held = await acquireWriteLock(t.file);
    if (!held.ok) throw new Error("lock");
    try {
      expect(await send(request(exportText(syntheticExport(1))))).toMatchObject({ status: 409, body: { code: "IMPORT_BUSY" } });
    } finally {
      held.lock.release();
    }
  });

  it("503 when the database is not initialised; 500 for a misconfigured limit", async () => {
    const missing = path.join(path.dirname(t.file), "missing-dir-db.db");
    const writer = createWriterClient({ env: { THREADATLAS_TEST: "1", DATABASE_URL: toDatabaseUrl(missing) } });
    try {
      const r = await send(request(exportText(syntheticExport(1))), { ...deps, importDeps: { writer } });
      expect(r).toMatchObject({ status: 503, body: { code: "DB_NOT_INITIALIZED" } });
      expect(fs.existsSync(missing)).toBe(false);
    } finally {
      await writer.db.$disconnect();
      fs.rmSync(`${missing}.lock`, { force: true });
    }
    expect(await send(request("[]"), { ...deps, env: { IMPORT_MAX_BYTES: "lots" } })).toMatchObject({ status: 500, body: { code: "IMPORT_CONFIG_INVALID" } });
  });

  it("200 for a failed batch, showing durable accounting rather than completion", async () => {
    const r = await send(request(exportText(syntheticExport(4))), {
      ...deps,
      importDeps: {
        writer: t.writer,
        hooks: {
          afterConversation: async (i) => { if (i === 0) await t.db.$executeRawUnsafe("PRAGMA query_only = ON"); },
          beforeFinalize: async () => void (await t.db.$executeRawUnsafe("PRAGMA query_only = OFF")),
        },
      },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, batch: { status: "failed", complete: false, errorCode: "DB_READ_ONLY", accounted: 1, notAccounted: 3, accountingText: "Accounted for 1 of 4; 3 not accounted for." } });
  });

  it("returns a sanitised error, never a constructed summary, if the stored row can't be read", async () => {
    const r = await send(request(exportText(syntheticExport(2))), { ...deps, readDb: () => { throw new Error("synthetic"); } });
    expect(r).toMatchObject({ status: 503, body: { ok: false, code: "IMPORT_SUMMARY_UNAVAILABLE" } });
    expect(r.text).not.toContain("counts");
    // The import itself was committed and is visible to a later read.
    expect(await t.db.importBatch.findFirstOrThrow()).toMatchObject({ status: "succeeded", conversationsAdded: 2 });
    const gone = await send(request(exportText(syntheticExport(1, { idPrefix: "z" }))), { ...deps, readDb: () => ({ importBatch: { findUnique: async () => null } }) as unknown as DbClient });
    expect(gone).toMatchObject({ status: 503, body: { code: "IMPORT_SUMMARY_UNAVAILABLE" } });
  });

  it("maps no-batch codes to statuses", () => {
    expect(["FILE_TOO_LARGE", "FILE_INVALID_JSON", "IMPORT_BUSY", "IMPORT_LOCK_FAILED", "DB_BUSY", "IMPORT_PARSER_VERSION_INVALID", "IMPORT_INTERNAL_ERROR"].map(statusForCode)).toEqual([413, 400, 409, 503, 503, 500, 500]);
  });
});

describe("privacy: nothing from the upload or raw errors leaves the handler", () => {
  const CANARY = "synthetic-http-canary-61f0";

  it("no content, file name or raw error in responses or console output", async () => {
    const out: string[] = [];
    const spies = [
      ...(["log", "info", "warn", "error", "debug", "trace"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a) => void out.push(util.format(...a)))),
      vi.spyOn(process.stdout, "write").mockImplementation((c) => (out.push(String(c)), true)),
      vi.spyOn(process.stderr, "write").mockImplementation((c) => (out.push(String(c)), true)),
    ];
    const bodies: string[] = [];
    try {
      const file = exportText([syntheticConversation({ id: "p1", tag: CANARY }), 7]);
      const named = { [IMPORT_FILENAME_HEADER]: encodeURIComponent(`${CANARY}.json`) };
      bodies.push((await send(request(file, named))).text);
      bodies.push((await send(request(`{"${CANARY}":`, named))).text); // invalid JSON quoting the canary
      // A hook failing with the canary in its message → internal error, nothing echoed.
      bodies.push((await send(request(exportText([syntheticConversation({ id: "p2", tag: CANARY })]), named), { ...deps, importDeps: { writer: t.writer, hooks: { afterBatchCreated: () => { throw new Error(CANARY); } } } })).text);
      // Reader failing with the canary.
      bodies.push((await send(request(exportText([syntheticConversation({ id: "p3", tag: CANARY })]), named), { ...deps, readDb: (): DbClient => { throw new Error(CANARY); } })).text);
    } finally {
      for (const s of spies) s.mockRestore();
    }
    expect(bodies).toHaveLength(4);
    for (const b of bodies) expect(b).not.toContain(CANARY);
    expect(JSON.parse(bodies[2]!)).toMatchObject({ ok: false, code: "IMPORT_INTERNAL_ERROR" });
    expect(out).toEqual([]);
  });
});
