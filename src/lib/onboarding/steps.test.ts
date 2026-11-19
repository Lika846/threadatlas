import { describe, expect, it } from "vitest";
import { setupOf } from "./steps";

const counts = (o: Partial<{ conversations: number; indexed: number; waiting: number; running: number; failed: number; tooLarge: number }> = {}) => ({
  conversations: 0, indexed: 0, waiting: 0, running: 0, failed: 0, tooLarge: 0, chunks: 0, ...o,
});
const states = (s: ReturnType<typeof setupOf>) => Object.fromEntries(s.steps.map((x) => [x.id, x.state]));

describe("setupOf (first-run steps)", () => {
  it("empty archive: get the export and import it", () => {
    expect(states(setupOf({ counts: counts(), model: "ok", state: "never-indexed", running: false }))).toEqual({ export: "current", import: "current", index: "waiting", explore: "waiting" });
  });

  it("imported, model installed, nothing indexed: index next", () => {
    const s = setupOf({ counts: counts({ conversations: 40, waiting: 40 }), model: "ok", state: "never-indexed", running: false });
    expect(states(s)).toEqual({ export: "done", import: "done", index: "current", explore: "waiting" });
    expect(s.canExplore).toBe(false);
  });

  it("imported but the model is missing: indexing is blocked until it is installed", () => {
    expect(states(setupOf({ counts: counts({ conversations: 40, waiting: 40 }), model: "missing", state: "never-indexed", running: false })).index).toBe("blocked");
    expect(states(setupOf({ counts: counts({ conversations: 40, waiting: 40 }), model: "invalid", state: "never-indexed", running: false })).index).toBe("blocked");
  });

  it("partly indexed (or indexing): continue indexing, and exploring already works", () => {
    const s = setupOf({ counts: counts({ conversations: 40, indexed: 25, waiting: 15 }), model: "ok", state: "waiting", running: false });
    expect(states(s)).toEqual({ export: "done", import: "done", index: "current", explore: "available" });
    expect(setupOf({ counts: counts({ conversations: 40, indexed: 25, running: 2, waiting: 13 }), model: "ok", state: "indexing", running: true }).indexing).toBe(true);
  });

  it("everything indexed: explore is next (failures don't block it)", () => {
    const s = setupOf({ counts: counts({ conversations: 40, indexed: 38, failed: 2 }), model: "ok", state: "finished-with-failures", running: false });
    expect(states(s)).toEqual({ export: "done", import: "done", index: "done", explore: "current" });
    expect(s.allIndexed).toBe(true);
  });

  it("a new import after indexing brings indexing back as the next step", () => {
    expect(states(setupOf({ counts: counts({ conversations: 45, indexed: 40, waiting: 5 }), model: "ok", state: "waiting", running: false })).index).toBe("current");
  });
});
