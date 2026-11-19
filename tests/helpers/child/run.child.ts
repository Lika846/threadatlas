// Child-process tasks for cross-process tests (M1.4). Started only by
// spawn.ts through vitest.child.config.mts; configured by CHILD_* variables.
// Uses temporary databases only: the client's isolation guard applies.
import fs from "node:fs";
import path from "node:path";
import { it } from "vitest";
import { createPrismaClient, createWriterClient } from "../../../src/lib/db/client";
import { acquireIndexerLock, acquireWriteLock, probeIndexerLock } from "../../../src/lib/db/write-lock";
import { runIndexer, type IndexerHooks } from "../../../src/lib/semantic/index/indexer";
import { InferenceProcess } from "../../../src/lib/semantic/inference-process";
import { fakeIndexEmbedder } from "../semantic-index";
import { deleteAllImportedData, type DeleteAllHooks } from "../../../src/lib/data/delete-all";
import { importAdapterResult, type ImportHooks } from "../../../src/lib/import/import-service";
import { validateExportText } from "../../../src/lib/import/validate-export";

const env = process.env;
const forever = () => new Promise<never>(() => {});
// Locks held "forever" stay referenced here: a lock reachable only from a suspended async
// function can be garbage-collected, and better-sqlite3 then closes its connection, which
// releases the lock (an intermittent failure found in M5.1b-2 slice 2).
const held: unknown[] = [];
const write = (file: string | undefined, text: string) => {
  if (file) fs.writeFileSync(file, text);
};

/** Writes the marker, then either dies (SIGKILL) or waits for the go-file. */
async function stopHere(): Promise<void> {
  write(env.CHILD_MARKER, "reached");
  if (env.CHILD_ACTION === "kill") {
    process.kill(process.pid, "SIGKILL");
    await forever();
  }
  const go = env.CHILD_GO!;
  while (!fs.existsSync(go)) await new Promise((r) => setTimeout(r, 10));
}

/**
 * CHILD_STOP_AT selects where to stop:
 *   tx:<stage>:<index>       inside the transaction of conversation <index>
 *   after:<index>            after the outcome of conversation <index> is recorded
 *   checkpoint:<n>           after the n-th checkpoint (1-based)
 *   finalize                 just before finalisation
 *   batch                    right after the batch row is created
 */
function hooksFor(spec: string | undefined): ImportHooks {
  if (!spec) return {};
  const [kind, a, b] = spec.split(":");
  let checkpoints = 0;
  return {
    afterBatchCreated: kind === "batch" ? stopHere : undefined,
    inTransaction: kind === "tx" ? async (stage, index) => {
      if (stage === a && index === Number(b)) await stopHere();
    } : undefined,
    afterConversation: kind === "after" ? async (index) => {
      if (index === Number(a)) await stopHere();
    } : undefined,
    afterCheckpoint: kind === "checkpoint" ? async () => {
      if (++checkpoints === Number(a)) await stopHere();
    } : undefined,
    beforeFinalize: kind === "finalize" ? stopHere : undefined,
  };
}

it("child task", async () => {
  const task = env.CHILD_TASK;
  if (task === "lock-hold" || task === "lock-try") {
    const r = await acquireWriteLock(env.CHILD_DB!);
    write(env.CHILD_OUT, r.ok ? "ACQUIRED" : r.code);
    if (r.ok && task === "lock-hold") {
      held.push(r);
      await forever();
    }
    if (r.ok && env.CHILD_HOLD_MS) await new Promise((res) => setTimeout(res, Number(env.CHILD_HOLD_MS)));
    if (r.ok) r.lock.release();
    return;
  }
  if (task === "lock-loop") {
    // Mutual-exclusion probe: for CHILD_LOOP_MS, repeatedly take the lock and,
    // while holding it, claim a shared owner file. Any overlap with another
    // holder shows up as a non-empty owner file on entry or a changed owner.
    const owner = env.CHILD_OWNER_FILE!;
    const me = `child-${process.pid}`;
    const until = Date.now() + Number(env.CHILD_LOOP_MS ?? 3000);
    let held = 0;
    let busy = 0;
    let violations = 0;
    while (Date.now() < until) {
      const r = await acquireWriteLock(env.CHILD_DB!);
      if (!r.ok) {
        if (r.code === "IMPORT_BUSY") busy++;
        else violations++;
        continue;
      }
      held++;
      if (fs.readFileSync(owner, "utf8") !== "") violations++;
      fs.writeFileSync(owner, me);
      await new Promise((res) => setTimeout(res, 5 + Math.random() * 15));
      if (fs.readFileSync(owner, "utf8") !== me) violations++;
      fs.writeFileSync(owner, "");
      r.lock.release();
      await new Promise((res) => setTimeout(res, Math.random() * 5));
    }
    write(env.CHILD_OUT, JSON.stringify({ held, busy, violations }));
    return;
  }
  if (task === "index-lock-hold") {
    const r = await acquireIndexerLock(env.CHILD_DB!);
    write(env.CHILD_OUT, r.ok ? "ACQUIRED" : r.code);
    if (r.ok) {
      held.push(r);
      await forever();
    }
    return;
  }
  if (task === "index-probe-loop") {
    // Liveness probes in a tight loop (status polling from another process) until the parent
    // writes CHILD_GO. CHILD_MARKER is written after the first probe, so the parent starts its
    // side of the race only once probing has begun: synchronised, not timed (process start-up
    // under load can take seconds). A 60 s cap keeps an abandoned child from looping forever.
    const go = env.CHILD_GO!;
    const cap = Date.now() + 60_000;
    const seen = { held: 0, free: 0, unknown: 0 };
    seen[probeIndexerLock(env.CHILD_DB!)]++;
    write(env.CHILD_MARKER, "probing");
    while (!fs.existsSync(go) && Date.now() < cap) {
      seen[probeIndexerLock(env.CHILD_DB!)]++;
      await new Promise((res) => setTimeout(res, Math.random() * 2));
    }
    write(env.CHILD_OUT, JSON.stringify(seen));
    return;
  }
  if (task === "index") {
    // CHILD_STOP_AT (first occurrence only): claim (inside T1), inference (after the first
    // window), after-inference (inference ended, outcome not yet recorded), commit (inside
    // T2), after-commit, or hold (after Reconcile, holding the indexer lock but not the write
    // lock). CHILD_HOST=process runs inference in the fake inference child process
    // (M5.1b-2) with the options in CHILD_HOST_OPTIONS (JSON); otherwise a worker thread.
    const stop = env.CHILD_STOP_AT;
    let stopped = false;
    const at = (point: string) => (point === stop ? async () => {
      if (stopped) return;
      stopped = true;
      await stopHere();
    } : undefined);
    const hooks: IndexerHooks = {
      afterReconcile: at("hold"),
      inClaim: at("claim"),
      afterWindow: at("inference"),
      afterInference: at("after-inference"),
      inCommit: at("commit"),
      afterCommit: at("after-commit"),
    };
    const writer = createWriterClient({ env });
    const reader = createPrismaClient({ env });
    const r = await runIndexer({
      writer,
      reader,
      openEmbedder:
        env.CHILD_HOST === "process"
          ? () =>
              InferenceProcess.start({
                entry: path.join(process.cwd(), "tests/helpers/fake-inference-child.mts"),
                modelDir: "/unused",
                testOptions: { pipeline: "index", ...(JSON.parse(env.CHILD_HOST_OPTIONS ?? "{}") as Record<string, unknown>) },
              })
          : fakeIndexEmbedder({ batchDelayMs: Number(env.CHILD_BATCH_DELAY_MS ?? 0) }),
      hooks,
      writeLockRetryMs: 50,
    });
    write(env.CHILD_OUT, JSON.stringify(r));
    await reader.$disconnect();
    await writer.db.$disconnect();
    return;
  }
  if (task === "import") {
    const text = fs.readFileSync(env.CHILD_EXPORT!, "utf8");
    const parsed = validateExportText(text);
    if (!parsed.ok) throw new Error("child export must parse");
    const writer = createWriterClient({ env });
    const outcome = await importAdapterResult(
      parsed,
      { filename: "synthetic.json", sha256: "0".repeat(64), byteLength: text.length },
      { writer, hooks: hooksFor(env.CHILD_STOP_AT), checkpointEvery: Number(env.CHILD_CHECKPOINT_EVERY ?? 250) },
    );
    write(env.CHILD_OUT, JSON.stringify(outcome));
    await writer.db.$disconnect();
    return;
  }
  if (task === "delete-all") {
    // CHILD_STOP_AT: tx (inside the delete transaction), after-commit, or
    // vacuum. For vacuum, a test-only filler table (temporary database only,
    // A82) makes VACUUM run long enough for the parent to kill it mid-way;
    // the child writes the marker and starts VACUUM without waiting.
    const stop = env.CHILD_STOP_AT;
    const hooks: DeleteAllHooks = {
      inTransaction: stop === "tx" ? stopHere : undefined,
      afterCommit: stop === "after-commit" ? stopHere : undefined,
      beforeVacuum:
        stop === "vacuum"
          ? async (db) => {
              await db.$executeRawUnsafe("CREATE TABLE test_filler (b BLOB)");
              await db.$executeRawUnsafe(
                "INSERT INTO test_filler WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 25000) SELECT randomblob(4000) FROM c",
              );
              write(env.CHILD_MARKER, "reached");
            }
          : undefined,
    };
    const writer = createWriterClient({ env });
    const result = await deleteAllImportedData({ writer, hooks });
    write(env.CHILD_OUT, JSON.stringify(result));
    await forever(); // the parent kills the child
  }
  throw new Error("unknown CHILD_TASK");
});
