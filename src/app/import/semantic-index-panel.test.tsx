import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { IndexView } from "@/lib/semantic/index/messages";

// The Server Actions are not called during a render; stub their modules.
vi.mock("../settings/actions", () => ({ deleteAllAction: async () => null, finishCleanupAction: async () => null }));
vi.mock("./semantic-actions", () => ({
  semanticIndexStatusAction: async () => ({ view: null, notice: null }),
  startIndexingAction: async () => ({ view: null, notice: null }),
  pauseIndexingAction: async () => ({ view: null, notice: null }),
  retryFailedAction: async () => ({ view: null, notice: null }),
}));
const { SemanticIndexPanel } = await import("./semantic-index-panel");

const view = (over: Partial<IndexView> = {}): IndexView => ({
  tone: "neutral",
  message: "10 conversations not indexed yet.",
  counts: { conversations: 10, indexed: 0, waiting: 10, running: 0, failed: 0, tooLarge: 0, chunks: 0 },
  running: false,
  canStart: true,
  startLabel: "Start indexing",
  canPause: false,
  pausing: false,
  canRetry: false,
  ...over,
});

describe("SemanticIndexPanel (M5.1b-2)", () => {
  it("shows the status as a live region, the counts and an enabled Start", () => {
    const html = renderToStaticMarkup(<SemanticIndexPanel initial={view()} />);
    expect(html).toMatch(/role="status" aria-live="polite"[^>]*>10 conversations not indexed yet\.</);
    expect(html).toContain(">0 of 10<");
    expect(html).toMatch(/<button type="button"[^>]*>Start indexing<\/button>/);
    expect(html).not.toContain(">Pause<");
    expect(html).not.toContain("Retry failed");
  });

  it("while running: Start disabled, Pause shown; Pausing… while pausing", () => {
    const running = renderToStaticMarkup(<SemanticIndexPanel initial={view({ running: true, canStart: false, canPause: true, counts: { ...view().counts, running: 1 } })} />);
    expect(running).toMatch(/<button type="button" disabled=""[^>]*>Start indexing<\/button>/);
    expect(running).toMatch(/<button type="button"[^>]*>Pause<\/button>/);
    const pausing = renderToStaticMarkup(<SemanticIndexPanel initial={view({ running: true, canStart: false, canPause: false, pausing: true })} />);
    expect(pausing).toMatch(/<button type="button" disabled=""[^>]*>Pausing…<\/button>/);
  });

  it("offers Retry failed when there are failures, with too-large ones counted", () => {
    const html = renderToStaticMarkup(<SemanticIndexPanel initial={view({ canRetry: true, counts: { ...view().counts, failed: 2, tooLarge: 1 } })} />);
    expect(html).toContain("Retry failed");
    expect(html).toContain(">3 (1 too large)<");
  });

  it("says so when the status cannot be read", () => {
    expect(renderToStaticMarkup(<SemanticIndexPanel initial={null} />)).toContain('role="alert"');
  });
});
