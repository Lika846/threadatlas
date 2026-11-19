/**
 * Test-only plain Node process (M5.1b-2 slice 2): registers the indexer's normal-exit
 * refund for one claim through the real `onProcessExit`, and handles SIGTERM/SIGINT the
 * way Next.js does by default (a signal ends in `process.exit`). The test then signals it
 * and checks the database. Writes only its ready file and the refund's result (a static
 * word). Loaded by Node directly (type stripping).
 *
 *   node exit-refund.child.mts '<json: { dbPath, conversationId, token, readyFile, resultFile }>'
 */
import fs from "node:fs";
import { onProcessExit, refundClaimSync } from "../../src/lib/semantic/index/exit-refund.ts";

type Args = { dbPath: string; conversationId: string; token: string; readyFile: string; resultFile: string };
const a = JSON.parse(process.argv[2] ?? "{}") as Args;

onProcessExit(() => fs.writeFileSync(a.resultFile, refundClaimSync(a.dbPath, a)));
process.on("SIGTERM", () => process.exit(143));
process.on("SIGINT", () => process.exit(130));
fs.writeFileSync(a.readyFile, "ready");
setInterval(() => {}, 1_000);
