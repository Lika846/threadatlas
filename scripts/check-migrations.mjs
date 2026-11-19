// `npm run db:check-migrations` (M2.1, A91): fails unless the migrations and
// prisma/schema.prisma differ by exactly the search-index tables
// (see migration-drift.mjs). Runs the Prisma CLI with telemetry off and a
// non-interactive stdin, like the other db:* scripts. Reads only the
// migration files and the schema (Prisma replays the migrations into its own
// temporary database); never opens the app's database.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeDrift, EXPECTED_SEARCH_INDEX_TABLES } from "./migration-drift.mjs";

const root = process.cwd();
const cli = path.join(root, "node_modules", "prisma", "build", "index.js");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "threadatlas-drift-"));
const out = path.join(dir, "diff.sql");

let script;
try {
  execFileSync(
    process.execPath,
    [cli, "migrate", "diff", "--from-migrations", "prisma/migrations", "--to-schema", "prisma/schema.prisma", "--script", "--output", out],
    { cwd: root, env: { ...process.env, CHECKPOINT_DISABLE: "1", PRISMA_HIDE_UPDATE_MESSAGE: "1" }, stdio: ["ignore", "pipe", "inherit"] },
  );
  script = fs.readFileSync(out, "utf8");
} catch {
  console.error("db:check-migrations: prisma migrate diff failed (see its output above).");
  process.exitCode = 1;
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

if (script !== undefined) {
  const r = analyzeDrift(script);
  if (r.ok) {
    console.log(`Migrations match the Prisma schema, apart from the ${EXPECTED_SEARCH_INDEX_TABLES.length} search-index tables (expected).`);
  } else {
    console.error("db:check-migrations: unexpected drift between prisma/migrations and prisma/schema.prisma.");
    for (const s of r.unexpected) console.error(`  unexpected: ${s}`);
    if (r.missing.length > 0) console.error(`  search-index tables missing from the migrations: ${r.missing.join(", ")}`);
    process.exitCode = 1;
  }
}
