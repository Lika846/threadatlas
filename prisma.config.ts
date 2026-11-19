import { defineConfig } from "prisma/config";
import { assertDatabaseIsolation, resolveDatabasePath, toDatabaseUrl } from "./src/lib/db/path";

/**
 * Prisma CLI configuration. Run the CLI only through the npm scripts
 * (`db:*`), which disable telemetry and make stdin non-interactive.
 *
 * The CLI looks for this file in the working directory, so the working
 * directory is the project root. Under a test runner
 * (THREADATLAS_TEST=1), the guard refuses any database that is not an
 * isolated temporary file, so a test can never migrate the real database.
 */
const root = process.cwd();
const dbPath = resolveDatabasePath({ env: process.env, root });
assertDatabaseIsolation({ env: process.env, root, dbPath });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: toDatabaseUrl(dbPath) },
});
