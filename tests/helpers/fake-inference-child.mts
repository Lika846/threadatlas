/**
 * Test-only inference child entry (M5.1b-2): the real IPC adapter (`child-core.ts`) and
 * the real worker loop over a fake pipeline, configured by `init.testOptions`. Loaded by
 * Node directly (type stripping), hence `.mts` and `.ts` imports. No model, no network.
 *
 * Event log (optional, `eventLog`: an absolute file path in a temporary directory): one
 * JSON line per event, `{ t, name }`, with static names only:
 *   init, pid:<n>, env:<n> (environment variables other than Node's IPC ones and macOS's encoding one), batch-start,
 *   batch-end, cancel-received, drain:<cause>, released, exit:<code>.
 */
import fs from "node:fs";
import { serveOverIpc } from "../../src/lib/semantic/child-core.ts";
import { EmbeddingError, isEmbeddingErrorCode } from "../../src/lib/semantic/errors.ts";
import { createFakeIndexPipeline, createOrtLikePipeline, type FakeIndexPipelineOptions, type OrtLikeOptions } from "./fake-pipeline.mts";

export type FakeChildOptions = {
  /** "ort-like" (default): the real createPipeline over an ONNX-like blocking backend. */
  pipeline?: "ort-like" | "index";
  eventLog?: string;
  /** Fail start-up with this code (an `EmbeddingError` code). */
  initErrorCode?: string;
  loadDelayMs?: number;
  /** Block the main thread forever while loading (a start-up hang). */
  hangOnLoad?: boolean;
  orphanGraceMs?: number;
  /** Written to stdout, stderr and console at start-up: must never reach the parent's output. */
  stdioCanary?: string;
  /** Test only: reply to `chunk` with something that is not a chunk list. */
  badChunkReply?: boolean;
  /**
   * What a `crashMarker` does: "kill" (default) ends the child abruptly with SIGKILL, which
   * leaves no macOS crash report; "abort" is a real native abort (SIGABRT), used only by the
   * opt-in native-crash tests (THREADATLAS_NATIVE_CRASH_TESTS=1).
   */
  crashMode?: "kill" | "abort";
} & OrtLikeOptions &
  FakeIndexPipelineOptions;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

serveOverIpc((init) => {
  const o = (init.testOptions ?? {}) as FakeChildOptions;
  const log = (name: string) => {
    if (o.eventLog) fs.appendFileSync(o.eventLog, `${JSON.stringify({ t: Date.now(), name })}\n`);
  };
  log("init");
  log(`pid:${process.pid}`);
  // Node adds its IPC variables; macOS adds __CF_USER_TEXT_ENCODING (a text-encoding setting) to every process.
  log(`env:${Object.keys(process.env).filter((k) => !k.startsWith("NODE_CHANNEL_") && k !== "__CF_USER_TEXT_ENCODING").length}`);
  process.on("exit", (code) => log(`exit:${code}`));
  if (o.stdioCanary) {
    process.stdout.write(`${o.stdioCanary}\n`);
    process.stderr.write(`${o.stdioCanary}\n`);
    console.log(o.stdioCanary);
    console.error(o.stdioCanary);
  }
  const hooks = {
    onBatchStart: () => log("batch-start"),
    onBatchEnd: () => log("batch-end"),
    onRelease: () => log("released-pipeline"),
    onCrash: () => (o.crashMode === "abort" ? process.abort() : process.kill(process.pid, "SIGKILL")),
  };
  return {
    orphanGraceMs: o.orphanGraceMs,
    onEvent: log,
    load: async () => {
      if (o.loadDelayMs) await sleep(o.loadDelayMs);
      if (o.hangOnLoad) for (;;) {
        // a start-up hang: the event loop never turns
      }
      if (o.initErrorCode) throw new EmbeddingError(isEmbeddingErrorCode(o.initErrorCode) ? o.initErrorCode : "MODEL_LOAD_FAILED");
      const p = o.pipeline === "index" ? createFakeIndexPipeline(o, hooks) : createOrtLikePipeline(o, hooks);
      if (!o.badChunkReply) return p;
      return { ...p, chunk: () => ({ not: "a chunk list" }) as never };
    },
  };
});
