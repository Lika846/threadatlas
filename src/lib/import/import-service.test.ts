import { describe, expect, it } from "vitest";
import { MAX_FILENAME_LENGTH, sanitizeFilename } from "./import-service";

describe("sanitizeFilename", () => {
  it.each([
    ["conversations.json", "conversations.json"],
    ["/Users/someone/Downloads/conversations.json", "conversations.json"],
    ["C:\\Users\\someone\\conversations.json", "conversations.json"],
    ["con\u0000ver\u001fsa\u007ftions\u009f.json", "conversations.json"],
    ["evil\u202enosj.exe", "evilnosj.exe"],
    ["\u2066a\u2069b\u200e\u200f.json", "ab.json"],
    ["  spaced.json  ", "spaced.json"],
    ["", "upload.json"],
    ["/", "upload.json"],
    ["\u0000\u0001", "upload.json"],
  ])("%j → %j", (input, expected) => {
    expect(sanitizeFilename(input)).toBe(expected);
  });

  it("keeps at most 255 code points, never splitting a character", () => {
    expect(Array.from(sanitizeFilename("a".repeat(1_000)))).toHaveLength(MAX_FILENAME_LENGTH);
    const emoji = sanitizeFilename("\u{1F600}".repeat(300));
    expect(Array.from(emoji)).toHaveLength(MAX_FILENAME_LENGTH);
    expect(emoji).toBe("\u{1F600}".repeat(255));
  });
});
