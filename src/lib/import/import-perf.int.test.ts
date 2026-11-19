import fs from "node:fs";
import v8 from "node:v8";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { importAdapterResult } from "./import-service";
import { validateExportText } from "./validate-export";
import { exportText, syntheticConversation, syntheticExport } from "../../../tests/helpers/synthetic-export";
import { createTestDb, type TestDb } from "../../../tests/helpers/test-db";

/**
 * Performance measurements (M1.4 report). Opt-in, because the full run takes
 * about a minute: `THREADATLAS_PERF=1 npx vitest run --project int
 * src/lib/import/import-perf.int.test.ts`. Set `PERF_OUT=<file>` to save the
 * numbers. Synthetic data and temporary databases only. Time limits are
 * deliberately generous: these tests measure, they do not benchmark.
 */

const RUN = process.env.THREADATLAS_PERF === "1";

/** Parses outside the measured window, so only persistence is observed. */
function prepared(text: string) {
  const parsed = validateExportText(text);
  if (!parsed.ok) throw new Error("parse");
  const file = { filename: "synthetic.json", sha256: createHash("sha256").update(text).digest("hex"), byteLength: Buffer.byteLength(text) };
  return { parsed, file };
}
const results: Record<string, unknown> = {};

let t: TestDb;
beforeEach(() => {
  t = createTestDb();
});
afterEach(async () => {
  await t.cleanup();
  if (process.env.PERF_OUT) fs.writeFileSync(process.env.PERF_OUT, JSON.stringify(results, null, 2));
});

/** Event-loop gaps (5 ms timer) and latency of a reader on its own connection while `fn` runs. */
async function observe<T>(fn: () => Promise<T>) {
  const reader = t.reader();
  await reader.conversation.count();
  let done = false;
  const latencies: number[] = [];
  const poll = (async () => {
    while (!done) {
      const t0 = performance.now();
      await reader.conversation.count();
      latencies.push(performance.now() - t0);
      await new Promise((r) => setTimeout(r, 20));
    }
  })();
  let last = performance.now();
  let maxGap = 0;
  let ticks = 0;
  const gaps: number[] = [];
  const timer = setInterval(() => {
    const now = performance.now();
    ticks++;
    if (now - last > 50) gaps.push(Math.round(now - last));
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 5);
  let peakHeap = 0;
  const mem = setInterval(() => (peakHeap = Math.max(peakHeap, v8.getHeapStatistics().used_heap_size)), 50);
  const t0 = performance.now();
  const value = await fn();
  const totalMs = performance.now() - t0;
  done = true;
  clearInterval(timer);
  clearInterval(mem);
  await poll;
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    value,
    stats: {
      totalMs: round(totalMs),
      maxEventLoopGapMs: round(Math.max(maxGap, performance.now() - last)),
      timerTicks: ticks,
      gapsOver50ms: gaps.length,
      largestGapsMs: [...gaps].sort((a, b) => b - a).slice(0, 5),
      readerQueries: latencies.length,
      readerMaxMs: round(Math.max(0, ...latencies)),
      peakHeapMiB: round(peakHeap / 2 ** 20),
    },
  };
}

describe.skipIf(!RUN)("import performance (opt-in)", () => {
  it("2,000 conversations × 25 messages: add, unchanged re-import, update", async () => {
    const v1 = exportText(syntheticExport(2_000, { messages: 25, textLength: 400, tag: "v1" }));
    const v2 = exportText(syntheticExport(2_000, { messages: 25, textLength: 400, tag: "v2", updateTime: 1_767_225_700 }));
    results.fileMiB = Math.round((Buffer.byteLength(v1) / 2 ** 20) * 10) / 10;
    const p1 = prepared(v1);
    const p2 = prepared(v2);
    const run = (p: ReturnType<typeof prepared>) => importAdapterResult({ ...p.parsed, accepted: [...p.parsed.accepted] }, p.file, { writer: t.writer });
    const add = await observe(() => run(p1));
    expect(add.value).toMatchObject({ status: "succeeded", counts: { added: 2_000 } });
    const same = await observe(() => run(p1));
    expect(same.value).toMatchObject({ status: "succeeded", counts: { unchanged: 2_000 } });
    const upd = await observe(() => run(p2));
    expect(upd.value).toMatchObject({ status: "succeeded", counts: { updated: 2_000 } });
    expect(await t.db.message.count()).toBe(2_000 * 26);
    results.bulk = { add: add.stats, unchangedReimport: same.stats, update: upd.stats };
  }, 600_000);

  it("one conversation of 20,000 messages × 1 KB", async () => {
    const p = prepared(exportText([syntheticConversation({ id: "huge", messages: 19_999, textLength: 1_000 })]));
    // Phase timestamps through the test-only hooks: batch created → (normalise + read) →
    // inserts → commit → finalise.
    const at: Record<string, number> = {};
    const mark = (k: string) => void (at[k] = performance.now());
    const r = await observe(() =>
      importAdapterResult(p.parsed, p.file, {
        writer: t.writer,
        hooks: {
          afterBatchCreated: () => mark("batchCreated"),
          inTransaction: (stage) => void (stage === "afterRead" ? mark("normalisedAndRead") : stage === "beforeCommit" ? mark("inserted") : undefined),
          afterConversation: () => mark("committed"),
          beforeFinalize: () => mark("beforeFinalize"),
        },
      }),
    );
    expect(r.value).toMatchObject({ status: "succeeded", counts: { added: 1 } });
    expect(await t.db.message.count()).toBe(20_000);
    const d = (a: string, b: string) => Math.round(at[b]! - at[a]!);
    results.large = {
      ...r.stats,
      phasesMs: {
        normaliseAndRead: d("batchCreated", "normalisedAndRead"),
        insert40Chunks: d("normalisedAndRead", "inserted"),
        commit: d("inserted", "committed"),
        toFinalise: d("committed", "beforeFinalize"),
      },
    };
  }, 600_000);
});
