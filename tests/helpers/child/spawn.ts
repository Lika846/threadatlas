import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { toDatabaseUrl } from "../../../src/lib/db/path";

const ROOT = process.cwd();
const VITEST = path.join(ROOT, "node_modules", "vitest", "vitest.mjs");
const CONFIG = path.join("tests", "helpers", "child", "vitest.child.config.mts");

export type Child = { proc: ChildProcess; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> };

/**
 * Starts run.child.ts in a separate Node process (a separate OS process,
 * so it has its own SQLite connections and file locks). Output is captured,
 * never printed. The database must be a temporary one.
 */
export function spawnChild(dbFile: string, vars: Record<string, string>): Child {
  const proc = spawn(process.execPath, [VITEST, "run", "--config", CONFIG, "--silent"], {
    cwd: ROOT,
    env: {
      ...process.env,
      THREADATLAS_TEST: "1",
      DATABASE_URL: toDatabaseUrl(dbFile),
      CHILD_DB: dbFile,
      ...vars,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.resume();
  proc.stderr?.resume();
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    proc.once("exit", (code, signal) => resolve({ code, signal })),
  );
  return { proc, exited };
}

export async function waitForFile(file: string, timeoutMs = 60_000): Promise<string> {
  const t0 = Date.now();
  while (!fs.existsSync(file)) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${path.basename(file)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
  // The writer may still be writing: wait until the content is stable.
  let prev = "";
  for (;;) {
    const cur = fs.readFileSync(file, "utf8");
    if (cur !== "" && cur === prev) return cur;
    prev = cur;
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** Kills the child if it is still running (cleanup). */
export async function killChild(c: Child): Promise<void> {
  if (c.proc.exitCode === null && c.proc.signalCode === null) {
    c.proc.kill("SIGKILL");
    await c.exited;
  }
}
