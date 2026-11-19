import { describe, expect, it } from "vitest";
import { ALL_FIXTURES, fixtureText } from "../../../../tests/helpers/fixtures";
import type { NormalizedNode } from "../types";
import { parseExportText } from "../validate-export";
import { conversationColumns, messageRow, nodeFromRow } from "./rows";

const NODE_KEYS: (keyof NormalizedNode)[] = [
  "sourceNodeId", "sourceMessageId", "parentSourceNodeId", "siblingIndex", "pathIndex", "isStructural",
  "isMalformed", "role", "authorName", "contentType", "contentText", "codeLanguage", "hasUnsupportedParts",
  "rawContentJson", "isHidden", "status", "createdAt",
];

describe("row mapping", () => {
  it("covers every NormalizedNode field exactly once", () => {
    const sample: NormalizedNode = {
      sourceNodeId: "a", sourceMessageId: "b", parentSourceNodeId: "c", siblingIndex: 1, pathIndex: 2,
      isStructural: false, isMalformed: true, role: "user", authorName: "d", contentType: "e", contentText: "f",
      codeLanguage: "g", hasUnsupportedParts: true, rawContentJson: "{}", isHidden: true, status: "h", createdAt: 3.5,
    };
    expect(Object.keys(sample).sort()).toEqual([...NODE_KEYS].sort());
    const row = messageRow("conv", sample);
    // One column per field, plus the conversation link; all values distinct, so nothing is crossed.
    expect(Object.keys(row)).toHaveLength(NODE_KEYS.length + 1);
    expect(nodeFromRow(row)).toEqual(sample);
  });

  it.each(ALL_FIXTURES)("round-trips every node of %s", (name) => {
    const res = parseExportText(fixtureText(name));
    if (!res.ok) return; // file-level fixtures have no nodes
    for (const c of res.conversations) {
      const cols = conversationColumns(c);
      expect(cols).toMatchObject({
        title: c.title,
        createdAtSec: c.createdAt,
        updatedAtSec: c.updatedAt,
        contentHash: c.contentHash,
        parserVersion: c.parserVersion,
        nodeCount: c.nodes.length,
      });
      for (const n of c.nodes) {
        const { conversationId, ...rest } = messageRow("conv-x", n);
        expect(conversationId).toBe("conv-x");
        expect(nodeFromRow(rest)).toEqual(n);
      }
    }
  });
});
