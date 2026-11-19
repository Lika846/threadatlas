import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmbeddingError } from "./errors";
import { modelFilePath, resolveModelDir, verifyModelDir } from "./model-files";
import { DEFAULT_MODEL_DIR, E5_SMALL_MANIFEST, type ModelManifest } from "./model-manifest";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const FILES = { "a.json": '{"a":1}', "sub/b.bin": "binary-ish synthetic content" };
const manifest: ModelManifest = {
  id: "test/model",
  revision: "0".repeat(40),
  license: "MIT",
  files: Object.entries(FILES).map(([p, c]) => ({ path: p, size: Buffer.byteLength(c), sha256: sha(c) })),
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-model-files-"));
  for (const [p, c] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), c);
  }
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (err) {
    expect(err).toBeInstanceOf(EmbeddingError);
    expect((err as Error).message).not.toContain(dir); // no paths in messages
    return (err as EmbeddingError).code;
  }
}

describe("verifyModelDir", () => {
  it("accepts files with the approved sizes and hashes", async () => {
    expect(await codeOf(verifyModelDir(dir, manifest))).toBe("ok");
  });

  it("reports a missing file as MODEL_MISSING", async () => {
    fs.rmSync(path.join(dir, "sub/b.bin"));
    expect(await codeOf(verifyModelDir(dir, manifest))).toBe("MODEL_MISSING");
    expect(await codeOf(verifyModelDir(path.join(dir, "nowhere"), manifest))).toBe("MODEL_MISSING");
  });

  it("reports a wrong size as MODEL_INVALID", async () => {
    fs.appendFileSync(path.join(dir, "a.json"), " ");
    expect(await codeOf(verifyModelDir(dir, manifest, { hash: false }))).toBe("MODEL_INVALID");
  });

  it("reports same-size different content as MODEL_INVALID only when hashing", async () => {
    fs.writeFileSync(path.join(dir, "a.json"), '{"a":2}');
    expect(await codeOf(verifyModelDir(dir, manifest, { hash: false }))).toBe("ok");
    expect(await codeOf(verifyModelDir(dir, manifest))).toBe("MODEL_INVALID");
  });

  it("rejects a directory in place of a file", async () => {
    fs.rmSync(path.join(dir, "a.json"));
    fs.mkdirSync(path.join(dir, "a.json"));
    expect(await codeOf(verifyModelDir(dir, manifest))).toBe("MODEL_INVALID");
  });

  it("refuses manifest paths that escape the model directory", () => {
    expect(() => modelFilePath(dir, "../outside.json")).toThrow(EmbeddingError);
    expect(() => modelFilePath(dir, "/etc/hosts")).toThrow(EmbeddingError);
    expect(modelFilePath(dir, "sub/b.bin")).toBe(path.join(dir, "sub", "b.bin"));
  });
});

describe("resolveModelDir", () => {
  it("defaults to data/models/multilingual-e5-small under the root", () => {
    expect(resolveModelDir({ env: {}, root: "/project" })).toBe(path.resolve("/project", DEFAULT_MODEL_DIR));
    expect(resolveModelDir({ env: { THREADATLAS_MODEL_DIR: "  " }, root: "/project" })).toBe(
      path.resolve("/project", DEFAULT_MODEL_DIR),
    );
  });

  it("accepts an absolute THREADATLAS_MODEL_DIR and rejects a relative one", () => {
    expect(resolveModelDir({ env: { THREADATLAS_MODEL_DIR: "/models/e5/" }, root: "/project" })).toBe("/models/e5/");
    expect(() => resolveModelDir({ env: { THREADATLAS_MODEL_DIR: "models/e5" }, root: "/p" })).toThrow(EmbeddingError);
  });
});

describe("approved manifest", () => {
  it("pins the four files of the reviewed revision", () => {
    expect(E5_SMALL_MANIFEST.revision).toBe("761b726dd34fb83930e26aab4e9ac3899aa1fa78");
    expect(E5_SMALL_MANIFEST.files.map((f) => f.path)).toEqual([
      "config.json",
      "tokenizer_config.json",
      "tokenizer.json",
      "onnx/model_quantized.onnx",
    ]);
    expect(E5_SMALL_MANIFEST.files.reduce((s, f) => s + f.size, 0)).toBe(135_392_016);
    for (const f of E5_SMALL_MANIFEST.files) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
