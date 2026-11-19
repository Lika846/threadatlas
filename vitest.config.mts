import { defineConfig } from "vitest/config";

const EXCLUDE = ["e2e/**", "node_modules/**", ".next/**"];

// Real-model tests (M5.1a) need the model files and take about a minute, so they run
// only through `npm run test:model`, never as part of `npm test`.
const MODEL_TESTS = process.env.THREADATLAS_MODEL_TESTS === "1";

export default defineConfig({
  resolve: {
    // Honour the "@/*" alias from tsconfig.json (native in Vite 8).
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    // Playwright specs live in e2e/ and run with `npm run test:e2e`.
    exclude: EXCLUDE,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "src/**/*.test.tsx", "tests/**/*.test.ts"],
          // Database tests run only in the isolated "int" project (A8, A41).
          exclude: [...EXCLUDE, "**/*.int.test.ts", "**/*.model.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "int",
          include: ["src/**/*.int.test.ts", "tests/**/*.int.test.ts"],
          globalSetup: ["tests/helpers/int-global-setup.ts"],
          env: { THREADATLAS_TEST: "1" },
        },
      },
      ...(MODEL_TESTS
        ? [
            {
              extends: true as const,
              test: {
                name: "model",
                include: ["src/**/*.model.test.ts"],
                testTimeout: 120_000,
                hookTimeout: 120_000,
              },
            },
          ]
        : []),
    ],
  },
});
