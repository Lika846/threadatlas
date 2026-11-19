/** What Settings shows for each semantic-index state (M5.1b-2): static text and button states. */
import { describe, expect, it } from "vitest";
import { codeMessage, viewOf } from "./messages";
import type { IndexingStatus } from "./service";

const base = (over: Partial<IndexingStatus> = {}, counts: Partial<IndexingStatus["counts"]> = {}): IndexingStatus => ({
  state: "waiting",
  counts: { conversations: 10, indexed: 0, waiting: 10, running: 0, failed: 0, tooLarge: 0, chunks: 0, ...counts },
  lastErrorCode: null,
  model: "ok",
  lastRun: null,
  running: false,
  ...over,
});

describe("viewOf", () => {
  it("waiting: Start enabled", () => {
    expect(viewOf(base())).toMatchObject({ tone: "neutral", message: "10 conversations not indexed yet.", canStart: true, startLabel: "Start indexing", canPause: false, canRetry: false });
  });

  it("indexing: progress, Pause enabled, Start disabled", () => {
    const v = viewOf(base({ state: "indexing", running: true }, { indexed: 4, waiting: 5, running: 1 }));
    expect(v).toMatchObject({ message: "Indexing… 4 of 10 conversations indexed.", canStart: false, canPause: true, pausing: false });
  });

  it("pausing: Pause disabled and labelled as pausing", () => {
    expect(viewOf(base({ state: "pausing", running: true }))).toMatchObject({ message: "Pausing after the current batch…", canPause: false, pausing: true });
  });

  it("paused: Resume", () => {
    const v = viewOf(base({ lastRun: { outcome: "paused", code: null, indexed: 3, failed: 0 } }, { indexed: 3, waiting: 7 }));
    expect(v).toMatchObject({ message: "Paused. 7 conversations waiting.", canStart: true, startLabel: "Resume indexing" });
  });

  it("model missing: the install command, Start disabled", () => {
    const v = viewOf(base({ model: "missing" }));
    expect(v.message).toContain("npm run model:fetch");
    expect(v).toMatchObject({ tone: "warning", canStart: false });
  });

  it("model invalid and directory invalid: static errors, Start disabled", () => {
    expect(viewOf(base({ model: "invalid" }))).toMatchObject({ tone: "error", canStart: false });
    expect(viewOf(base({ model: "dir-invalid" }))).toMatchObject({ tone: "error", canStart: false });
  });

  it("interrupted: explains what happens next; Start enabled", () => {
    const v = viewOf(base({ state: "interrupted" }, { running: 1, waiting: 3, indexed: 7 }));
    expect(v).toMatchObject({ tone: "warning", canStart: true, startLabel: "Resume indexing" });
    expect(v.message).toBe("Indexing was interrupted (ThreadAtlas stopped). 3 conversations will be indexed at the next Start.");
  });

  it("incompatible: will be rebuilt", () => {
    expect(viewOf(base({ state: "incompatible" }, { waiting: 0, indexed: 10 })).message).toContain("will be rebuilt at the next Start");
  });

  it("indexing elsewhere: Start and Retry disabled", () => {
    expect(viewOf(base({ state: "indexing-elsewhere" }, { failed: 1 }))).toMatchObject({ canStart: false, canRetry: false });
  });

  it("a run that stopped: the code's static message", () => {
    expect(viewOf(base({ state: "run-failed", lastErrorCode: "WORKER_FAILED" })).message).toBe("Indexing stopped. The embedding worker stopped unexpectedly.");
  });

  it("finished with failures: Retry offered, keyword search reassurance", () => {
    const v = viewOf(base({ state: "finished-with-failures" }, { indexed: 8, waiting: 0, failed: 1, tooLarge: 1 }));
    expect(v).toMatchObject({ tone: "warning", canRetry: true, canStart: false });
    expect(v.message).toBe("Indexed 8 conversations. 2 failed (1 too large to index); keyword search still finds them.");
  });

  it("up to date: success, Start disabled", () => {
    expect(viewOf(base({ state: "up-to-date" }, { indexed: 10, waiting: 0 }))).toMatchObject({ tone: "success", message: "All 10 conversations are indexed.", canStart: false });
  });

  it("no conversations: nothing to index", () => {
    expect(viewOf(base({ state: "never-indexed" }, { conversations: 0, waiting: 0 }))).toMatchObject({ message: "There are no imported conversations to index yet.", canStart: false });
  });
});

describe("codeMessage", () => {
  it("maps inference, database and index codes to static sentences, and anything else to a generic one", () => {
    expect(codeMessage("MODEL_LOAD_FAILED")).toBe("The local inference runtime could not load the semantic model.");
    expect(codeMessage("DB_BUSY")).toBe("The database is locked by another program. Try again later.");
    expect(codeMessage("INDEXER_BUSY")).toBe("Another ThreadAtlas process is indexing this database.");
    expect(codeMessage("<script>")).toBe("Indexing stopped because of an unexpected error. Try again.");
  });
});
