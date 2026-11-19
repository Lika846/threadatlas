/**
 * What the Import page shows for the semantic index (M5.1b-2; plan §5; moved from Settings). Computed on the server,
 * so the browser receives only static text, counts and button states. Every message is a
 * fixed sentence with numbers filled in: never conversation text, ids, paths or native
 * error messages.
 */
import { DB_ERROR_DEFINITIONS, dbErrorMessage, type DbErrorCode } from "../../db/errors";
import { EMBEDDING_ERRORS, isEmbeddingErrorCode } from "../errors.ts";
import type { IndexingStatus } from "./service.ts";

export type Tone = "neutral" | "success" | "warning" | "error";

export type IndexView = {
  tone: Tone;
  message: string;
  counts: IndexingStatus["counts"];
  running: boolean;
  canStart: boolean;
  startLabel: "Start indexing" | "Resume indexing";
  canPause: boolean;
  pausing: boolean;
  canRetry: boolean;
};

const INDEX_CODE_MESSAGES: Record<string, string> = {
  INDEX_CONFIG_MISMATCH: "The inference process reported a different model version than this ThreadAtlas build. Restart ThreadAtlas and try again.",
  INDEXER_BUSY: "Another ThreadAtlas process is indexing this database.",
  INDEXER_LOCK_FAILED: "The indexing lock could not be taken safely. Try again.",
  WRITE_LOCK_FAILED: "The database write lock could not be taken safely. Try again.",
  IMPORT_BUSY: "An import or deletion is running. Try again when it has finished.",
  IMPORT_LOCK_FAILED: "The database write lock could not be taken safely. Try again.",
};
const UNKNOWN = "Indexing stopped because of an unexpected error. Try again.";

/** The static message for a code from the indexer, the inference host or the database. */
export function codeMessage(code: string): string {
  if (isEmbeddingErrorCode(code)) return EMBEDDING_ERRORS[code];
  if (Object.hasOwn(DB_ERROR_DEFINITIONS, code)) return dbErrorMessage(code as DbErrorCode);
  return INDEX_CODE_MESSAGES[code] ?? UNKNOWN;
}

const n = (x: number) => x.toLocaleString("en-US");
const conversations = (x: number) => `${n(x)} ${x === 1 ? "conversation" : "conversations"}`;

export function viewOf(s: IndexingStatus): IndexView {
  const c = s.counts;
  const failures = c.failed + c.tooLarge;
  const modelOk = s.model === "ok";
  const notStarted = s.lastRun?.outcome === "not-started" && s.lastRun.code ? s.lastRun.code : null;

  const [tone, message] = ((): [Tone, string] => {
    switch (s.state) {
      case "indexing":
        return ["neutral", `Indexing… ${n(c.indexed)} of ${conversations(c.conversations)} indexed.`];
      case "waiting-for-import":
        return ["neutral", "Waiting for an import to finish…"];
      case "pausing":
        return ["neutral", "Pausing after the current batch…"];
      case "indexing-elsewhere":
        return ["neutral", "Another ThreadAtlas window or process is indexing this database."];
    }
    if (s.model === "missing") return ["warning", "The semantic model is not installed. Run `npm run model:fetch`, then reload this page."];
    if (s.model === "invalid") return ["error", EMBEDDING_ERRORS.MODEL_INVALID];
    if (s.model === "dir-invalid") return ["error", EMBEDDING_ERRORS.MODEL_DIR_INVALID];
    if (notStarted) return ["error", codeMessage(notStarted)];
    switch (s.state) {
      case "interrupted":
        return ["warning", `Indexing was interrupted (ThreadAtlas stopped). ${conversations(c.waiting)} will be indexed at the next Start.`];
      case "incompatible":
        return ["warning", "The index was built with a different model or settings. It will be rebuilt at the next Start."];
      case "run-failed":
        return ["error", `Indexing stopped. ${codeMessage(s.lastErrorCode ?? "")}`];
    }
    if (c.conversations === 0) return ["neutral", "There are no imported conversations to index yet."];
    if (s.lastRun?.outcome === "paused" && c.waiting > 0) return ["neutral", `Paused. ${conversations(c.waiting)} waiting.`];
    if (c.waiting > 0) return ["neutral", `${conversations(c.waiting)} not indexed yet.`];
    if (failures > 0) {
      const tooLarge = c.tooLarge > 0 ? ` (${n(c.tooLarge)} too large to index)` : "";
      return ["warning", `Indexed ${conversations(c.indexed)}. ${n(failures)} failed${tooLarge}; keyword search still finds them.`];
    }
    return ["success", `All ${conversations(c.conversations)} are indexed.`];
  })();

  const workToDo = c.waiting > 0 || s.state === "incompatible" || s.state === "never-indexed" || s.state === "interrupted" || s.state === "run-failed";
  return {
    tone,
    message,
    counts: c,
    running: s.running,
    canStart: !s.running && s.state !== "indexing-elsewhere" && modelOk && c.conversations > 0 && workToDo,
    startLabel: c.indexed > 0 || s.lastRun?.outcome === "paused" ? "Resume indexing" : "Start indexing",
    canPause: s.running && s.state !== "pausing",
    pausing: s.state === "pausing",
    canRetry: failures > 0 && s.state !== "indexing-elsewhere",
  };
}
