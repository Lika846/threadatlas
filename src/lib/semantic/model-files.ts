/**
 * Locating and verifying the local model files. Models are only ever loaded from a
 * local directory whose files match the approved manifest; nothing here downloads.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EmbeddingError } from "./errors.ts";
import { DEFAULT_MODEL_DIR, type ModelFile, type ModelManifest } from "./model-manifest.ts";

type Env = Record<string, string | undefined>;

/**
 * The model directory: `THREADATLAS_MODEL_DIR` if set (must be absolute), otherwise
 * `<root>/data/models/multilingual-e5-small`.
 */
export function resolveModelDir(opts: { env: Env; root: string }): string {
  const configured = opts.env.THREADATLAS_MODEL_DIR?.trim();
  if (configured === undefined || configured === "") return path.resolve(opts.root, DEFAULT_MODEL_DIR);
  if (!path.isAbsolute(configured) || /[\u0000-\u001f]/.test(configured)) {
    throw new EmbeddingError("MODEL_DIR_INVALID");
  }
  return path.normalize(configured);
}

/** Absolute path of a model file inside `dir`, refusing anything that escapes it. */
export function modelFilePath(dir: string, relativePath: string): string {
  const full = path.resolve(dir, relativePath);
  const rel = path.relative(dir, full);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new EmbeddingError("MODEL_INVALID");
  return full;
}

export async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export type FileCheck = "ok" | "missing" | "invalid";

/** Checks one file: present as a regular file, with the approved size and (optionally) hash. */
export async function checkModelFile(dir: string, file: ModelFile, opts: { hash: boolean }): Promise<FileCheck> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(modelFilePath(dir, file.path));
  } catch (err) {
    if (err instanceof EmbeddingError) throw err;
    return "missing";
  }
  if (!stat.isFile() || stat.size !== file.size) return "invalid";
  if (!opts.hash) return "ok";
  return (await sha256OfFile(modelFilePath(dir, file.path))) === file.sha256 ? "ok" : "invalid";
}

/**
 * Verifies every manifest file. Throws `MODEL_MISSING` if any file is absent and
 * `MODEL_INVALID` if any has the wrong type, size or SHA-256. Sizes are checked for all
 * files before any hashing, so a missing or truncated file is reported quickly.
 */
export async function verifyModelDir(dir: string, manifest: ModelManifest, opts: { hash?: boolean } = {}): Promise<void> {
  const quick = await Promise.all(manifest.files.map((f) => checkModelFile(dir, f, { hash: false })));
  if (quick.includes("missing")) throw new EmbeddingError("MODEL_MISSING");
  if (quick.includes("invalid")) throw new EmbeddingError("MODEL_INVALID");
  if (opts.hash === false) return;
  for (const f of manifest.files) {
    if ((await checkModelFile(dir, f, { hash: true })) !== "ok") throw new EmbeddingError("MODEL_INVALID");
  }
}
