import { describe, expect, it } from "vitest";
import { createLatestGate } from "./latest";

/** A request whose completion the test controls. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("createLatestGate", () => {
  it("only the latest ticket is current", () => {
    const g = createLatestGate();
    const a = g.begin();
    const b = g.begin();
    expect(g.isLatest(a)).toBe(false);
    expect(g.isLatest(b)).toBe(true);
    g.invalidate();
    expect(g.isLatest(b)).toBe(false);
  });

  it("reversed completion order: the older response arriving last is ignored", async () => {
    const g = createLatestGate();
    const shown: string[] = [];
    const search = async (label: string, response: Promise<string>) => {
      const ticket = g.begin();
      const value = await response;
      if (g.isLatest(ticket)) shown.push(`${label}:${value}`);
    };
    const first = deferred<string>();
    const second = deferred<string>();
    const p1 = search("first", first.promise);
    const p2 = search("second", second.promise);
    second.resolve("new results");
    await p2;
    first.resolve("old results");
    await p1;
    expect(shown).toEqual(["second:new results"]);
  });

  it("in-order completion: the older response is still ignored once a newer search started", async () => {
    const g = createLatestGate();
    const shown: string[] = [];
    const search = async (label: string, response: Promise<string>) => {
      const ticket = g.begin();
      const value = await response;
      if (g.isLatest(ticket)) shown.push(label + ":" + value);
    };
    const first = deferred<string>();
    const second = deferred<string>();
    const p1 = search("first", first.promise);
    const p2 = search("second", second.promise);
    first.resolve("old");
    await p1;
    expect(shown).toEqual([]);
    second.resolve("new");
    await p2;
    expect(shown).toEqual(["second:new"]);
  });

  it("invalidate (validation error or unmount) drops every outstanding response", async () => {
    const g = createLatestGate();
    const d = deferred<string>();
    const ticket = g.begin();
    g.invalidate();
    d.resolve("late");
    await d.promise;
    expect(g.isLatest(ticket)).toBe(false);
  });
});
