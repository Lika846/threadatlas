/**
 * Keeps native inference out of the Next.js server process (M5.1b-2; plan §3, §7).
 *
 * Follows every runtime import (type-only imports are skipped: they are erased) from the
 * app's entry points (`src/app/**`, `src/proxy.ts`) and from the server-side client
 * `inference-process.ts`, which the app will use in slice 3. None of them may reach the
 * model pipeline, ONNX Runtime, the tokenizer, the worker-thread embedder or the child's
 * own modules. Also checks that the host's modules use no network module and never log.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");

const FORBIDDEN_FILES = [
  "src/lib/semantic/pipeline.ts",
  "src/lib/semantic/ort-backend.ts",
  "src/lib/semantic/tokenizer.ts",
  "src/lib/semantic/embedder.ts",
  "src/lib/semantic/worker.ts",
  "src/lib/semantic/worker-core.ts",
  "src/lib/semantic/child-core.ts",
  "src/lib/semantic/inference-child.ts",
];
const FORBIDDEN_PACKAGES = ["onnxruntime-node", "onnxruntime-common", "@huggingface/tokenizers"];
const NETWORK = /^(node:)?(http|https|http2|net|dgram|dns|tls|undici)(\/|$)/;

/** Runtime module specifiers of one file (type-only imports and exports skipped). */
function specifiers(file: string): string[] {
  const src = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const out: string[] = [];
  for (const m of src.matchAll(/(?:^|[\n;])\s*(import|export)\s+(type\s+)?([^;'"]*?)\s+from\s+["']([^"']+)["']/g)) {
    if (!m[2]) out.push(m[4]!);
  }
  for (const m of src.matchAll(/(?:^|[\n;])\s*import\s+["']([^"']+)["']/g)) out.push(m[1]!);
  for (const m of src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]!);
  return out;
}

function resolveLocal(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? path.join(SRC, spec.slice(2)) : path.resolve(path.dirname(from), spec);
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/** Every local file and package reachable from the entries through runtime imports. */
function reachable(entries: string[]): { files: Set<string>; packages: Set<string>; unresolved: string[] } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const unresolved: string[] = [];
  const queue = [...entries];
  while (queue.length > 0) {
    const f = queue.pop()!;
    if (files.has(rel(f))) continue;
    files.add(rel(f));
    for (const s of specifiers(f)) {
      if (s.startsWith(".") || s.startsWith("@/")) {
        const r = resolveLocal(f, s);
        if (r) queue.push(r);
        else unresolved.push(`${rel(f)} → ${s}`);
      } else {
        packages.add(s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.split("/")[0]!);
      }
    }
  }
  return { files, packages, unresolved };
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(d.name) && !/\.test\.tsx?$/.test(d.name) ? [p] : [];
  });
}

describe("native inference stays out of the Next.js server", () => {
  const entries = [...walk(path.join(SRC, "app")), path.join(SRC, "proxy.ts"), path.join(SRC, "lib/semantic/inference-process.ts")];
  const graph = reachable(entries);

  it("resolves every local import (so the check is complete)", () => {
    expect(graph.unresolved).toEqual([]);
    expect(graph.files.has("src/lib/semantic/inference-process.ts")).toBe(true);
    expect(graph.files.size).toBeGreaterThan(20);
  });

  it("reaches no pipeline, runtime, tokenizer, worker or child module", () => {
    expect(FORBIDDEN_FILES.filter((f) => graph.files.has(f))).toEqual([]);
    expect(FORBIDDEN_PACKAGES.filter((p) => graph.packages.has(p))).toEqual([]);
  });

  it("the client itself needs only child_process, fs, path and two local modules", () => {
    const g = reachable([path.join(SRC, "lib/semantic/inference-process.ts")]);
    expect([...g.files].sort()).toEqual(["src/lib/semantic/errors.ts", "src/lib/semantic/inference-process.ts", "src/lib/semantic/protocol.ts"]);
    expect([...g.packages].sort()).toEqual(["node:child_process", "node:fs", "node:path"]);
  });
});

describe("the inference host's modules", () => {
  const host = ["inference-process.ts", "child-core.ts", "inference-child.ts", "search/query-host.ts", "search/vector-cache.ts", "search/meaning-search.ts"].map((f) =>
    path.join(SRC, "lib/semantic", f),
  );

  it.each(host.map((f) => [rel(f), f]))("%s imports no network module", (_name, file) => {
    const g = reachable([file]);
    expect([...g.packages].filter((p) => NETWORK.test(p))).toEqual([]);
  });

  it.each(host.map((f) => [rel(f), f]))("%s never logs", (_name, file) => {
    expect(fs.readFileSync(file, "utf8")).not.toMatch(/\bconsole\.|process\.(stdout|stderr)\.write/);
  });
});
