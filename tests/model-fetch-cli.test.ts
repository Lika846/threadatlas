import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// `npm run model:fetch` entry point. Only offline paths are exercised: --help, a bad
// option, and --from a local directory. The download path is covered with a loopback
// server in src/lib/semantic/model-fetch.test.ts.
function run(args: string[]) {
  const env = { ...process.env };
  delete env.THREADATLAS_MODEL_DIR;
  const r = spawnSync(process.execPath, ["scripts/model-fetch.ts", ...args], { cwd: process.cwd(), env, encoding: "utf8", timeout: 30_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("model:fetch CLI", () => {
  it("prints usage", () => {
    const r = run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Usage: npm run model:fetch");
  });

  it("rejects unknown options", () => {
    const r = run(["--bogus"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("Usage");
  });

  it("fails with a static message and no paths when the local source is missing files", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ta-fetch-cli-"));
    try {
      const r = run(["--from", path.join(tmp, "src"), "--dest", path.join(tmp, "dest")]);
      expect(r.code).toBe(1);
      expect(r.out).toContain("Source: local directory (no network).");
      expect(r.out).toContain("Destination: the given directory");
      expect(r.err.trim()).toBe("model:fetch failed: A model file could not be downloaded or copied.");
      expect(r.out + r.err).not.toContain(tmp);
      expect(fs.readdirSync(path.join(tmp, "dest"), { recursive: true }).map(String).filter((f) => f.includes(".partial-"))).toEqual(
        [],
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
