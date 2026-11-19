/**
 * `npm run model:fetch` — installs the approved semantic model (ADR 0002, D122).
 *
 *   npm run model:fetch                      download the pinned files from huggingface.co
 *   npm run model:fetch -- --from <dir>      copy them from a local directory instead (offline)
 *   npm run model:fetch -- --dest <dir>      install somewhere other than the model directory
 *
 * The destination defaults to `THREADATLAS_MODEL_DIR` (absolute) or
 * `data/models/multilingual-e5-small` (git-ignored). Every file is checked against the
 * checked-in manifest (size and SHA-256) before it is moved into place. This is the only
 * ThreadAtlas command that uses the network for the model, and only when run explicitly.
 *
 * Run by Node 24 directly (type stripping): relative `.ts` imports, erasable syntax only.
 */
import path from "node:path";
import { parseArgs } from "node:util";
import { EmbeddingError } from "../src/lib/semantic/errors.ts";
import { provisionModel, type ModelSource } from "../src/lib/semantic/model-fetch.ts";
import { resolveModelDir } from "../src/lib/semantic/model-files.ts";
import { E5_SMALL_MANIFEST } from "../src/lib/semantic/model-manifest.ts";

const root = path.resolve(import.meta.dirname, "..");
const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

function shown(p: string): string {
  const rel = path.relative(root, p);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : "the given directory";
}

async function main(): Promise<number> {
  let args;
  try {
    args = parseArgs({ options: { from: { type: "string" }, dest: { type: "string" }, help: { type: "boolean" } }, strict: true });
  } catch {
    console.error("Usage: npm run model:fetch [-- --from <dir>] [-- --dest <dir>]");
    return 2;
  }
  if (args.values.help) {
    console.log("Usage: npm run model:fetch [-- --from <dir>] [-- --dest <dir>]");
    return 0;
  }
  const dest = args.values.dest ? path.resolve(args.values.dest) : resolveModelDir({ env: process.env, root });
  const source: ModelSource = args.values.from ? { kind: "local", dir: path.resolve(args.values.from) } : { kind: "hub" };
  const m = E5_SMALL_MANIFEST;
  const total = m.files.reduce((s, f) => s + f.size, 0);
  console.log(`Model ${m.id} at revision ${m.revision} (${m.license}), ${m.files.length} files, ${mb(total)}.`);
  console.log(source.kind === "hub" ? "Source: huggingface.co (pinned revision)." : "Source: local directory (no network).");
  console.log(`Destination: ${shown(dest)}`);

  const results = await provisionModel({
    manifest: m,
    dest,
    source,
    onFile: (file, phase, status) => {
      if (phase === "fetching") console.log(`  ${file.path} (${mb(file.size)}): ${source.kind === "hub" ? "downloading" : "copying"}…`);
      if (phase === "done") console.log(`  ${file.path}: ${status === "present" ? "already present, verified" : "verified (size and SHA-256)"}`);
    },
  });
  const fetched = results.filter((r) => r.status !== "present").length;
  console.log(fetched === 0 ? "All model files were already installed and verified." : `Done: ${fetched} file(s) installed and verified.`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    // Static messages only: no paths, URLs, native error text or stack traces.
    console.error(err instanceof EmbeddingError ? `model:fetch failed: ${err.message}` : "model:fetch failed unexpectedly.");
    process.exit(1);
  },
);
