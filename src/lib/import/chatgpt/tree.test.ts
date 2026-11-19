import { describe, expect, it } from "vitest";
import { buildTree, OversizedNodeIdError } from "./tree";

const NOW = Date.UTC(2026, 10, 3);

const msg = (role: string, text: string, createTime?: number) => ({
  author: { role },
  ...(createTime === undefined ? {} : { create_time: createTime }),
  content: { content_type: "text", parts: [text] },
});
const node = (parent: string | null, children: string[], message: unknown = null) => ({
  parent,
  children,
  message,
});

function path(mapping: Record<string, unknown>, current?: string | null) {
  const t = buildTree(mapping, current, NOW);
  return {
    ...t,
    path: t.nodes
      .filter((n) => n.pathIndex !== null)
      .sort((a, b) => a.pathIndex! - b.pathIndex!)
      .map((n) => n.sourceNodeId),
    codes: t.issues.map((i) => i.code),
  };
}

describe("buildTree: parent links (A23)", () => {
  it("never infers a parent from children[]", () => {
    // b has no parent, but a lists it: b stays a root.
    const t = path({ a: node(null, ["b"], msg("user", "x")), b: node(null, [], msg("user", "y")) }, "b");
    expect(t.path).toEqual(["b"]);
    expect(t.nodes.find((n) => n.sourceNodeId === "b")!.parentSourceNodeId).toBeNull();
    expect(t.codes).toEqual(expect.arrayContaining(["NODE_CHILD_PARENT_MISMATCH", "MULTIPLE_ROOTS"]));
  });

  it("keeps a dangling parent reference exactly as exported", () => {
    const t = path({ a: node("missing", [], msg("user", "x")) }, "a");
    expect(t.nodes[0]!.parentSourceNodeId).toBe("missing");
    expect(t.path).toEqual(["a"]);
    expect(t.codes).toContain("NODE_PARENT_NOT_IN_MAPPING");
  });

  it("orders listed children first, then unlisted ones in mapping order", () => {
    const t = path({
      r: node(null, ["c2"]),
      c1: node("r", [], msg("user", "1")),
      c2: node("r", [], msg("user", "2")),
      c3: node("r", [], msg("user", "3")),
    });
    const idx = Object.fromEntries(t.nodes.map((n) => [n.sourceNodeId, n.siblingIndex]));
    expect(idx).toMatchObject({ c2: 0, c1: 1, c3: 2 });
    expect(t.codes.filter((c) => c === "NODE_NOT_LISTED_BY_PARENT")).toHaveLength(2);
  });

  it("ignores a child listed twice", () => {
    const t = path({ r: node(null, ["c", "c"]), c: node("r", [], msg("user", "x")) });
    expect(t.nodes.find((n) => n.sourceNodeId === "c")!.siblingIndex).toBe(0);
    expect(t.issues).toEqual([{ code: "PATH_FALLBACK" }]);
  });

  it("handles a node that is its own parent without looping", () => {
    const t = path({ a: node("a", ["a"], msg("user", "x")) }, "a");
    expect(t.path).toEqual(["a"]);
    expect(t.codes).toEqual(expect.arrayContaining(["TREE_CYCLE", "PATH_CYCLE"]));
  });

  it("stores every object node, including off-path and structural ones (R22)", () => {
    const t = path({ r: node(null, ["a", "b"]), a: node("r", [], msg("user", "a")), b: node("r", [], msg("user", "b")) }, "a");
    expect(t.nodes.map((n) => n.sourceNodeId)).toEqual(["r", "a", "b"]);
    expect(t.nodes.find((n) => n.sourceNodeId === "b")!.pathIndex).toBeNull();
    expect(t.nodes.find((n) => n.sourceNodeId === "r")).toMatchObject({ isStructural: true, pathIndex: 0 });
  });

  it("documents JavaScript key order: integer-like keys come first", () => {
    const mapping = JSON.parse('{"b":{"parent":null,"children":[]},"2":{"parent":null,"children":[]}}');
    expect(buildTree(mapping, null, NOW).nodes.map((n) => n.sourceNodeId)).toEqual(["2", "b"]);
  });
});

describe("buildTree: default path (A25)", () => {
  it("current_node may end the path on an inner node", () => {
    const t = path({ r: node(null, ["a"]), a: node("r", ["b"], msg("user", "a")), b: node("a", [], msg("assistant", "b")) }, "a");
    expect(t.path).toEqual(["r", "a"]);
    expect(t.pathStrategy).toBe("current_node");
    expect(t.codes).toEqual([]);
  });

  it("latest_leaf ignores structural leaves and leaves without a valid time", () => {
    const t = path({
      r: node(null, ["a", "s", "b"]),
      a: node("r", [], msg("assistant", "a", 10)),
      s: node("r", []), // structural leaf
      b: node("r", [], { ...msg("assistant", "b"), create_time: "bad" }),
    });
    expect(t.pathStrategy).toBe("latest_leaf");
    expect(t.path).toEqual(["r", "a"]);
  });

  it("latest_leaf only considers leaves, not inner nodes with later times", () => {
    const t = path({
      r: node(null, ["a"]),
      a: node("r", ["b"], msg("user", "a", 99)),
      b: node("a", [], msg("assistant", "b", 5)),
    });
    expect(t.path).toEqual(["r", "a", "b"]);
  });

  it("falls back to last_child and warns, with the strategy recorded", () => {
    const t = path({ r: node(null, ["a", "b"]), a: node("r", [], msg("user", "a")), b: node("r", [], msg("user", "b")) });
    expect(t.pathStrategy).toBe("last_child");
    expect(t.path).toEqual(["r", "b"]);
    expect(t.codes).toEqual(["PATH_FALLBACK"]);
  });

  it("reports PATH_NONE for an empty mapping", () => {
    const t = path({});
    expect(t.pathStrategy).toBe("none");
    expect(t.nodes).toEqual([]);
    expect(t.codes).toEqual(["PATH_NONE"]);
  });

  it("does not warn about the fallback when current_node is used", () => {
    expect(path({ a: node(null, [], msg("user", "a")) }, "a").codes).toEqual([]);
  });
});

describe("buildTree: malformed structure (A24)", () => {
  it("drops non-object entries and names them by key only", () => {
    const t = path({ bad: "text", a: node(null, [], msg("user", "a")) }, "a");
    expect(t.nodes.map((n) => n.sourceNodeId)).toEqual(["a"]);
    expect(t.issues).toContainEqual({ code: "NODE_NOT_OBJECT", nodeId: "bad" });
  });

  it("treats a missing children field as no children, without a warning", () => {
    const t = path({ a: { parent: null, message: msg("user", "a") } }, "a");
    expect(t.codes).toEqual([]);
  });
});

describe("buildTree: sibling placement and traversal (F1 regression)", () => {
  it("places unlisted children after listed ones, per parent, warning once each in mapping order", () => {
    const t = path({
      r: node(null, ["b2", "a1"]),
      a: node("r", ["a2"], msg("user", "a")),
      b: node("r", [], msg("user", "b")),
      a1: node("a", [], msg("user", "a1")),
      a2: node("a", [], msg("user", "a2")),
      b2: node("b", [], msg("user", "b2")),
      a3: node("a", [], msg("user", "a3")),
    });
    const idx = Object.fromEntries(t.nodes.map((n) => [n.sourceNodeId, n.siblingIndex]));
    // r lists b2 (parent b) and a1 (parent a): both mismatches, so r keeps only unlisted a, b.
    expect(idx).toMatchObject({ a: 0, b: 1, a2: 0, a1: 1, a3: 2, b2: 0 });
    expect(t.issues.filter((i) => i.code === "NODE_NOT_LISTED_BY_PARENT")).toEqual([
      { code: "NODE_NOT_LISTED_BY_PARENT", nodeId: "a", relatedNodeId: "r" },
      { code: "NODE_NOT_LISTED_BY_PARENT", nodeId: "b", relatedNodeId: "r" },
      { code: "NODE_NOT_LISTED_BY_PARENT", nodeId: "a1", relatedNodeId: "a" },
      { code: "NODE_NOT_LISTED_BY_PARENT", nodeId: "b2", relatedNodeId: "b" },
      { code: "NODE_NOT_LISTED_BY_PARENT", nodeId: "a3", relatedNodeId: "a" },
    ]);
    expect(t.issues.filter((i) => i.code === "NODE_CHILD_PARENT_MISMATCH")).toEqual([
      { code: "NODE_CHILD_PARENT_MISMATCH", nodeId: "b2", relatedNodeId: "r" },
      { code: "NODE_CHILD_PARENT_MISMATCH", nodeId: "a1", relatedNodeId: "r" },
    ]);
  });

  it("does not warn for a child its parent lists, even when listed after unlisted siblings in the mapping", () => {
    const t = path({ c1: node("r", [], msg("user", "1")), c2: node("r", [], msg("user", "2")), r: node(null, ["c2"]) });
    const idx = Object.fromEntries(t.nodes.map((n) => [n.sourceNodeId, n.siblingIndex]));
    expect(idx).toMatchObject({ c2: 0, c1: 1 });
    expect(t.issues.filter((i) => i.code === "NODE_NOT_LISTED_BY_PARENT")).toEqual([
      { code: "NODE_NOT_LISTED_BY_PARENT", nodeId: "c1", relatedNodeId: "r" },
    ]);
  });

  it("reaches every node from several roots and reports the first unreachable node of a cycle", () => {
    const t = path({
      r1: node(null, ["x"]),
      x: node("r1", [], msg("user", "x")),
      p: node("q", ["q"], msg("user", "p")),
      q: node("p", ["p"], msg("user", "q")),
      r2: node(null, [], msg("user", "r2")),
    });
    expect(t.issues.filter((i) => i.code === "TREE_CYCLE")).toEqual([{ code: "TREE_CYCLE", nodeId: "p" }]);
    expect(t.codes).toContain("MULTIPLE_ROOTS");
  });
});

/**
 * Large synthetic mappings. These check results, not speed: there is no
 * wall-clock assertion. The explicit timeout is only a coarse guard, many
 * times the observed run time (about 1–2 s), so that a return to quadratic
 * behaviour fails instead of hanging the suite. Before F1, 200,000 unlisted
 * siblings took about 35 s and then crashed with a RangeError (the child list
 * was spread into `queue.push(...)`).
 */
describe("buildTree: large mappings complete (F1)", () => {
  const LARGE = 200_000;
  const GUARD_MS = 30_000;

  it(`handles ${LARGE.toLocaleString("en")} unlisted siblings`, () => {
    const mapping: Record<string, unknown> = { r: node(null, []) };
    for (let i = 0; i < LARGE; i++) mapping[`c${i}`] = node("r", [], null);
    const t = buildTree(mapping, null, NOW);
    expect(t.nodes).toHaveLength(LARGE + 1);
    expect(t.nodes.every((n, i) => i === 0 || n.siblingIndex === i - 1)).toBe(true);
    expect(t.issues.filter((i) => i.code === "NODE_NOT_LISTED_BY_PARENT")).toHaveLength(LARGE);
    expect(t.pathStrategy).toBe("last_child");
    expect(t.nodes.find((n) => n.pathIndex === 1)!.sourceNodeId).toBe(`c${LARGE - 1}`);
  }, GUARD_MS);

  it(`handles ${LARGE.toLocaleString("en")} listed siblings`, () => {
    const keys = Array.from({ length: LARGE }, (_, i) => `c${i}`);
    const mapping: Record<string, unknown> = { r: node(null, keys) };
    for (const k of keys) mapping[k] = node("r", [], null);
    const t = buildTree(mapping, null, NOW);
    expect(t.nodes.every((n, i) => i === 0 || n.siblingIndex === i - 1)).toBe(true);
    expect(t.issues).toEqual([{ code: "PATH_FALLBACK" }]);
  }, GUARD_MS);

  it(`handles a ${LARGE.toLocaleString("en")}-node chain`, () => {
    const mapping: Record<string, unknown> = {};
    for (let i = 0; i < LARGE; i++) {
      mapping[`n${i}`] = node(i === 0 ? null : `n${i - 1}`, i === LARGE - 1 ? [] : [`n${i + 1}`], msg("user", "x"));
    }
    const t = buildTree(mapping, `n${LARGE - 1}`, NOW);
    expect(t.nodes.every((n, i) => n.pathIndex === i)).toBe(true);
    expect(t.issues).toEqual([]);
  }, GUARD_MS);

  it(`terminates on a ${LARGE.toLocaleString("en")}-node cycle`, () => {
    const mapping: Record<string, unknown> = {};
    for (let i = 0; i < LARGE; i++) {
      mapping[`n${i}`] = node(`n${(i + LARGE - 1) % LARGE}`, [`n${(i + 1) % LARGE}`], msg("user", "x"));
    }
    const t = buildTree(mapping, "n0", NOW);
    expect(t.issues.filter((i) => i.code === "TREE_CYCLE")).toEqual([{ code: "TREE_CYCLE", nodeId: "n0" }]);
    expect(t.issues.filter((i) => i.code === "PATH_CYCLE")).toHaveLength(1);
    expect(t.nodes.filter((n) => n.pathIndex !== null)).toHaveLength(LARGE);
  }, GUARD_MS);
});

describe("buildTree: identifier length limit (Q12)", () => {
  const long = (n: number, ch = "k") => ch.repeat(n);

  it.each([511, 512])("keeps a node whose key has %i characters", (n) => {
    const key = long(n);
    const t = path({ [key]: node(null, [], msg("user", "x")) }, key);
    expect(t.nodes.map((x) => x.sourceNodeId)).toEqual([key]);
    expect(t.issues).toEqual([]);
  });

  // The adapter skips these conversations (CONVERSATION_NODE_ID_TOO_LONG);
  // buildTree never drops the node and presents the rest as complete.
  it("refuses a 513-character key instead of dropping the node", () => {
    const key = long(513);
    expect(() => buildTree({ r: node(null, []), [key]: node("r", [], msg("user", "lost")) }, null, NOW)).toThrow(
      OversizedNodeIdError,
    );
  });

  it("refuses a 513-character parent instead of turning the node into a root", () => {
    expect(() => buildTree({ a: node(long(513, "p"), [], msg("user", "a")) }, "a", NOW)).toThrow(OversizedNodeIdError);
  });

  it("never puts the identifier in the refusal", () => {
    const huge = long(100_000, "h");
    let message = "";
    try {
      buildTree({ [huge]: node(null, []) }, null, NOW);
    } catch (e) {
      message = String(e) + ((e as Error).stack ?? "");
    }
    expect(message).toContain("OversizedNodeIdError");
    expect(message).not.toContain("hhhhhhhh");
  });

  it("ignores an oversized child entry: the tree is unchanged, with a warning", () => {
    const ref = long(513, "p");
    const t = path({ a: node(null, [ref, "b"], msg("user", "a")), b: node("a", [], msg("user", "b")) }, "b");
    expect(t.issues).toEqual([{ code: "NODE_REFERENCE_TOO_LONG", nodeId: "a", field: "children" }]);
    expect(t.path).toEqual(["a", "b"]);
    expect(t.pathStrategy).toBe("current_node");
  });

  it("keeps a 512-character parent reference exactly", () => {
    const ref = long(512, "p");
    const t = path({ a: node(ref, [], msg("user", "a")) }, "a");
    expect(t.nodes[0]!.parentSourceNodeId).toBe(ref);
    expect(t.issues.map((i) => i.code)).toEqual(["NODE_PARENT_NOT_IN_MAPPING"]);
  });

  it.each([
    [512, "m".repeat(512)],
    [513, null],
  ])("a message.id of %i characters is stored as %s", (n, expected) => {
    const t = path({ a: node(null, [], { ...msg("user", "a"), id: "m".repeat(n) }) }, "a");
    expect(t.nodes[0]!.sourceMessageId).toBe(expected);
    expect(t.nodes[0]!.contentText).toBe("a");
    expect(t.issues.some((i) => i.code === "NODE_REFERENCE_TOO_LONG" && i.field === "message.id")).toBe(n > 512);
  });

  it("treats an oversized current_node as absent and records the fallback", () => {
    const t = path({ a: node(null, [], msg("user", "a", 5)) }, long(513, "c"));
    expect(t.issues).toContainEqual({ code: "FIELD_TOO_LONG", field: "current_node" });
    expect(t.pathStrategy).toBe("latest_leaf");
    expect(t.codes).toContain("PATH_FALLBACK");
    expect(t.codes).not.toContain("CURRENT_NODE_NOT_IN_MAPPING");
  });

  it("never copies a 1 MB identifier into nodes or issues", () => {
    const huge = long(1_000_000, "h");
    const t = buildTree({ a: node(null, [huge], { ...msg("user", "a"), id: huge }) }, huge, NOW);
    expect(JSON.stringify(t).length).toBeLessThan(2_000);
  });
});
