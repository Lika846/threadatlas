import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importText } from "../../../tests/helpers/import";
import { exportText, syntheticConversation } from "../../../tests/helpers/synthetic-export";
import { createTestDb, type TestDb } from "../../../tests/helpers/test-db";
import { searchConversations } from "./search";

/**
 * Search performance (M2.2 report). Opt-in, because building the corpus
 * takes about a minute: `THREADATLAS_PERF=1 npx vitest run --project int
 * src/lib/search/search-perf.int.test.ts`. Set `PERF_OUT=<file>` to save the
 * numbers. Synthetic data in a temporary database only. Each search runs its
 * statements synchronously, so its duration is also how long it blocks the
 * event loop. Limits are deliberately generous: this measures, it does not
 * benchmark.
 *
 * Corpus (like the M2.0 spike's): 2,000 conversations × 25 messages = 50,000
 * messages of about 400 characters, from a skewed synthetic vocabulary.
 * Planted: `zqcommon` in one message of every conversation, `zqrare` in 5
 * conversations, `zqtitle` in 20 titles, `zqpre0`–`zqpre99` for prefixes.
 */

const RUN = process.env.THREADATLAS_PERF === "1";
const CONVERSATIONS = 2_000;
const MESSAGES = 25;
const RUNS = 15;

let seed = 42;
const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648), seed / 2_147_483_648);
const word = () => `lex${Math.floor(rand() ** 3 * 5_000)}`;
const sentence = (chars: number) => {
  let s = "";
  while (s.length < chars) s += `${word()} `;
  return s.trim();
};

function corpus(): string {
  const convs = Array.from({ length: CONVERSATIONS }, (_, i) => {
    const c = syntheticConversation({ id: `perf-${i}`, messages: MESSAGES, title: `${i % 100 === 0 ? "zqtitle " : ""}Synthetic topic ${word()} ${word()}`, updateTime: 1_767_300_000 + i });
    const mapping = c.mapping as Record<string, { message: { content: { parts: string[] } } | null }>;
    for (let k = 1; k <= MESSAGES; k++) {
      const extra = [k === 7 ? "zqcommon" : "", k === 3 && i % 400 === 0 ? "zqrare" : "", k === 11 ? `zqpre${i % 100}` : ""].filter(Boolean).join(" ");
      mapping[`n${k}`]!.message!.content.parts = [`${sentence(400)} ${extra}`.trim()];
    }
    return c;
  });
  return exportText(convs);
}

let t: TestDb;
const results: Record<string, unknown> = {};

describe.skipIf(!RUN)("search performance (opt-in)", () => {
  beforeAll(async () => {
    t = createTestDb();
    const started = performance.now();
    const outcome = await importText(corpus(), { writer: t.writer });
    expect(outcome.counts.added).toBe(CONVERSATIONS);
    results.importMs = Math.round(performance.now() - started);
  }, 600_000);

  afterAll(async () => {
    if (t) await t.cleanup();
    if (process.env.PERF_OUT) fs.writeFileSync(process.env.PERF_OUT, JSON.stringify(results, null, 2));
  });

  it("measures typical queries (median and worst of 15 runs, first and last page)", async () => {
    const reader = t.reader();
    const queries: [string, string, string | undefined][] = [
      ["common word, page 1", "zqcommon", undefined],
      ["common word, last page", "zqcommon", "100"],
      ["frequent vocabulary word", "lex0", undefined],
      ["two frequent words", "lex0 lex1", undefined],
      ["rare word", "zqrare", undefined],
      ["title word", "zqtitle", undefined],
      ["phrase", `"zqcommon"`, undefined],
      ["prefix (100 words)", "zqpre*", undefined],
      ["broad prefix", "lex1*", undefined],
      ["no match", "zqnothing", undefined],
    ];
    const timings: Record<string, { medianMs: number; maxMs: number; total: number; results: number }> = {};
    for (const [label, q, page] of queries) {
      const ms: number[] = [];
      let last: Awaited<ReturnType<typeof searchConversations>> | null = null;
      for (let i = 0; i < RUNS; i++) {
        const t0 = performance.now();
        last = await searchConversations(reader, q, page);
        ms.push(performance.now() - t0);
      }
      expect(last!.status, label).toBe("ok");
      const ok = last as Extract<typeof last, { status: "ok" }>;
      ms.sort((a, b) => a - b);
      timings[label] = { medianMs: +ms[Math.floor(RUNS / 2)]!.toFixed(1), maxMs: +ms[RUNS - 1]!.toFixed(1), total: ok.total, results: ok.results.length };
    }
    results.timings = timings;
    expect(timings["common word, page 1"]!.total).toBe(CONVERSATIONS);
    expect(timings["rare word"]!.total).toBe(5);
    expect(timings["title word"]!.total).toBe(20);
    expect(timings["prefix (100 words)"]!.total).toBe(CONVERSATIONS);
    for (const [label, v] of Object.entries(timings)) expect(v.maxMs, label).toBeLessThan(5_000);
  }, 600_000);
});
