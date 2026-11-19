/**
 * The read-only index status (M5.1b-1; design §5.8 and §11) for every state, on
 * migrated temporary databases with synthetic data. Cross-process liveness (a real
 * second process, SIGKILL) is in indexer.crash.int.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importText } from "../../../../tests/helpers/import";
import { conversationId, indexWith } from "../../../../tests/helpers/semantic-index";
import { exportText, syntheticConversation, syntheticExport } from "../../../../tests/helpers/synthetic-export";
import { createTestDb, type TestDb } from "../../../../tests/helpers/test-db";
import { totalChanges } from "../../../../tests/helpers/import";
import { computeIndexStatus } from "./status";
import type { LiveIndexerState } from "./indexer";

let t: TestDb;
beforeEach(() => {
  t = createTestDb();
});
afterEach(async () => {
  await t.cleanup();
});

const importConvs = async (convs: unknown[]) => expect((await importText(exportText(convs), { writer: t.writer })).complete).toBe(true);
const status = (live: LiveIndexerState | null = null, probe: "held" | "free" | "unknown" = "free") => computeIndexStatus(t.db, { live, probe: () => probe });

describe("index status", () => {
  it("never indexed: every conversation waiting, no chunks", async () => {
    await importConvs(syntheticExport(3));
    expect(await status()).toEqual({
      state: "never-indexed",
      counts: { conversations: 3, indexed: 0, waiting: 3, running: 0, failed: 0, tooLarge: 0, chunks: 0 },
      lastErrorCode: null,
    });
  });

  it("an empty database is never indexed, with zero counts", async () => {
    expect((await status()).state).toBe("never-indexed");
  });

  it("up to date after a run; waiting after a new import; conversations imported before M5.1b count as waiting", async () => {
    await importConvs(syntheticExport(2));
    expect((await indexWith(t)).status).toBe("finished");
    const s = await status();
    expect(s.state).toBe("up-to-date");
    expect(s.counts).toMatchObject({ conversations: 2, indexed: 2, waiting: 0 });
    expect(s.counts.chunks).toBeGreaterThan(0);
    await importConvs(syntheticExport(1, { idPrefix: "new" }));
    expect(await status()).toMatchObject({ state: "waiting", counts: { waiting: 1, indexed: 2 } });
    await t.db.$executeRawUnsafe(`DELETE FROM "EmbeddingStatus" WHERE "state" = 'pending'`); // as if imported before M5.1b
    expect(await status()).toMatchObject({ state: "waiting", counts: { waiting: 1 } });
  });

  it("finished with failures: too large counted separately from other failures", async () => {
    await importConvs([syntheticConversation({ id: "poison", tag: "POISONPILL" }), syntheticConversation({ id: "ok" })]);
    expect((await indexWith(t, { worker: { poisonMarker: "POISONPILL" } })).status).toBe("finished");
    await importConvs([syntheticConversation({ id: "big" })]);
    expect((await indexWith(t)).status).toBe("finished");
    await t.db.$executeRawUnsafe(
      `UPDATE "EmbeddingStatus" SET "state" = 'failed', "lastErrorCode" = 'CONVERSATION_TOO_LARGE' WHERE "conversationId" = ?`,
      await conversationId(t.db, "big"),
    );
    expect(await status()).toMatchObject({ state: "finished-with-failures", counts: { indexed: 1, failed: 1, tooLarge: 1, waiting: 0 } });
  });

  it("run failed: the last run-level error code is shown", async () => {
    await importConvs(syntheticExport(1));
    expect((await indexWith(t)).status).toBe("finished");
    await t.db.$executeRawUnsafe(`UPDATE "EmbeddingIndex" SET "lastErrorCode" = 'MODEL_MISSING'`);
    expect(await status()).toMatchObject({ state: "run-failed", lastErrorCode: "MODEL_MISSING" });
  });

  it("incompatible: a stored configuration that differs from the code's (rebuilt at the next Start)", async () => {
    await importConvs(syntheticExport(1));
    expect((await indexWith(t)).status).toBe("finished");
    await t.db.$executeRawUnsafe(`UPDATE "EmbeddingIndex" SET "dimensions" = 768`);
    expect((await status()).state).toBe("incompatible");
    expect((await indexWith(t)).status).toBe("finished");
    expect((await status()).state).toBe("up-to-date");
  });

  it("running rows: interrupted when no process indexes, live when this process does, elsewhere when another holds the lock", async () => {
    await importConvs(syntheticExport(3));
    expect((await indexWith(t)).status).toBe("finished");
    await t.db.$executeRawUnsafe(`UPDATE "EmbeddingStatus" SET "state" = 'running', "claimToken" = 'dead' WHERE rowid = (SELECT MIN(rowid) FROM "EmbeddingStatus")`);
    expect(await status()).toMatchObject({ state: "interrupted", counts: { running: 1, waiting: 1, indexed: 2 } });
    expect(await status(null, "unknown")).toMatchObject({ state: "interrupted" });
    expect(await status("running")).toMatchObject({ state: "indexing", counts: { running: 1, waiting: 0 } });
    expect((await status("waiting-for-import")).state).toBe("waiting-for-import");
    expect((await status("pausing")).state).toBe("pausing");
    expect((await status(null, "held")).state).toBe("indexing-elsewhere");
  });

  it("never writes, and never probes while this process is indexing", async () => {
    await importConvs(syntheticExport(2));
    await t.db.$executeRawUnsafe(`UPDATE "EmbeddingStatus" SET "state" = 'running'`);
    const before = await totalChanges(t.db);
    let probes = 0;
    await computeIndexStatus(t.db, { live: "running", probe: () => (probes++, "free") });
    expect(probes).toBe(0);
    await computeIndexStatus(t.db, { live: null, probe: () => (probes++, "free") });
    expect(probes).toBe(1);
    expect(await totalChanges(t.db)).toBe(before);
    expect((await t.db.embeddingStatus.findMany()).map((s) => s.state)).toEqual(["running", "running"]);
  });

  it("returns counts and codes only: no text, ids or vectors", async () => {
    await importConvs([syntheticConversation({ id: "secret-id", tag: "SECRETCANARY" })]);
    expect((await indexWith(t)).status).toBe("finished");
    const s = JSON.stringify(await status());
    expect(s).not.toMatch(/SECRETCANARY|secret-id/i);
    expect(s).not.toContain(await conversationId(t.db, "secret-id"));
  });
});
