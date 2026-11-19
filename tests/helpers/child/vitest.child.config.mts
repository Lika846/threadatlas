// Runs only tests/helpers/child/run.child.ts, in a child process started by
// tests/helpers/child/spawn.ts. Used by the cross-process lock and SIGKILL
// crash tests, so the child runs the real TypeScript code without a new
// dependency. Never picked up by the main Vitest projects (no *.test.ts).
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    // A worker thread, not a forked process: the task then runs inside the
    // spawned process, so killing that process kills the task and releases
    // its locks at once (a forked worker could outlive it briefly).
    pool: "threads",
    maxWorkers: 1,
    include: ["tests/helpers/child/run.child.ts"],
    env: { THREADATLAS_TEST: "1" },
    testTimeout: 120_000,
  },
});
