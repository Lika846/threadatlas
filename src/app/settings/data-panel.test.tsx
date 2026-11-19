import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The Server Actions are not called during a render; stub their module.
vi.mock("./actions", () => ({ deleteAllAction: async () => null, finishCleanupAction: async () => null }));
const { DataPanel } = await import("./data-panel");

const empty = { conversations: 0, messages: 0, imports: 0 };

describe("DataPanel (M1.7)", () => {
  it.each([true, false, null])("offers Finish storage cleanup whenever there is no imported data (evidence %s)", (evidence) => {
    const html = renderToStaticMarkup(<DataPanel counts={empty} cleanupMayBeIncomplete={evidence} />);
    expect(html).toContain("Finish storage cleanup");
    expect(html).toContain("It never deletes records");
    expect(html).not.toContain("Delete all imported data");
    expect(html.includes("Cleanup may be incomplete")).toBe(evidence === true);
    // Absence of evidence is never presented as proof.
    if (evidence !== true) expect(html).toContain("does not prove that an earlier cleanup finished");
  });

  it("offers deletion (button disabled until DELETE is typed) and no cleanup while data exists", () => {
    const html = renderToStaticMarkup(<DataPanel counts={{ conversations: 2, messages: 1, imports: 1 }} cleanupMayBeIncomplete={null} />);
    expect(html).toMatch(/<button type="submit" disabled=""[^>]*>Delete all imported data<\/button>/);
    expect(html).toContain("2</strong> conversations");
    expect(html).toContain("1</strong> message and");
    expect(html).not.toContain("Finish storage cleanup");
  });
});
