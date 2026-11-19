import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_IMPORT_MAX_BYTES,
  getImportMaxBytes,
  parseJsonText,
  readUploadStream,
} from "./read-upload";

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]!);
      else controller.close();
    },
  });
}

/** An endless stream that counts how many chunks were pulled. */
function endlessStream(chunkSize: number) {
  const stats = { pulled: 0, cancelled: false };
  const chunk = new Uint8Array(chunkSize).fill(0x20);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      stats.pulled++;
      controller.enqueue(chunk);
    },
    cancel() {
      stats.cancelled = true;
    },
  });
  return { stream, stats };
}

const enc = new TextEncoder();

describe("getImportMaxBytes", () => {
  it("defaults to 50 MiB", () => {
    expect(DEFAULT_IMPORT_MAX_BYTES).toBe(50 * 1024 * 1024);
    expect(getImportMaxBytes({})).toBe(52_428_800);
    expect(getImportMaxBytes({ IMPORT_MAX_BYTES: "" })).toBe(52_428_800);
  });

  it("accepts a positive integer override", () => {
    expect(getImportMaxBytes({ IMPORT_MAX_BYTES: "1048576" })).toBe(1_048_576);
  });

  it.each(["abc", "0", "-1", "1.5", "1e6", "10MB"])(
    "rejects invalid value %j",
    (value) => {
      expect(() => getImportMaxBytes({ IMPORT_MAX_BYTES: value })).toThrow(
        /IMPORT_MAX_BYTES/,
      );
    },
  );
});

describe("readUploadStream", () => {
  it("returns the text of a small upload", async () => {
    const res = await readUploadStream(streamOf([enc.encode("[1]")]), { maxBytes: 10 });
    expect(res).toEqual({ ok: true, text: "[1]", sha256: createHash("sha256").update("[1]").digest("hex"), byteLength: 3 });
  });

  it("hashes the bytes as received, across chunks and including a BOM", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode('["é"]')]);
    const res = await readUploadStream(streamOf([bytes.slice(0, 2), bytes.slice(2, 5), bytes.slice(5)]), { maxBytes: 100 });
    expect(res).toMatchObject({ ok: true, sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength });
  });

  it("accepts exactly maxBytes and rejects one byte more", async () => {
    const atLimit = await readUploadStream(streamOf([enc.encode("12345")]), { maxBytes: 5 });
    expect(atLimit.ok).toBe(true);
    const over = await readUploadStream(streamOf([enc.encode("123456")]), { maxBytes: 5 });
    expect(over).toEqual({ ok: false, error: { code: "FILE_TOO_LARGE" } });
  });

  it("stops reading as soon as the limit is exceeded (no full buffering)", async () => {
    const chunkSize = 1024 * 1024; // 1 MiB
    const { stream, stats } = endlessStream(chunkSize);
    const res = await readUploadStream(stream, { maxBytes: 5 * chunkSize });
    expect(res).toEqual({ ok: false, error: { code: "FILE_TOO_LARGE" } });
    // 5 chunks fit, the 6th exceeds the limit. Allow one chunk of read-ahead.
    expect(stats.pulled).toBeLessThanOrEqual(7);
    expect(stats.cancelled).toBe(true);
  });

  it("rejects an oversized declared length without reading", async () => {
    const { stream, stats } = endlessStream(16);
    const res = await readUploadStream(stream, { maxBytes: 100, declaredLength: 101 });
    expect(res).toEqual({ ok: false, error: { code: "FILE_TOO_LARGE" } });
    expect(stats.pulled).toBeLessThanOrEqual(1); // at most the initial pull
    expect(stats.cancelled).toBe(true);
  });

  it("rejects a body shorter or longer than its declared length (truncation guard)", async () => {
    const short = await readUploadStream(streamOf([enc.encode("[1]")]), { maxBytes: 100, declaredLength: 10 });
    expect(short).toEqual({ ok: false, error: { code: "FILE_INCOMPLETE" } });
    const long = await readUploadStream(streamOf([enc.encode("[1,2,3]")]), { maxBytes: 100, declaredLength: 3 });
    expect(long).toEqual({ ok: false, error: { code: "FILE_INCOMPLETE" } });
    const exact = await readUploadStream(streamOf([enc.encode("[1,"), enc.encode("2]")]), { maxBytes: 100, declaredLength: 5 });
    expect(exact).toMatchObject({ ok: true, text: "[1,2]", byteLength: 5 });
    // A declared zero with no body is still "empty", not "incomplete".
    expect(await readUploadStream(streamOf([]), { maxBytes: 100, declaredLength: 0 })).toEqual({ ok: false, error: { code: "FILE_EMPTY" } });
  });

  it("does not trust an understated declared length", async () => {
    const { stream } = endlessStream(64);
    const res = await readUploadStream(stream, { maxBytes: 256, declaredLength: 10 });
    expect(res).toEqual({ ok: false, error: { code: "FILE_TOO_LARGE" } });
  });

  it("treats a missing or zero-byte body as empty", async () => {
    expect(await readUploadStream(null, { maxBytes: 10 })).toEqual({
      ok: false,
      error: { code: "FILE_EMPTY" },
    });
    expect(await readUploadStream(streamOf([]), { maxBytes: 10 })).toEqual({
      ok: false,
      error: { code: "FILE_EMPTY" },
    });
  });

  it("rejects invalid UTF-8", async () => {
    const res = await readUploadStream(streamOf([new Uint8Array([0x5b, 0xff, 0xfe, 0x5d])]), {
      maxBytes: 10,
    });
    expect(res).toEqual({ ok: false, error: { code: "FILE_NOT_UTF8" } });
  });

  it("decodes multi-byte characters split across chunks and strips a BOM", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode('["é🌵"]')]);
    const res = await readUploadStream(
      streamOf([bytes.slice(0, 4), bytes.slice(4, 7), bytes.slice(7)]),
      { maxBytes: 100 },
    );
    expect(res).toMatchObject({ ok: true, text: '["é🌵"]', byteLength: bytes.byteLength });
  });

  it("reports stream failures without details", async () => {
    const failing = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("synthetic canary failure detail");
      },
    });
    const res = await readUploadStream(failing, { maxBytes: 10 });
    expect(res).toEqual({ ok: false, error: { code: "FILE_READ_FAILED" } });
    expect(JSON.stringify(res)).not.toContain("canary");
  });
});

describe("parseJsonText", () => {
  it("parses JSON", () => {
    expect(parseJsonText("[1, 2]")).toEqual({ ok: true, data: [1, 2] });
  });

  it.each(["{", "[1,", "not json", "[\"canary\" 1]"])(
    "rejects invalid JSON %j without echoing it",
    (text) => {
      const res = parseJsonText(text);
      expect(res).toEqual({ ok: false, error: { code: "FILE_INVALID_JSON" } });
    },
  );

  it("treats whitespace-only text as empty", () => {
    expect(parseJsonText("  \n ")).toEqual({ ok: false, error: { code: "FILE_EMPTY" } });
  });

  it("parses 1,000,000 levels of nesting (V8's parser is iterative; F2)", () => {
    const n = 1_000_000;
    expect(parseJsonText("[".repeat(n) + "]".repeat(n)).ok).toBe(true);
  });

  it("reports FILE_TOO_DEEP, without the error's text, if the parser runs out of stack", () => {
    const spy = vi.spyOn(JSON, "parse").mockImplementation(() => {
      throw new RangeError("Maximum call stack size exceeded: canary");
    });
    try {
      expect(parseJsonText("[[[]]]")).toEqual({ ok: false, error: { code: "FILE_TOO_DEEP" } });
    } finally {
      spy.mockRestore();
    }
  });
});
