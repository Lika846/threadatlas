import { describe, expect, it } from "vitest";
import {
  ALL_FIXTURES,
  DEEP_CANARY,
  deepConversation,
  fixtureJson,
  fixtureText,
  hostileConversationText,
  jsonTextDepth,
  shallowConversation,
} from "../../../../tests/helpers/fixtures";
import type { NormalizedConversation, NormalizedNode, ParseResult } from "../types";
import { parseExportText } from "../validate-export";
import { ADAPTER_VERSION } from "./adapter";
import { computeContentHash } from "./content-hash";

const NOW_MS = Date.UTC(2026, 10, 3);
type Ok = Extract<ParseResult, { ok: true }>;

function parse(name: string): Ok {
  const res = parseExportText(fixtureText(name), { nowMs: NOW_MS });
  if (!res.ok) throw new Error(`expected ok for ${name}, got ${res.error.code}`);
  return res;
}

function conv(res: Ok, index: number): NormalizedConversation {
  const c = res.conversations.find((x) => x.index === index);
  if (!c) throw new Error(`no conversation at index ${index}`);
  return c;
}

/** Path as short node keys (without the "node-" prefix). */
const pathOf = (c: NormalizedConversation) =>
  c.nodes
    .filter((n) => n.pathIndex !== null)
    .sort((a, b) => a.pathIndex! - b.pathIndex!)
    .map((n) => n.sourceNodeId.replace(/^node-/, ""));

const nodeOf = (c: NormalizedConversation, key: string): NormalizedNode => {
  const n = c.nodes.find((x) => x.sourceNodeId === `node-${key}`);
  if (!n) throw new Error(`no node ${key}`);
  return n;
};

const codesFor = (res: Ok, index: number) =>
  res.issues.filter((i) => i.index === index).map((i) => i.code);

describe("visible path: hand-computed expectations per fixture", () => {
  it.each([
    ["linear.json", 0, "current_node", ["a001-root", "a001-system", "a001-user-1", "a001-assistant-1"]],
    ["branching.json", 0, "current_node", ["b001-root", "b001-user-1", "b001-assistant-2", "b001-user-2", "b001-assistant-3"]],
    ["missing-fields.json", 0, "last_child", ["c001-root", "c001-user"]],
    ["missing-fields.json", 1, "current_node", ["c002-user"]],
    ["missing-fields.json", 2, "last_child", ["c003-user"]],
    ["missing-fields.json", 3, "none", []],
    ["content-types.json", 0, "current_node", ["d001-root", "d001-system", "d001-user-image", "d001-assistant-code", "d001-tool", "d001-assistant-unknown"]],
    ["structural-anomalies.json", 0, "current_node", ["e001-orphan"]],
    ["structural-anomalies.json", 1, "current_node", ["e002-a", "e002-b"]],
    ["structural-anomalies.json", 2, "current_node", ["e003-root", "e003-user"]],
    ["structural-anomalies.json", 3, "current_node", ["e004-key"]],
    ["structural-anomalies.json", 4, "current_node", ["e005-root-2", "e005-child"]],
    ["unknown-fields.json", 0, "current_node", ["f001-user"]],
    ["regenerated.json", 0, "current_node", ["g001-root", "g001-user", "g001-answer-2"]],
    ["regenerated.json", 1, "latest_leaf", ["g002-root", "g002-user", "g002-answer-2"]],
    ["path-fallback.json", 0, "latest_leaf", ["h001-root", "h001-a"]],
    ["path-fallback.json", 1, "last_child", ["h002-root", "h002-u2", "h002-a2"]],
    ["path-fallback.json", 2, "last_child", ["h003-root", "h003-a2"]],
    ["path-fallback.json", 3, "latest_leaf", ["h004-root", "h004-y"]],
    ["path-fallback.json", 4, "none", []],
    ["path-fallback.json", 5, "latest_leaf", ["h006-root", "h006-iso"]],
    ["hidden-messages.json", 0, "current_node", ["k001-root", "k001-system-empty", "k001-system-content", "k001-user-hidden", "k001-user", "k001-flag-string", "k001-flag-false", "k001-tool"]],
  ] as const)("%s #%i uses %s → %j", (file, index, strategy, expected) => {
    const c = conv(parse(file), index);
    expect(c.pathStrategy).toBe(strategy);
    expect(pathOf(c)).toEqual(expected);
  });
});

describe("branching and regenerated answers", () => {
  it("keeps every branch of an edited and regenerated conversation", () => {
    const c = conv(parse("branching.json"), 0);
    expect(c.nodeCount).toBe(8);
    expect(nodeOf(c, "b001-assistant-1").pathIndex).toBeNull();
    expect(nodeOf(c, "b001-user-1-edit").pathIndex).toBeNull();
    expect(nodeOf(c, "b001-assistant-edit-1").pathIndex).toBeNull();
    expect(nodeOf(c, "b001-user-1").siblingIndex).toBe(0);
    expect(nodeOf(c, "b001-user-1-edit").siblingIndex).toBe(1);
    expect(nodeOf(c, "b001-assistant-1").siblingIndex).toBe(0);
    expect(nodeOf(c, "b001-assistant-2").siblingIndex).toBe(1);
    expect(c.visibleMessageCount).toBe(4);
  });

  it("keeps all three regenerated answers with their sibling order", () => {
    const c = conv(parse("regenerated.json"), 0);
    expect(["g001-answer-1", "g001-answer-2", "g001-answer-3"].map((k) => nodeOf(c, k).siblingIndex)).toEqual([0, 1, 2]);
    expect(["g001-answer-1", "g001-answer-2", "g001-answer-3"].map((k) => nodeOf(c, k).pathIndex)).toEqual([null, 2, null]);
    expect(nodeOf(c, "g001-answer-1").contentText).toContain("answer one");
    expect(nodeOf(c, "g001-answer-3").contentText).toContain("answer three");
  });

  it("without current_node, picks the latest answer even when it is not listed last", () => {
    const res = parse("regenerated.json");
    expect(pathOf(conv(res, 1)).at(-1)).toBe("g002-answer-2");
    expect(codesFor(res, 1)).toEqual(["PATH_FALLBACK"]);
  });
});

describe("fallback path selection (A25)", () => {
  const res = parse("path-fallback.json");

  it("warns when current_node is not in the mapping, then uses latest_leaf", () => {
    expect(codesFor(res, 0)).toEqual(["CURRENT_NODE_NOT_IN_MAPPING", "PATH_FALLBACK"]);
    expect(conv(res, 0).currentNodeSourceId).toBe("node-h001-gone"); // kept as exported
  });

  it("uses last_child when no leaf has a valid timestamp, and warns about each invalid time", () => {
    expect(codesFor(res, 2)).toEqual(["TIMESTAMP_INVALID", "TIMESTAMP_INVALID", "PATH_FALLBACK"]);
    expect(nodeOf(conv(res, 2), "h003-a2").createdAt).toBeNull();
  });

  it("breaks timestamp ties by later mapping order, not by children[] order", () => {
    expect(pathOf(conv(res, 3))).toEqual(["h004-root", "h004-y"]);
  });

  it("compares ISO and numeric timestamps on one scale", () => {
    const c = conv(res, 5);
    expect(nodeOf(c, "h006-iso").createdAt).toBe(1767225610);
    expect(pathOf(c).at(-1)).toBe("h006-iso");
  });

  it("builds no path for a rootless cycle, but still stores the nodes", () => {
    const c = conv(res, 4);
    expect(c.nodeCount).toBe(2);
    expect(c.visibleMessageCount).toBe(0);
    expect(codesFor(res, 4)).toEqual(["TREE_CYCLE", "PATH_NONE"]);
  });

  it("every fallback strategy is recorded and warned about", () => {
    for (const c of res.conversations) {
      const fallback = c.pathStrategy === "latest_leaf" || c.pathStrategy === "last_child";
      expect(codesFor(res, c.index).includes("PATH_FALLBACK")).toBe(fallback);
    }
  });
});

describe("malformed messages (A24)", () => {
  const res = parse("malformed-messages.json");
  const c = conv(res, 0);

  it("keeps malformed messages on the path, distinct from structural nodes", () => {
    for (const key of ["i001-string", "i001-number", "i001-empty", "i001-content-string", "i001-no-type", "i001-text-no-parts"]) {
      expect(nodeOf(c, key)).toMatchObject({ isMalformed: true, isStructural: false });
      expect(nodeOf(c, key).pathIndex).not.toBeNull();
    }
    expect(nodeOf(c, "i001-root")).toMatchObject({ isStructural: true, isMalformed: false });
    expect(c.visibleMessageCount).toBe(10);
  });

  it("keeps safely recoverable text and invents none", () => {
    expect(nodeOf(c, "i001-string").contentText).toBe("Synthetic canary: a message stored as a bare string.");
    expect(nodeOf(c, "i001-content-string").contentText).toBe("Synthetic canary: content is a bare string.");
    expect(nodeOf(c, "i001-no-type").contentText).toBe("Synthetic canary: parts without a content type.");
    expect(nodeOf(c, "i001-text-no-parts").contentText).toBe("Synthetic canary: a text field instead of parts.");
    expect(nodeOf(c, "i001-number").contentText).toBe("");
    expect(nodeOf(c, "i001-empty").contentText).toBe("");
  });

  it("keeps unreadable payloads as raw content", () => {
    expect(nodeOf(c, "i001-number").rawContentJson).toBe("7");
    expect(nodeOf(c, "i001-string").rawContentJson).toBeNull();
  });

  it("a missing role does not make a node structural (A29)", () => {
    for (const key of ["i001-no-role", "i001-author-string", "i001-empty"]) {
      expect(nodeOf(c, key)).toMatchObject({ role: null, isStructural: false });
    }
    expect(nodeOf(c, "i001-no-role")).toMatchObject({ isMalformed: false, contentText: "Synthetic canary: the author has no role." });
    expect(res.issues.filter((i) => i.code === "MESSAGE_ROLE_MISSING").map((i) => i.nodeId)).toEqual([
      "node-i001-empty",
      "node-i001-no-role",
      "node-i001-author-string",
    ]);
  });

  it("keeps unknown roles exactly as exported", () => {
    expect(nodeOf(c, "i001-unknown-role").role).toBe("critic");
  });

  it("emits one MESSAGE_MALFORMED warning per malformed message", () => {
    expect(
      res.issues.filter((i) => i.index === 0 && i.code === "MESSAGE_MALFORMED").map((i) => i.nodeId),
    ).toEqual(
      ["string", "number", "empty", "content-string", "no-type", "text-no-parts"].map((k) => `node-i001-${k}`),
    );
  });

  it("handles malformed node structure without inventing parents", () => {
    const c2 = conv(res, 1);
    expect(c2.nodes.map((n) => n.sourceNodeId)).toEqual(["node-i002-root", "node-i002-user", "node-i002-weird-parent"]);
    expect(nodeOf(c2, "i002-weird-parent")).toMatchObject({ parentSourceNodeId: null, siblingIndex: 1 });
    expect(codesFor(res, 1)).toEqual([
      "NODE_NOT_OBJECT",
      "NODE_CHILDREN_INVALID",
      "NODE_CHILDREN_INVALID",
      "NODE_PARENT_INVALID",
      "MULTIPLE_ROOTS",
    ]);
  });
});

describe("unsupported content (A27, A28)", () => {
  const c = conv(parse("unsupported-content.json"), 0);
  const raw = (fixtureJson("unsupported-content.json") as Array<{ mapping: Record<string, { message: { content: unknown } }> }>)[0]!.mapping;
  const rawContent = (key: string) => raw[`node-${key}`]!.message.content;

  it("keeps the original payload for unsupported content only", () => {
    for (const key of ["j001-payload", "j001-quote", "j001-future-parts", "j001-text-object-part", "j001-multimodal", "j001-odd-type"]) {
      const n = nodeOf(c, key);
      expect(n.hasUnsupportedParts).toBe(true);
      expect(JSON.parse(n.rawContentJson!)).toEqual(rawContent(key));
    }
    for (const key of ["j001-image-only", "j001-code-plain", "j001-code-html", "j001-exec"]) {
      expect(nodeOf(c, key)).toMatchObject({ hasUnsupportedParts: false, rawContentJson: null });
    }
  });

  it("shows a placeholder or best-effort text", () => {
    expect(nodeOf(c, "j001-payload").contentText).toBe("[unsupported content: x_future_widget]");
    expect(nodeOf(c, "j001-quote").contentText).toBe("Synthetic canary quoted text.");
    expect(nodeOf(c, "j001-multimodal").contentText).toBe(
      "[image]\n\n[attachment: audio_transcription]\n\nSynthetic canary caption.",
    );
    expect(nodeOf(c, "j001-odd-type").contentText).toBe("[unsupported content: unknown]");
    expect(nodeOf(c, "j001-odd-type").contentType).toBe("<b>odd</b>"); // raw type kept as data
  });

  it("keeps code exactly, with its language", () => {
    expect(nodeOf(c, "j001-code-plain")).toMatchObject({
      contentText: "  indented canary()\n\tline two  \n",
      codeLanguage: null,
    });
    expect(nodeOf(c, "j001-code-html")).toMatchObject({
      contentText: "<script>alert('canary')</script><b>bold canary</b>",
      codeLanguage: "html",
    });
  });

  it("records the parser version for reprocessing", () => {
    expect(c.parserVersion).toBe(ADAPTER_VERSION);
  });
});

describe("hidden messages (A26)", () => {
  const c = conv(parse("hidden-messages.json"), 0);

  it("hides all system messages and explicitly hidden ones", () => {
    const hidden = c.nodes.filter((n) => n.isHidden).map((n) => n.sourceNodeId.replace(/^node-/, ""));
    expect(hidden).toEqual(["k001-system-empty", "k001-system-content", "k001-user-hidden"]);
  });

  it("only a strict true hides a message", () => {
    expect(nodeOf(c, "k001-flag-string").isHidden).toBe(false);
    expect(nodeOf(c, "k001-flag-false").isHidden).toBe(false);
  });

  it("stores hidden messages with their content, and never hides or shows structural nodes as messages", () => {
    expect(nodeOf(c, "k001-system-content").contentText).toContain("system message with content");
    expect(nodeOf(c, "k001-root")).toMatchObject({ isStructural: true, isHidden: false });
    expect(c.visibleMessageCount).toBe(4);
  });

  it("applies the same rule to the older fixtures", () => {
    expect(nodeOf(conv(parse("linear.json"), 0), "a001-system").isHidden).toBe(true);
    expect(nodeOf(conv(parse("content-types.json"), 0), "d001-system").isHidden).toBe(true);
  });
});

describe("conversation fields and timestamps (A22)", () => {
  it("normalises conversation times and keeps sub-second precision", () => {
    const c = conv(parse("linear.json"), 0);
    expect(c.createdAt).toBe(1767225600.125);
    expect(c.updatedAt).toBe(1767225900.5);
    expect(nodeOf(c, "a001-assistant-1").createdAt).toBe(1767225620.75);
  });

  it("treats a malformed conversation timestamp as missing, with a warning", () => {
    const res = parse("missing-fields.json");
    expect(conv(res, 2).updatedAt).toBeNull();
    expect(res.issues).toContainEqual({ code: "TIMESTAMP_INVALID", index: 2, sourceId: "00000000-0000-4000-8000-00000000c003", field: "update_time" });
    expect(conv(res, 2).title).toBeNull();
  });

  it("warns about unusual timestamps but keeps them", () => {
    const text = JSON.stringify([
      {
        _synthetic: true,
        conversation_id: "conv-unusual",
        create_time: 0,
        update_time: 1767225600000, // milliseconds mistaken for seconds
        mapping: { a: { parent: null, children: [], message: { author: { role: "user" }, create_time: -5, content: { content_type: "text", parts: ["x"] } } } },
      },
    ]);
    const res = parseExportText(text, { nowMs: NOW_MS });
    if (!res.ok) throw new Error("expected ok");
    expect(res.conversations[0]).toMatchObject({ createdAt: 0, updatedAt: 1767225600000 });
    expect(res.conversations[0]!.nodes[0]!.createdAt).toBe(-5);
    expect(res.issues.filter((i) => i.code === "TIMESTAMP_UNUSUAL").map((i) => i.field)).toEqual([
      "create_time",
      "update_time",
      "message.create_time",
    ]);
  });
});

describe("invariants for every fixture", () => {
  it.each(ALL_FIXTURES)("%s: nodes, path and counts are consistent", (name) => {
    const res = parse(name);
    const data = fixtureJson(name) as unknown[];
    for (const c of res.conversations) {
      const mapping = (data[c.index] as { mapping: Record<string, unknown> }).mapping;
      const objectKeys = Object.keys(mapping).filter((k) => {
        const v = mapping[k];
        return typeof v === "object" && v !== null && !Array.isArray(v);
      });
      // Every object node is stored exactly once, in mapping order (R22).
      expect(c.nodes.map((n) => n.sourceNodeId)).toEqual(objectKeys);
      expect(c.nodeCount).toBe(objectKeys.length);

      // Path indices are 0..n-1 and each step follows a real parent link.
      const onPath = c.nodes.filter((n) => n.pathIndex !== null).sort((a, b) => a.pathIndex! - b.pathIndex!);
      onPath.forEach((n, i) => expect(n.pathIndex).toBe(i));
      for (let i = 1; i < onPath.length; i++) {
        expect(onPath[i]!.parentSourceNodeId).toBe(onPath[i - 1]!.sourceNodeId);
      }

      // Structural nodes are never malformed, hidden, or given a role.
      for (const n of c.nodes.filter((x) => x.isStructural)) {
        expect(n).toMatchObject({ isMalformed: false, isHidden: false, role: null, contentText: "" });
      }
      // Raw content only accompanies unsupported content.
      for (const n of c.nodes) expect(n.rawContentJson !== null).toBe(n.hasUnsupportedParts);

      expect(c.visibleMessageCount).toBe(onPath.filter((n) => !n.isStructural && !n.isHidden).length);
      expect(c.contentHash).toMatch(/^v1:[0-9a-f]{64}$/);
      expect(c.parserVersion).toBe(ADAPTER_VERSION);
    }
  });

  it.each(ALL_FIXTURES)("%s: parsing is deterministic", (name) => {
    expect(parse(name)).toEqual(parse(name));
  });
});

describe("privacy of reports (M1.2 issues)", () => {
  it.each(ALL_FIXTURES)("%s: no content in any issue", (name) => {
    const report = JSON.stringify(parse(name).issues).toLowerCase();
    expect(report).not.toContain("canary");
    expect(report).not.toContain("synthetic");
  });
});

describe("JSON nesting limit through the full pipeline (F2)", () => {
  const MAX = 512;
  const text = (convs: unknown[]) => JSON.stringify(convs);

  it.each([MAX - 1, MAX])("hashes and keeps the raw payload of a conversation %i levels deep", (depth) => {
    const res = parseExportText(text([deepConversation(depth, { id: "c" })]), { nowMs: NOW_MS });
    if (!res.ok) throw new Error(res.error.code);
    const c = conv(res, 0);
    expect(c.contentHash).toMatch(/^v1:[0-9a-f]{64}$/);
    const n = c.nodes[0]!;
    // A non-string part is unsupported content, so its payload is serialised too.
    expect(n.hasUnsupportedParts).toBe(true);
    expect(jsonTextDepth(n.rawContentJson!)).toBe(depth - 5);
  });

  it(`skips only the conversation that is ${MAX + 1} levels deep`, () => {
    const res = parseExportText(
      text([shallowConversation("a"), deepConversation(MAX + 1, { id: "b" }), deepConversation(MAX + 1)]),
      { nowMs: NOW_MS },
    );
    if (!res.ok) throw new Error(res.error.code);
    expect(res.conversations.map((c) => c.sourceId)).toEqual(["a"]);
    expect(res.skipped).toEqual([
      { index: 1, code: "CONVERSATION_TOO_DEEP", sourceId: "b" },
      { index: 2, code: "CONVERSATION_TOO_DEEP" },
    ]);
  });

  it("survives a hostile 1,000,000-level conversation without leaking content or errors", () => {
    const body = `[${hostileConversationText("evil", 1_000_000)},${JSON.stringify(shallowConversation("ok"))}]`;
    const res = parseExportText(body, { nowMs: NOW_MS });
    if (!res.ok) throw new Error(res.error.code);
    expect(res.conversations.map((c) => c.sourceId)).toEqual(["ok"]);
    expect(res.skipped).toEqual([{ index: 0, code: "CONVERSATION_TOO_DEEP", sourceId: "evil" }]);
    const report = JSON.stringify({ issues: res.issues, skipped: res.skipped });
    expect(report).not.toContain(DEEP_CANARY);
    expect(report).not.toMatch(/RangeError|stack|\bat /);
  });
});

describe("identifier length limit in the pipeline (Q12)", () => {
  const text = (parts: string) => ({ author: { role: "user" }, content: { content_type: "text", parts: [parts] } });

  it("never presents a tree with an oversized node ID as complete: the conversation is skipped, the rest imported", () => {
    const key = "k".repeat(513);
    const data = [
      { id: "whole", mapping: { a: { parent: null, children: [], message: text("x") } } },
      { id: "broken", mapping: { r: { parent: null, children: [key], message: text("r") }, [key]: { parent: "r", children: ["c"], message: text("lost") }, c: { parent: key, children: [], message: text("c") } } },
    ];
    const res = parseExportText(JSON.stringify(data), { nowMs: NOW_MS });
    if (!res.ok) throw new Error(res.error.code);
    expect(res.conversations.map((c) => c.sourceId)).toEqual(["whole"]);
    expect(res.skipped).toEqual([{ index: 1, code: "CONVERSATION_NODE_ID_TOO_LONG", sourceId: "broken" }]);
  });

  it("keeps the tree complete when only a child entry or message.id is oversized", () => {
    const long = "x".repeat(513);
    const data = [{ id: "kept", mapping: { a: { parent: null, children: ["b", long], message: text("a") }, b: { parent: "a", children: [], message: { ...text("b"), id: long } } } }];
    const res = parseExportText(JSON.stringify(data), { nowMs: NOW_MS });
    if (!res.ok) throw new Error(res.error.code);
    const c = conv(res, 0);
    expect(c.nodeCount).toBe(2);
    expect(c.visibleMessageCount).toBe(2);
    expect(c.nodes.map((n) => [n.sourceNodeId, n.parentSourceNodeId])).toEqual([["a", null], ["b", "a"]]);
    expect(res.issues.filter((i) => i.code === "NODE_REFERENCE_TOO_LONG").map((i) => i.field).sort()).toEqual([
      "children",
      "message.id",
    ]);
  });

  it("does not store an oversized current_node but keeps hash v1 unchanged", () => {
    const longNode = "c".repeat(513);
    const base = { id: "q12", title: "t", mapping: { a: { parent: null, children: [], message: { author: { role: "user" }, content: { content_type: "text", parts: ["x"] } } } } };
    const res = parseExportText(JSON.stringify([{ ...base, current_node: longNode }]), { nowMs: NOW_MS });
    if (!res.ok) throw new Error(res.error.code);
    const c = conv(res, 0);
    expect(c.currentNodeSourceId).toBeNull();
    expect(res.issues).toContainEqual({ code: "FIELD_TOO_LONG", field: "current_node", index: 0, sourceId: "q12" });
    // Frozen v1: the hash still covers the validated source value of current_node.
    expect(c.contentHash).toBe(
      computeContentHash({ title: "t", createTime: null, updateTime: null, currentNode: longNode, mapping: base.mapping }),
    );
  });
});
