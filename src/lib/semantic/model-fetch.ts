/**
 * Model provisioning for `npm run model:fetch`: the only step that may use the
 * network, and only when the user runs it (ADR 0002 decision 8). The app itself never
 * downloads.
 *
 * Each manifest file is:
 * 1. kept if already present with the approved size and SHA-256;
 * 2. otherwise streamed into a temporary file beside its destination, from the pinned
 *    hub revision or from a local directory (`--from`). The stream is aborted as soon
 *    as it exceeds the approved size;
 * 3. checked (size and SHA-256), flushed to disk and renamed into place. A file that
 *    fails any check is deleted and never used.
 *
 * Requests are plain GETs with no credentials, cookies or identifying headers.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EmbeddingError } from "./errors.ts";
import { checkModelFile, modelFilePath } from "./model-files.ts";
import type { ModelFile, ModelManifest } from "./model-manifest.ts";

export const DEFAULT_HUB_URL = "https://huggingface.co";

export type ModelSource = { readonly kind: "hub"; readonly baseUrl?: string } | { readonly kind: "local"; readonly dir: string };

export type ProvisionResult = { readonly path: string; readonly status: "present" | "downloaded" | "copied" };

export type ProvisionOptions = {
  readonly manifest: ModelManifest;
  readonly dest: string;
  readonly source: ModelSource;
  readonly fetchImpl?: typeof fetch;
  /** Abort a download that receives nothing for this long (default 60 s). */
  readonly idleTimeoutMs?: number;
  readonly onFile?: (file: ModelFile, phase: "checking" | "fetching" | "done", status?: ProvisionResult["status"]) => void;
};

function hubUrl(base: string, manifest: ModelManifest, file: ModelFile): URL {
  const u = new URL(`${manifest.id}/resolve/${manifest.revision}/${file.path}`, base.endsWith("/") ? base : `${base}/`);
  const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) throw new EmbeddingError("FETCH_FAILED");
  return u;
}

/** Streams `chunks` into `tmp`, enforcing the size limit and computing SHA-256. */
async function writeVerified(tmp: string, file: ModelFile, chunks: AsyncIterable<Uint8Array>): Promise<void> {
  const hash = createHash("sha256");
  let bytes = 0;
  const handle = await fs.promises.open(tmp, "wx", 0o644);
  try {
    for await (const chunk of chunks) {
      bytes += chunk.byteLength;
      if (bytes > file.size) throw new EmbeddingError("FETCH_VERIFY_FAILED");
      hash.update(chunk);
      await handle.write(chunk);
    }
    if (bytes !== file.size || hash.digest("hex") !== file.sha256) throw new EmbeddingError("FETCH_VERIFY_FAILED");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function* withIdleTimeout(body: AsyncIterable<Uint8Array>, controller: AbortController, ms: number): AsyncIterable<Uint8Array> {
  let timer = setTimeout(() => controller.abort(), ms);
  try {
    for await (const chunk of body) {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), ms);
      yield chunk;
    }
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOne(opts: ProvisionOptions, file: ModelFile, tmp: string): Promise<void> {
  const src = opts.source;
  if (src.kind === "local") {
    const from = modelFilePath(src.dir, file.path);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(from);
    } catch {
      throw new EmbeddingError("FETCH_FAILED");
    }
    if (!stat.isFile()) throw new EmbeddingError("FETCH_FAILED");
    await writeVerified(tmp, file, fs.createReadStream(from));
    return;
  }
  const url = hubUrl(src.baseUrl ?? DEFAULT_HUB_URL, opts.manifest, file);
  const controller = new AbortController();
  const idle = opts.idleTimeoutMs ?? 60_000;
  const connectTimer = setTimeout(() => controller.abort(), idle);
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(url, {
      method: "GET",
      redirect: "follow",
      credentials: "omit",
      signal: controller.signal,
    });
  } catch {
    throw new EmbeddingError("FETCH_FAILED");
  } finally {
    clearTimeout(connectTimer);
  }
  const finalUrl = res.url ? new URL(res.url) : url;
  if (!res.ok || !res.body || (url.protocol === "https:" && finalUrl.protocol !== "https:")) {
    await res.body?.cancel().catch(() => {});
    throw new EmbeddingError("FETCH_FAILED");
  }
  const declared = res.headers.get("content-length");
  if (declared !== null && Number(declared) !== file.size) {
    await res.body.cancel().catch(() => {});
    throw new EmbeddingError("FETCH_VERIFY_FAILED");
  }
  try {
    await writeVerified(tmp, file, withIdleTimeout(res.body as unknown as AsyncIterable<Uint8Array>, controller, idle));
  } catch (err) {
    controller.abort();
    if (err instanceof EmbeddingError) throw err;
    throw new EmbeddingError("FETCH_FAILED");
  }
}

/** Ensures every manifest file is present and verified in `dest`. Throws an `EmbeddingError`. */
export async function provisionModel(opts: ProvisionOptions): Promise<ProvisionResult[]> {
  const results: ProvisionResult[] = [];
  for (const file of opts.manifest.files) {
    opts.onFile?.(file, "checking");
    const target = modelFilePath(opts.dest, file.path);
    if ((await checkModelFile(opts.dest, file, { hash: true })) === "ok") {
      results.push({ path: file.path, status: "present" });
      opts.onFile?.(file, "done", "present");
      continue;
    }
    opts.onFile?.(file, "fetching");
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.partial-${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      await fetchOne(opts, file, tmp);
      await fs.promises.rename(tmp, target);
    } catch (err) {
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
      if (err instanceof EmbeddingError) throw err;
      throw new EmbeddingError("FETCH_FAILED");
    }
    const status = opts.source.kind === "local" ? "copied" : "downloaded";
    results.push({ path: file.path, status });
    opts.onFile?.(file, "done", status);
  }
  return results;
}
