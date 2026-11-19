/**
 * The first-run sequence on the home page (phase 3): get the export → import it → index it for
 * meaning → explore. Pure: from the indexing status (counts and model state, no content) to
 * what each step says and which one is next. The home page renders it; the steps check
 * themselves off from real state, so the page also serves returning users (partly indexed, a
 * new import waiting, everything ready).
 */
import type { IndexingStatus } from "../semantic/index/service.ts";

/** OpenAI's instructions for exporting ChatGPT data (linked from the first-run steps and the Import page). */
export const EXPORT_HELP_URL = "https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data";

export type StepId = "export" | "import" | "index" | "explore";
/** done; current (the next thing to do); available (can be used, but something comes first); waiting (needs an earlier step); blocked (needs the model). */
export type StepState = "done" | "current" | "available" | "waiting" | "blocked";

export type Step = { id: StepId; state: StepState };

export type Setup = {
  steps: Step[];
  /** The model needs installing (or replacing) before indexing can run. */
  model: IndexingStatus["model"];
  counts: IndexingStatus["counts"];
  /** Indexing is running in this or another process. */
  indexing: boolean;
  /** Everything that can be indexed is: nothing waiting or running. */
  allIndexed: boolean;
  /** Something is indexed, so the map, search by meaning and related conversations work. */
  canExplore: boolean;
};

export function setupOf(s: Pick<IndexingStatus, "counts" | "model" | "state" | "running">): Setup {
  const c = s.counts;
  const imported = c.conversations > 0;
  const indexing = s.running || s.state === "indexing" || s.state === "indexing-elsewhere" || s.state === "pausing" || s.state === "waiting-for-import";
  const allIndexed = imported && c.waiting === 0 && c.running === 0 && c.indexed > 0;
  const canExplore = c.indexed > 0;
  const indexState: StepState = !imported ? "waiting" : allIndexed ? "done" : s.model !== "ok" && !indexing ? "blocked" : "current";
  return {
    steps: [
      { id: "export", state: imported ? "done" : "current" },
      { id: "import", state: imported ? "done" : "current" },
      { id: "index", state: indexState },
      { id: "explore", state: allIndexed ? "current" : canExplore ? "available" : "waiting" },
    ],
    model: s.model,
    counts: c,
    indexing,
    allIndexed,
    canExplore,
  };
}
