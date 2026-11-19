import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Removes this run's temporary database directory (created in
 * playwright.config.ts). Called from global teardown and, because teardown
 * does not run when the web server fails to start, also on exit of the main
 * Playwright process. Only ever deletes a `threadatlas-e2e-*` directory
 * directly inside the system temp directory.
 */
export function removeE2eDatabaseDir(dir: string | undefined = process.env.THREADATLAS_E2E_DIR): void {
  if (!dir || !fs.existsSync(dir)) return;
  const tmp = fs.realpathSync(os.tmpdir());
  const real = fs.realpathSync(dir);
  if (path.dirname(real) === tmp && path.basename(real).startsWith("threadatlas-e2e-")) {
    fs.rmSync(real, { recursive: true, force: true });
  }
}

export default function globalTeardown() {
  removeE2eDatabaseDir();
}
