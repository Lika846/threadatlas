import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Library code never logs: imported content and raw database errors must
  // not reach the console (A50). Results are returned as codes instead.
  {
    files: ["src/lib/**"],
    rules: { "no-console": "error" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated Prisma Client
    "src/generated/**",
    // Test artefacts
    "coverage/**",
    "test-results/**",
    "playwright-report/**",
    "blob-report/**",
  ]),
]);

export default eslintConfig;
