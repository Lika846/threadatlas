import { describe, expect, it } from "vitest";
import { linkedMessageId } from "./linked-message";

describe("linkedMessageId (M2.3 polish)", () => {
  it.each([
    ["#m-1", "m-1"],
    ["#m-2", "m-2"],
    ["#m-1351", "m-1351"],
    ["#m-999999999", "m-999999999"],
  ])("%s → %s", (hash, id) => {
    expect(linkedMessageId(hash)).toBe(id);
  });

  it.each([
    "", "#", "m-2", "#m-", "#m-0", "#m-01", "#m-1000000000", "#m-2 ", "#m-2x", "#m-2#m-3", "#M-2", "#m--2", "#m-2.5",
    "#messages-title", "#main-content", "#m-2,article", "#m-2\"]", "#%6D-2", "#m-٢",
  ])("rejects %j", (hash) => {
    expect(linkedMessageId(hash)).toBeNull();
  });
});
