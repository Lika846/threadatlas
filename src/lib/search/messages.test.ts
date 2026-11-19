import { describe, expect, it } from "vitest";
import { DB_ERROR_DEFINITIONS, type DbErrorCode } from "../db/errors";
import { rejectionMessage, resultAnnouncement, searchErrorMessage } from "./messages";
import { parseSearchQuery, type QueryRejection } from "./query";

const rejectionOf = (input: unknown): QueryRejection => {
  const r = parseSearchQuery(input);
  if (r.ok) throw new Error("expected a rejection");
  return r.rejection;
};

describe("search messages", () => {
  it("explains every rejection with its numbers and without quoting the query", () => {
    const long = "secretword ".repeat(30); // 330 characters; 329 after trimming
    const cases: [unknown, RegExp][] = [
      ["", /Enter a word or phrase/],
      ["!!!", /no words to look for/],
      [long, /is 329 characters long\. The limit is 256/],
      [Array.from({ length: 17 }, (_, i) => `secret${i}`).join(" "), /has 17 words or phrases\. The limit is 16/],
      ["s*", /at least 2 letters or digits before \*/],
    ];
    for (const [input, expected] of cases) {
      const message = rejectionMessage(rejectionOf(input));
      expect(message).toMatch(expected);
      expect(message).not.toContain("secret");
    }
  });

  it("has a fixed, content-free message for every error code", () => {
    const codes = [...(Object.keys(DB_ERROR_DEFINITIONS) as DbErrorCode[]), "REQUEST_FORBIDDEN", "INTERNAL_ERROR"] as const;
    for (const code of codes) expect(searchErrorMessage(code).length).toBeGreaterThan(10);
    expect(searchErrorMessage("DB_NOT_MIGRATED")).toContain("npm run db:deploy");
    expect(searchErrorMessage("DB_BUSY")).toMatch(/busy/);
    expect(searchErrorMessage("REQUEST_FORBIDDEN")).toMatch(/refused/);
    expect(searchErrorMessage("DB_CORRUPT")).toMatch(/could not be read/);
  });

  it("announces counts and page positions only", () => {
    expect(resultAnnouncement({ total: 0, page: 1, totalPages: 1, first: 0, last: 0 })).toBe("No conversations match.");
    expect(resultAnnouncement({ total: 1, page: 1, totalPages: 1, first: 1, last: 1 })).toBe("1 conversation matches.");
    expect(resultAnnouncement({ total: 12, page: 1, totalPages: 1, first: 1, last: 12 })).toBe("12 conversations match.");
    expect(resultAnnouncement({ total: 87, page: 2, totalPages: 5, first: 21, last: 40 })).toBe("87 conversations match. Page 2 of 5, results 21–40.");
    expect(resultAnnouncement({ total: 2_500, page: 1, totalPages: 125, first: 1, last: 20 })).toBe("2,500 conversations match. Page 1 of 125, results 1–20.");
  });
});
