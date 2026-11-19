import { describe, expect, it } from "vitest";
import { DELETE_CONFIRMATION_PHRASE, isDeleteConfirmed } from "./confirmation";

describe("isDeleteConfirmed (Q7 → A76)", () => {
  it("accepts exactly DELETE", () => {
    expect(DELETE_CONFIRMATION_PHRASE).toBe("DELETE");
    expect(isDeleteConfirmed("DELETE")).toBe(true);
  });

  it.each([["delete"], ["Delete"], [" DELETE"], ["DELETE "], ["DELETE\n"], ["DELET"], ["DELETEE"], [""], ["ＤＥＬＥＴＥ"], [null], [undefined], [["DELETE"]], [{ toString: (): string => "DELETE" }]])(
    "rejects %j",
    (value) => {
      expect(isDeleteConfirmed(value)).toBe(false);
    },
  );
});
