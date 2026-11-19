/**
 * The semantic-index service of the Next.js server (M5.1b-2; plan §4). Server-only.
 *
 * One indexing session per server process, kept on `globalThis` (a module-scoped handle
 * would be duplicated by dev reloads). It runs the M5.1b-1 indexer with inference in a
 * child process (`InferenceProcess`); the Next.js server never loads ONNX Runtime.
 *
 * - **Start** is manual only (the Import page). Nothing here runs at startup, after an import or
 *   after Retry. The in-process check-and-set is synchronous, so two Starts can never both
 *   create a session; across processes the indexer lock refuses a second session
 *   (`INDEXER_BUSY`) before any inference process starts. The run continues after the
 *   Server Action returns; its outcome is kept for the status.
 * - **Pause** aborts the run: the current batch finishes, the claimed conversation goes
 *   back to `pending`, the child drains and exits.
 * - **Retry failed** resets failed conversations under the write lock; it never starts a run.
 * - **Status** never writes. Counts and codes only: no text, ids, paths or vectors.
 *
 * A normal shutdown of the server (Next.js's default SIGTERM/SIGINT handling) refunds the
 * attempt of the conversation being indexed (`exit-refund.ts`); the child drains by itself.
 *
 * **Test entry (owner's condition 5):** `THREADATLAS_INFERENCE_ENTRY` replaces the
 * inference child only under a test runner (`THREADATLAS_TEST=1`, Vitest or
 * `NODE_ENV=test`) and only with the exact file `tests/helpers/fake-inference-child.mts`;
 * any other value fails the Start. Under a test runner the database clients refuse every
 * database outside the system temp directory, including the real one (`path.ts`), so the
 * fake child can never index real data. Outside a test runner the variable is ignored.
 */
import path from "node:path";
import { configureWriterConnection, getDb, getWriterDb } from "../../db/client";
import { sanitizeDbError } from "../../db/errors";
import { isTestContext } from "../../db/path";
import { runWriterTransaction } from "../../db/transaction-recovery";
import { acquireWriteLock, IMPORT_LOCK_WAIT_MS, probeIndexerLock } from "../../db/write-lock";
import { EmbeddingError } from "../errors.ts";
import { InferenceProcess, productionChildEntry } from "../inference-process.ts";
import { resolveModelDir, verifyModelDir } from "../model-files.ts";
import { E5_SMALL_MANIFEST } from "../model-manifest.ts";
import { runIndexer, type IndexerResult, type LiveIndexerState } from "./indexer.ts";
import { warmAtlas } from "../topics/atlas.ts";
import { computeIndexStatus, type IndexStatus } from "./status.ts";
import { retryFailed } from "./store.ts";

type Env = Record<string, string | undefined>;
type Where = { env?: Env; root?: string };

export type ModelState = "ok" | "missing" | "invalid" | "dir-invalid";

export type LastRun = {
  outcome: IndexerResult["status"];
  code: string | null;
  indexed: number;
  failed: number;
};

export type IndexingStatus = IndexStatus & {
  model: ModelState;
  /** The last run of this server process since it started (null before the first). */
  lastRun: LastRun | null;
  /** A session is active in this process (starting, running, waiting or pausing). */
  running: boolean;
};

type Session = { abort: AbortController; live: LiveIndexerState };
type State = { session: Session | null; lastRun: LastRun | null };

const holder = globalThis as unknown as { __threadatlasSemantic?: State };
const state = (): State => (holder.__threadatlasSemantic ??= { session: null, lastRun: null });

/** The only file the test-entry override may name. */
export const TEST_INFERENCE_ENTRY = path.join("tests", "helpers", "fake-inference-child.mts");

/** The inference child entry and its test options (condition 5: see the module comment). */
export function inferenceTarget(env: Env, root: string): { entry: string; testOptions?: Record<string, unknown> } {
  const override = env.THREADATLAS_INFERENCE_ENTRY?.trim();
  if (!override || !isTestContext(env)) return { entry: productionChildEntry(root) };
  const allowed = path.resolve(root, TEST_INFERENCE_ENTRY);
  if (path.resolve(root, override) !== allowed) throw new EmbeddingError("RUNTIME_UNAVAILABLE");
  let testOptions: unknown;
  try {
    testOptions = JSON.parse(env.THREADATLAS_INFERENCE_TEST_OPTIONS?.trim() || "{}");
  } catch {
    throw new EmbeddingError("RUNTIME_UNAVAILABLE");
  }
  if (testOptions === null || typeof testOptions !== "object" || Array.isArray(testOptions)) throw new EmbeddingError("RUNTIME_UNAVAILABLE");
  return { entry: allowed, testOptions: testOptions as Record<string, unknown> };
}

/** The model directory and whether its files are present with the approved sizes (no hashing). */
export async function modelState(env: Env, root: string): Promise<{ state: ModelState; dir: string | null }> {
  let dir: string;
  try {
    dir = resolveModelDir({ env, root });
  } catch {
    return { state: "dir-invalid", dir: null };
  }
  try {
    await verifyModelDir(dir, E5_SMALL_MANIFEST, { hash: false }); // sizes only; the child checks SHA-256
    return { state: "ok", dir };
  } catch (e) {
    return { state: e instanceof EmbeddingError && e.code === "MODEL_MISSING" ? "missing" : "invalid", dir };
  }
}

function summary(r: IndexerResult): LastRun {
  if (r.status === "not-started") return { outcome: r.status, code: r.code, indexed: 0, failed: 0 };
  return { outcome: r.status, code: r.status === "stopped" ? r.code : null, indexed: r.stats.indexed, failed: r.stats.failed };
}

export type StartOutcome = { outcome: "started" | "already-running" } | { outcome: "not-started"; code: string };

export async function startIndexing(where: Where = {}): Promise<StartOutcome> {
  const env = where.env ?? process.env;
  const root = where.root ?? process.cwd();
  const s = state();
  if (s.session) return { outcome: "already-running" };
  const model = await modelState(env, root);
  if (model.state !== "ok" || !model.dir) {
    return { outcome: "not-started", code: model.state === "missing" ? "MODEL_MISSING" : model.state === "dir-invalid" ? "MODEL_DIR_INVALID" : "MODEL_INVALID" };
  }
  let target: ReturnType<typeof inferenceTarget>;
  try {
    target = inferenceTarget(env, root);
  } catch {
    s.lastRun = { outcome: "not-started", code: "RUNTIME_UNAVAILABLE", indexed: 0, failed: 0 };
    return { outcome: "not-started", code: "RUNTIME_UNAVAILABLE" };
  }
  // Synchronous from here until the session exists: no second Start can pass.
  if (s.session) return { outcome: "already-running" };
  const abort = new AbortController();
  const session: Session = { abort, live: "running" };
  s.session = session;
  s.lastRun = null;
  const modelDir = model.dir;
  void (async () => {
    let result: LastRun;
    try {
      result = summary(
        await runIndexer({
          writer: getWriterDb(),
          reader: getDb(),
          signal: abort.signal,
          onState: (st) => {
            session.live = abort.signal.aborted ? "pausing" : st;
          },
          openEmbedder: () => InferenceProcess.start({ entry: target.entry, modelDir, testOptions: target.testOptions }),
        }),
      );
    } catch (e) {
      result = { outcome: "stopped", code: e instanceof EmbeddingError ? e.code : sanitizeDbError(e), indexed: 0, failed: 0 };
    }
    s.lastRun = result;
    if (s.session === session) s.session = null;
    // Prepare the map for the new index in the background (worker thread; never throws).
    if (result.indexed > 0) warmAtlas(getDb());
  })();
  return { outcome: "started" };
}

/** Asks the running session to pause after its current batch. */
export function pauseIndexing(): "pausing" | "not-running" {
  const session = state().session;
  if (!session) return "not-running";
  session.live = "pausing";
  session.abort.abort();
  return "pausing";
}

export type RetryOutcome = { ok: true; count: number } | { ok: false; code: string };

/** Every failed conversation back to `pending` with three new attempts. Never starts a run. */
export async function retryFailedConversations(): Promise<RetryOutcome> {
  const writer = getWriterDb();
  const lock = await acquireWriteLock(writer.dbPath, { waitMs: IMPORT_LOCK_WAIT_MS });
  if (!lock.ok) return { ok: false, code: lock.code };
  try {
    await configureWriterConnection(writer.db);
    return { ok: true, count: await runWriterTransaction(writer.db, (tx) => retryFailed(tx)) };
  } catch (e) {
    return { ok: false, code: sanitizeDbError(e) };
  } finally {
    lock.lock.release();
  }
}

/** Read-only status for the Import page. */
export async function getIndexingStatus(where: Where = {}): Promise<IndexingStatus> {
  const env = where.env ?? process.env;
  const root = where.root ?? process.cwd();
  const s = state();
  const dbPath = getWriterDb().dbPath;
  const [index, model] = await Promise.all([
    computeIndexStatus(getDb(), { live: s.session?.live ?? null, probe: () => probeIndexerLock(dbPath) }),
    modelState(env, root),
  ]);
  return { ...index, model: model.state, lastRun: s.lastRun, running: s.session !== null };
}
