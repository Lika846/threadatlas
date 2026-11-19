/**
 * The semantic-index Server Actions refuse foreign requests before doing anything
 * (M5.1b-2): same checks as the other Settings actions. The service is stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let requestHeaders = new Headers();
vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));

const calls: string[] = [];
const view = { tone: "neutral", message: "m", counts: {}, running: false, canStart: true, startLabel: "Start indexing", canPause: false, pausing: false, canRetry: false };
vi.mock("@/lib/semantic/index/service", () => ({
  startIndexing: async () => (calls.push("start"), { outcome: "started" }),
  pauseIndexing: () => (calls.push("pause"), "pausing"),
  retryFailedConversations: async () => (calls.push("retry"), { ok: true, count: 2 }),
  getIndexingStatus: async () => (calls.push("status"), {}),
}));
vi.mock("@/lib/semantic/index/messages", () => ({ viewOf: () => view, codeMessage: (c: string) => `message for ${c}` }));

const actions = await import("./semantic-actions");
const all = [actions.semanticIndexStatusAction, actions.startIndexingAction, actions.pauseIndexingAction, actions.retryFailedAction];

const sameOrigin = () => new Headers({ host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "sec-fetch-site": "same-origin", "next-action": "abc" });

beforeEach(() => {
  calls.length = 0;
});

describe("semantic-index Server Actions", () => {
  it.each([
    ["a foreign Origin", { host: "127.0.0.1:3000", origin: "http://evil.example", "next-action": "abc" }],
    ["no Origin", { host: "127.0.0.1:3000", "next-action": "abc" }],
    ["a cross-site fetch", { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "sec-fetch-site": "cross-site", "next-action": "abc" }],
    ["no Next-Action header", { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" }],
    ["a non-loopback Host", { host: "evil.example", origin: "http://evil.example", "next-action": "abc" }],
  ])("refuse %s and touch nothing", async (_label, h) => {
    requestHeaders = new Headers(h);
    for (const a of all) expect(await a()).toEqual({ view: null, notice: { tone: "error", text: "The request was rejected." } });
    expect(calls).toEqual([]);
  });

  it("run for a same-origin request and return the view with a static notice", async () => {
    requestHeaders = sameOrigin();
    expect(await actions.startIndexingAction()).toEqual({ view, notice: { tone: "neutral", text: "Indexing started." } });
    expect(await actions.pauseIndexingAction()).toEqual({ view, notice: { tone: "neutral", text: "Pausing after the current batch…" } });
    expect(await actions.retryFailedAction()).toEqual({ view, notice: { tone: "neutral", text: "2 failed conversations will be indexed again at the next Start." } });
    expect(await actions.semanticIndexStatusAction()).toEqual({ view, notice: null });
    expect(calls).toEqual(["start", "status", "pause", "status", "retry", "status", "status"]);
  });
});
