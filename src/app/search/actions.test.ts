import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The search Server Action's own logic (M2.3): request check first, untrusted
 * arguments, fixed outcomes, no logging. The query layer is stubbed here; it
 * has its own integration tests, and e2e/search.spec.ts runs the real thing.
 */

const state = vi.hoisted(() => ({
  headers: new Headers(),
  calls: [] as unknown[][],
  impl: (async () => ({ status: "ok", results: [], total: 0, page: 1, totalPages: 1 })) as (...a: unknown[]) => Promise<unknown>,
}));

vi.mock("next/headers", () => ({ headers: async () => state.headers }));
vi.mock("@/lib/db/client", () => ({ getDb: () => ({ marker: "reader" }) }));
vi.mock("@/lib/search/search", async (orig) => ({
  ...(await orig<typeof import("@/lib/search/search")>()),
  searchConversations: (...args: unknown[]) => {
    state.calls.push(args);
    return state.impl(...args);
  },
}));

const { searchAction } = await import("./actions");

const sameOrigin = () =>
  new Headers({ host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "sec-fetch-site": "same-origin", "next-action": "7f00aa" });

beforeEach(() => {
  state.headers = sameOrigin();
  state.calls = [];
  state.impl = async () => ({ status: "ok", results: [], total: 0, page: 1, totalPages: 1 });
});

describe("searchAction", () => {
  it.each<[string, () => Headers]>([
    ["missing Origin", () => { const h = sameOrigin(); h.delete("origin"); return h; }],
    ["foreign Origin", () => { const h = sameOrigin(); h.set("origin", "http://evil.example"); return h; }],
    ["cross-site fetch", () => { const h = sameOrigin(); h.set("sec-fetch-site", "cross-site"); return h; }],
    ["non-loopback Host", () => { const h = sameOrigin(); h.set("host", "evil.example"); h.set("origin", "http://evil.example"); return h; }],
    ["missing Next-Action", () => { const h = sameOrigin(); h.delete("next-action"); return h; }],
  ])("refuses a request with %s, before searching", async (_label, make) => {
    state.headers = make();
    expect(await searchAction("anything", 1)).toEqual({ kind: "error", code: "REQUEST_FORBIDDEN" });
    expect(state.calls).toEqual([]);
  });

  it("passes the query unchanged and the page through pageArgument, on the reader", async () => {
    await searchAction("budget draft", 3);
    await searchAction({ not: "a string" }, "2");
    await searchAction("x", -5);
    expect(state.calls).toEqual([
      [{ marker: "reader" }, "budget draft", "3"],
      [{ marker: "reader" }, { not: "a string" }, "2"],
      [{ marker: "reader" }, "x", "1"],
    ]);
  });

  it("maps outcomes to the view and unexpected failures to INTERNAL_ERROR, logging nothing", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k));
    try {
      state.impl = async () => ({ status: "error", code: "DB_NOT_MIGRATED" });
      expect(await searchAction("q", 1)).toEqual({ kind: "error", code: "DB_NOT_MIGRATED" });
      state.impl = async () => ({ status: "invalid", rejection: { reason: "too_long", limit: 256, length: 300 } });
      expect(await searchAction("q", 1)).toEqual({ kind: "invalid", rejection: { reason: "too_long", limit: 256, length: 300 } });
      state.impl = async () => {
        throw new Error("secret content in an error");
      };
      expect(await searchAction("secret", 1)).toEqual({ kind: "error", code: "INTERNAL_ERROR" });
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  it("a failing headers() call is a refusal", async () => {
    state.headers = { get: () => { throw new Error("no request scope"); } } as unknown as Headers;
    expect(await searchAction("q", 1)).toEqual({ kind: "error", code: "REQUEST_FORBIDDEN" });
  });
});
