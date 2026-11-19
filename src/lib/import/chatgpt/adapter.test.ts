import { describe, expect, it } from "vitest";
import {
  ALL_FIXTURES,
  DEEP_CANARY,
  deepConversation,
  fixtureJson,
  fixtureText,
  hostileConversationText,
  jsonTextDepth,
  nestedArrays,
  shallowConversation,
} from "../../../../tests/helpers/fixtures";
import { ISSUE_DEFINITIONS } from "../errors";
import type { AdapterResult } from "../types";
import { validateExportText } from "../validate-export";
import { ADAPTER_VERSION, DUPLICATE_SAMPLE_LIMIT, parseChatGptExport } from "./adapter";

type Ok = Extract<AdapterResult, { ok: true }>;

function parseOk(name: string): Ok {
  const res = parseChatGptExport(fixtureJson(name));
  if (!res.ok) throw new Error(`expected ok for ${name}, got ${res.error.code}`);
  return res;
}

const codesAt = (res: Ok, index: number) =>
  res.issues.filter((i) => i.index === index).map((i) => i.code);

function rawMapping(name: string, index: number): unknown {
  const data = fixtureJson(name) as Array<Record<string, unknown>>;
  return data[index]!.mapping;
}

describe("file-level validation", () => {
  it.each([
    ["an object", "{}"],
    ["a string", '"canary"'],
    ["a number", "42"],
    ["null", "null"],
  ])("rejects a top level that is %s", (_label, text) => {
    expect(validateExportText(text)).toEqual({
      ok: false,
      error: { code: "FILE_UNSUPPORTED_STRUCTURE" },
    });
  });

  it("rejects an empty array", () => {
    expect(validateExportText("[]")).toEqual({
      ok: false,
      error: { code: "FILE_NO_CONVERSATIONS" },
    });
  });

  it("rejects malformed JSON and empty text", () => {
    expect(validateExportText('[{"title": "canary"')).toEqual({
      ok: false,
      error: { code: "FILE_INVALID_JSON" },
    });
    expect(validateExportText("")).toEqual({ ok: false, error: { code: "FILE_EMPTY" } });
  });

  it("every file-level error code has a static message", () => {
    for (const [code, def] of Object.entries(ISSUE_DEFINITIONS)) {
      expect(def.message.length, code).toBeGreaterThan(0);
    }
  });
});

describe("linear conversation", () => {
  const res = parseOk("linear.json");

  it("accepts it with its conversation_id and no issues", () => {
    expect(res.adapter).toBe("chatgpt");
    expect(res.adapterVersion).toBe(ADAPTER_VERSION);
    expect(res.conversationsSeen).toBe(1);
    expect(res.accepted).toHaveLength(1);
    expect(res.issues).toEqual([]);
    const [c] = res.accepted;
    expect(c).toMatchObject({
      index: 0,
      sourceId: "00000000-0000-4000-8000-00000000a001",
      idSource: "conversation_id",
      title: "Synthetic canary: watering a desk cactus",
      createTime: 1767225600.125,
      currentNode: "node-a001-assistant-1",
    });
  });

  it("keeps the structural root node (message: null)", () => {
    const root = res.accepted[0]!.mapping["node-a001-root"] as { message: unknown };
    expect(root.message).toBeNull();
  });
});

describe("branch and structure preservation", () => {
  it.each(ALL_FIXTURES)("passes every mapping of %s through unchanged", (name) => {
    const res = parseOk(name);
    for (const c of res.accepted) {
      expect(c.mapping).toEqual(rawMapping(name, c.index));
    }
  });

  it("keeps all branches of a branching conversation", () => {
    const [c] = parseOk("branching.json").accepted;
    expect(Object.keys(c!.mapping)).toHaveLength(8);
    const root = c!.mapping["node-b001-root"] as { children: string[] };
    expect(root.children).toEqual(["node-b001-user-1", "node-b001-user-1-edit"]);
    const user1 = c!.mapping["node-b001-user-1"] as { children: string[] };
    expect(user1.children).toEqual(["node-b001-assistant-1", "node-b001-assistant-2"]);
  });

  it("does not reject structural anomalies at conversation level (handled in M1.2)", () => {
    const res = parseOk("structural-anomalies.json");
    expect(res.accepted).toHaveLength(5);
    expect(res.issues).toEqual([]);
  });

  it("keeps unusual content types for later extraction", () => {
    const res = parseOk("content-types.json");
    expect(res.accepted).toHaveLength(1);
    expect(Object.keys(res.accepted[0]!.mapping)).toHaveLength(6);
    expect(res.issues).toEqual([]);
  });
});

describe("version tolerance", () => {
  it("accepts unknown fields at every level without issues", () => {
    const res = parseOk("unknown-fields.json");
    expect(res.accepted).toHaveLength(1);
    expect(res.issues).toEqual([]);
    // Unknown node-level fields stay in the (unchanged) mapping.
    const n = res.accepted[0]!.mapping["node-f001-user"] as Record<string, unknown>;
    expect(n.x_synthetic_node_field).toBe(7);
  });

  it("tolerates missing and wrongly typed optional fields", () => {
    const res = parseOk("missing-fields.json");
    expect(res.accepted.map((c) => c.index)).toEqual([0, 1, 2, 3]);

    const [noCurrent, noTitle, wrongTypes, explicitNulls] = res.accepted;
    expect(noCurrent!.currentNode).toBeUndefined();
    expect(noTitle!.title).toBeUndefined();
    expect(noTitle!.createTime).toBeUndefined();
    expect(noTitle!.updateTime).toBeUndefined();

    expect(wrongTypes!.title).toBeUndefined();
    expect(wrongTypes!.createTime).toBeUndefined();
    expect(wrongTypes!.currentNode).toBeUndefined();
    expect(wrongTypes!.updateTime).toBe("not-a-date"); // strings are allowed; parsed in M1.2
    expect(
      res.issues.filter((i) => i.index === 2).map((i) => i.field).sort(),
    ).toEqual(["create_time", "current_node", "title"]);
    expect(codesAt(res, 2)).toEqual([
      "FIELD_INVALID_TYPE",
      "FIELD_INVALID_TYPE",
      "FIELD_INVALID_TYPE",
    ]);

    expect(explicitNulls!.title).toBeNull();
    expect(explicitNulls!.mapping).toEqual({});
    expect(codesAt(res, 0)).toEqual([]);
    expect(codesAt(res, 1)).toEqual([]);
    expect(codesAt(res, 3)).toEqual([]);
  });
});

describe("invalid entries", () => {
  const res = parseOk("invalid-entries.json");

  it("skips non-objects and conversations without an object mapping", () => {
    expect(res.skipped).toEqual([
      { index: 0, code: "CONVERSATION_NOT_OBJECT" },
      { index: 1, code: "CONVERSATION_NOT_OBJECT" },
      { index: 2, code: "CONVERSATION_NOT_OBJECT" },
      { index: 3, code: "CONVERSATION_NOT_OBJECT" },
      { index: 4, code: "CONVERSATION_NOT_OBJECT" },
      { index: 5, code: "CONVERSATION_MAPPING_MISSING", sourceId: "no-mapping-0005" },
      { index: 6, code: "CONVERSATION_MAPPING_INVALID", sourceId: "array-mapping-0006" },
      { index: 7, code: "CONVERSATION_MAPPING_INVALID", sourceId: "null-mapping-0007" },
    ]);
  });

  it("still accepts the valid conversation", () => {
    expect(res.conversationsSeen).toBe(9);
    expect(res.accepted.map((c) => c.sourceId)).toEqual(["valid-0008"]);
  });
});

describe("conversation identity (D21)", () => {
  const res = parseOk("id-fallback.json");
  const accepted = new Map(res.accepted.map((c) => [c.index, c]));

  it("falls back to id when conversation_id is absent", () => {
    expect(accepted.get(0)).toMatchObject({ sourceId: "only-id-0000", idSource: "id" });
  });

  it("falls back to id when conversation_id is wrongly typed or blank", () => {
    expect(accepted.get(6)).toMatchObject({ sourceId: "fallback-id-0006", idSource: "id" });
    expect(accepted.get(7)).toMatchObject({ sourceId: "fallback-id-0007", idSource: "id" });
    expect(res.issues).toContainEqual({ code: "FIELD_INVALID_TYPE", index: 6, field: "conversation_id" });
    expect(res.issues).toContainEqual({ code: "FIELD_INVALID_TYPE", index: 7, field: "conversation_id" });
  });

  it("prefers conversation_id and warns when id differs", () => {
    expect(accepted.get(8)).toMatchObject({ sourceId: "cid-0008", idSource: "conversation_id" });
    expect(codesAt(res, 8)).toEqual(["CONVERSATION_ID_MISMATCH"]);
  });

  it("derives a deterministic ID when both are missing", () => {
    const c = accepted.get(1)!;
    expect(c.idSource).toBe("derived");
    expect(c.sourceId).toMatch(/^derived:v1:[0-9a-f]{64}$/);
    expect(codesAt(res, 1)).toEqual(["CONVERSATION_ID_DERIVED"]);
    // Same input, same ID.
    const again = parseOk("id-fallback.json").accepted.find((x) => x.index === 1)!;
    expect(again.sourceId).toBe(c.sourceId);
  });

  it("flags identical ID-less conversations instead of merging them", () => {
    const twins = res.flagged.filter((f) => f.index === 2 || f.index === 3);
    expect(twins).toHaveLength(2);
    expect(twins.every((f) => f.code === "CONVERSATION_ID_AMBIGUOUS")).toBe(true);
    expect(twins[0]!.sourceId).toBe(twins[1]!.sourceId);
    expect(accepted.has(2) || accepted.has(3)).toBe(false);
    expect(res.issues).toContainEqual({
      code: "CONVERSATION_ID_AMBIGUOUS",
      sourceId: twins[0]!.sourceId,
      duplicateGroup: { occurrences: 2, sampleIndices: [2, 3], truncated: false },
    });
  });

  it("skips ID-less conversations with no content to derive from", () => {
    expect(res.skipped).toEqual([
      { index: 4, code: "CONVERSATION_ID_UNDERIVABLE" },
      { index: 5, code: "CONVERSATION_ID_UNDERIVABLE" },
    ]);
  });

  it("flags explicit IDs that use the reserved derived prefix", () => {
    expect(res.flagged).toContainEqual({
      index: 9,
      code: "CONVERSATION_ID_RESERVED",
      sourceId: "derived:v1:not-really-derived",
      idSource: "conversation_id",
    });
  });

  it("accounts for every entry exactly once", () => {
    const all = [
      ...res.accepted.map((c) => c.index),
      ...res.flagged.map((f) => f.index),
      ...res.skipped.map((s) => s.index),
    ].sort((a, b) => a - b);
    expect(all).toEqual([...Array(res.conversationsSeen).keys()]);
  });
});

describe("duplicate IDs within one file", () => {
  const res = parseOk("duplicate-ids.json");

  it("keeps the copy with the later update time", () => {
    expect(res.accepted.map((c) => c.index)).toEqual([1, 6]);
    expect(res.skipped).toEqual([
      { index: 0, code: "DUPLICATE_ID_SUPERSEDED", sourceId: "dup-0001" },
    ]);
    expect(res.issues).toContainEqual({
      code: "DUPLICATE_ID_SUPERSEDED",
      sourceId: "dup-0001",
      duplicateGroup: { occurrences: 2, sampleIndices: [0, 1], truncated: false, keptIndex: 1 },
    });
  });

  it("flags all copies when the newest cannot be determined", () => {
    expect(res.flagged.map((f) => [f.index, f.code, f.sourceId])).toEqual([
      [2, "DUPLICATE_ID_AMBIGUOUS", "dup-0002"], // tied update time
      [3, "DUPLICATE_ID_AMBIGUOUS", "dup-0002"],
      [4, "DUPLICATE_ID_AMBIGUOUS", "dup-0003"], // one copy has no update time
      [5, "DUPLICATE_ID_AMBIGUOUS", "dup-0003"],
    ]);
  });
});

describe("privacy of reports", () => {
  it.each(ALL_FIXTURES)("issues, flags and skips for %s contain no content", (name) => {
    const res = parseOk(name);
    const report = JSON.stringify({ issues: res.issues, flagged: res.flagged, skipped: res.skipped });
    expect(report.toLowerCase()).not.toContain("canary");
    expect(report.toLowerCase()).not.toContain("synthetic");
  });

  it("issue messages are static and contain no content", () => {
    for (const def of Object.values(ISSUE_DEFINITIONS)) {
      expect(def.message.toLowerCase()).not.toContain("canary");
    }
  });

  it("file-level errors carry only a code", () => {
    const res = validateExportText(fixtureText("linear.json").slice(0, 200));
    expect(res).toEqual({ ok: false, error: { code: "FILE_INVALID_JSON" } });
  });
});

describe("duplicate resolution uses the shared timestamp rule (A22, A30)", () => {
  const pair = (a: unknown, b: unknown) =>
    parseChatGptExport([
      { conversation_id: "dup", update_time: a, mapping: {} },
      { conversation_id: "dup", update_time: b, mapping: {} },
    ]);

  it("compares only when both times are valid", () => {
    for (const [a, b] of [
      [1e300, 100], // finite but not representable
      ["2026-01-01T00:00:00", 100], // no offset: invalid
      ["2026-02-30", 100], // no calendar roll-over
      ["garbage", 100],
    ] as const) {
      const res = pair(a, b);
      if (!res.ok) throw new Error("expected ok");
      expect(res.accepted).toEqual([]);
      expect(res.flagged.map((f) => f.code)).toEqual(["DUPLICATE_ID_AMBIGUOUS", "DUPLICATE_ID_AMBIGUOUS"]);
    }
  });

  it("compares a valid ISO time with a numeric time on one scale", () => {
    const res = pair("2026-01-01T00:00:10Z", 1767225605);
    if (!res.ok) throw new Error("expected ok");
    expect(res.accepted.map((c) => c.index)).toEqual([0]);
    expect(res.skipped).toEqual([{ index: 1, code: "DUPLICATE_ID_SUPERSEDED", sourceId: "dup" }]);
  });
});

describe("JSON nesting limit (F2)", () => {
  const MAX = 512;

  it("measures depth from the file root", () => {
    for (const depth of [MAX - 1, MAX, MAX + 1]) {
      expect(jsonTextDepth(JSON.stringify([deepConversation(depth, { id: "c" })]))).toBe(depth);
    }
  });

  it.each([MAX - 1, MAX])("accepts a conversation %i levels deep", (depth) => {
    const res = parseChatGptExport([deepConversation(depth, { id: "c-deep" })]);
    if (!res.ok) throw new Error(res.error.code);
    expect(res.accepted.map((c) => c.sourceId)).toEqual(["c-deep"]);
    expect(res.skipped).toEqual([]);
  });

  it(`skips a conversation ${MAX + 1} levels deep with CONVERSATION_TOO_DEEP`, () => {
    const res = parseChatGptExport([deepConversation(MAX + 1, { id: "c-deep" })]);
    if (!res.ok) throw new Error(res.error.code);
    expect(res.accepted).toEqual([]);
    expect(res.skipped).toEqual([{ index: 0, code: "CONVERSATION_TOO_DEEP", sourceId: "c-deep" }]);
    expect(res.issues).toEqual([{ code: "CONVERSATION_TOO_DEEP", index: 0, sourceId: "c-deep" }]);
  });

  it.each([MAX - 1, MAX])("derives an ID for an ID-less conversation %i levels deep (M1.1 path)", (depth) => {
    const res = parseChatGptExport([deepConversation(depth)]);
    if (!res.ok) throw new Error(res.error.code);
    expect(res.accepted).toHaveLength(1);
    expect(res.accepted[0]!.sourceId).toMatch(/^derived:v1:[0-9a-f]{64}$/);
  });

  it(`skips an ID-less conversation ${MAX + 1} levels deep before deriving an ID`, () => {
    const res = parseChatGptExport([deepConversation(MAX + 1)]);
    if (!res.ok) throw new Error(res.error.code);
    expect(res.skipped).toEqual([{ index: 0, code: "CONVERSATION_TOO_DEEP" }]);
    expect(res.issues.map((i) => i.code)).toEqual(["CONVERSATION_TOO_DEEP"]);
  });

  it("counts nesting anywhere in the conversation, not only in the mapping", () => {
    const ok = { ...shallowConversation("c"), metadata: nestedArrays(MAX - 2) };
    const deep = { ...shallowConversation("c"), metadata: nestedArrays(MAX - 1) };
    expect(jsonTextDepth(JSON.stringify([deep]))).toBe(MAX + 1);
    const a = parseChatGptExport([ok]);
    const b = parseChatGptExport([deep]);
    if (!a.ok || !b.ok) throw new Error("expected ok");
    expect(a.accepted).toHaveLength(1);
    expect(b.skipped.map((s) => s.code)).toEqual(["CONVERSATION_TOO_DEEP"]);
  });

  it("isolates a hostile 100,000-level conversation: only it is skipped, without content in the report", () => {
    const text = `[${JSON.stringify(shallowConversation("c-0"))},${hostileConversationText("c-1", 100_000)},${JSON.stringify(shallowConversation("c-2"))}]`;
    const res = validateExportText(text);
    if (!res.ok) throw new Error(res.error.code);
    expect(res.accepted.map((c) => c.sourceId)).toEqual(["c-0", "c-2"]);
    expect(res.skipped).toEqual([{ index: 1, code: "CONVERSATION_TOO_DEEP", sourceId: "c-1" }]);
    const report = JSON.stringify({ issues: res.issues, skipped: res.skipped, flagged: res.flagged });
    expect(report).not.toContain(DEEP_CANARY);
    expect(report).not.toMatch(/RangeError|stack|\bat /);
  });

  it("rejects deep non-conversation shapes without recursing", () => {
    const n = 1_000_000;
    expect(validateExportText("[".repeat(n) + "]".repeat(n))).toMatchObject({
      ok: true,
      skipped: [{ index: 0, code: "CONVERSATION_NOT_OBJECT" }],
    });
    expect(validateExportText('{"a":'.repeat(n) + "1" + "}".repeat(n))).toEqual({
      ok: false,
      error: { code: "FILE_UNSUPPORTED_STRUCTURE" },
    });
  });
});

describe("duplicate-ID groups are reported once, with a bounded summary (F3)", () => {
  const DUP_CODES = new Set(["DUPLICATE_ID_SUPERSEDED", "DUPLICATE_ID_AMBIGUOUS", "CONVERSATION_ID_AMBIGUOUS"]);
  const dupIssues = (res: Ok) => res.issues.filter((i) => DUP_CODES.has(i.code));
  const copies = (times: unknown[], id = "dup") =>
    times.map((t) => ({
      conversation_id: id,
      title: "synthetic canary title",
      ...(t === undefined ? {} : { update_time: t }),
      mapping: {},
    }));
  const run = (data: unknown[]): Ok => {
    const res = parseChatGptExport(data);
    if (!res.ok) throw new Error(res.error.code);
    return res;
  };
  /** Every entry is accepted, flagged or skipped exactly once. */
  const expectPartition = (res: Ok) => {
    const seen = new Uint8Array(res.conversationsSeen);
    for (const i of [...res.accepted.map((c) => c.index), ...res.flagged.map((f) => f.index), ...res.skipped.map((s) => s.index)]) seen[i]!++;
    expect(seen.every((x) => x === 1)).toBe(true);
  };

  it("reports the fixture's three groups with one issue each", () => {
    const res = parseOk("duplicate-ids.json");
    expect(dupIssues(res)).toEqual([
      { code: "DUPLICATE_ID_SUPERSEDED", sourceId: "dup-0001", duplicateGroup: { occurrences: 2, sampleIndices: [0, 1], truncated: false, keptIndex: 1 } },
      { code: "DUPLICATE_ID_AMBIGUOUS", sourceId: "dup-0002", duplicateGroup: { occurrences: 2, sampleIndices: [2, 3], truncated: false } },
      { code: "DUPLICATE_ID_AMBIGUOUS", sourceId: "dup-0003", duplicateGroup: { occurrences: 2, sampleIndices: [4, 5], truncated: false } },
    ]);
  });

  it("keeps the strictly newest copy wherever it is in the group", () => {
    const res = run(copies([5, 9, 7]));
    expect(res.accepted.map((c) => c.index)).toEqual([1]);
    expect(res.skipped.map((s) => s.index)).toEqual([0, 2]);
    expect(dupIssues(res)).toEqual([
      { code: "DUPLICATE_ID_SUPERSEDED", sourceId: "dup", duplicateGroup: { occurrences: 3, sampleIndices: [0, 1, 2], truncated: false, keptIndex: 1 } },
    ]);
  });

  it("only a tie at the latest time is ambiguous", () => {
    expect(run(copies([5, 5, 9])).accepted.map((c) => c.index)).toEqual([2]);
    const tied = run(copies([9, 5, 9]));
    expect(tied.accepted).toEqual([]);
    expect(tied.flagged.map((f) => [f.index, f.code])).toEqual([
      [0, "DUPLICATE_ID_AMBIGUOUS"],
      [1, "DUPLICATE_ID_AMBIGUOUS"],
      [2, "DUPLICATE_ID_AMBIGUOUS"],
    ]);
    expect(dupIssues(tied)).toHaveLength(1);
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["invalid", "not a time"],
    ["unrepresentable", 1e300],
  ])("an update time that is %s on any copy makes the group ambiguous", (_label, bad) => {
    const res = run(copies([9, bad, 5]));
    expect(res.accepted).toEqual([]);
    expect(res.flagged).toHaveLength(3);
    expect(dupIssues(res)).toEqual([
      { code: "DUPLICATE_ID_AMBIGUOUS", sourceId: "dup", duplicateGroup: { occurrences: 3, sampleIndices: [0, 1, 2], truncated: false } },
    ]);
  });

  it(`lists at most ${DUPLICATE_SAMPLE_LIMIT} positions and marks truncation`, () => {
    const ten = dupIssues(run(copies(Array.from({ length: 10 }, (_, i) => i))))[0]!.duplicateGroup!;
    expect(ten).toMatchObject({ occurrences: 10, truncated: false });
    expect(ten.sampleIndices).toEqual([...Array(10).keys()]);
    const eleven = dupIssues(run(copies(Array.from({ length: 11 }, (_, i) => i))))[0]!.duplicateGroup!;
    expect(eleven).toEqual({ occurrences: 11, sampleIndices: [...Array(10).keys()], truncated: true, keptIndex: 10 });
  });

  it("samples file positions in ascending order when groups are interleaved", () => {
    const data = [...copies([1], "a"), ...copies([1], "b"), ...copies([2], "a"), ...copies([3], "b"), ...copies([1], "a")];
    expect(dupIssues(run(data)).map((i) => [i.sourceId, i.duplicateGroup])).toEqual([
      ["a", { occurrences: 3, sampleIndices: [0, 2, 4], truncated: false, keptIndex: 2 }],
      ["b", { occurrences: 2, sampleIndices: [1, 3], truncated: false, keptIndex: 3 }],
    ]);
  });

  it("does not count copies skipped earlier for another reason", () => {
    const data = [...copies([1, 2]), { conversation_id: "dup", update_time: 3 }]; // no mapping
    const res = run(data);
    expect(res.skipped.map((s) => [s.index, s.code])).toEqual([
      [0, "DUPLICATE_ID_SUPERSEDED"],
      [2, "CONVERSATION_MAPPING_MISSING"],
    ]);
    expect(dupIssues(res)[0]!.duplicateGroup).toMatchObject({ occurrences: 2, keptIndex: 1 });
  });

  it("reports identical ID-less conversations as one group", () => {
    const twin = { create_time: 1, mapping: { x: { parent: null, children: [], message: { content: { content_type: "text", parts: ["hi"] } } } } };
    const res = run(Array.from({ length: 25 }, () => twin));
    expect(res.flagged).toHaveLength(25);
    const issues = dupIssues(res);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "CONVERSATION_ID_AMBIGUOUS", duplicateGroup: { occurrences: 25, truncated: true } });
    expect(issues[0]!.duplicateGroup!.sampleIndices).toHaveLength(DUPLICATE_SAMPLE_LIMIT);
  });

  /**
   * Large groups. No wall-clock assertion: the explicit timeout is only a
   * coarse guard (observed run time is well under it). Before F3, 20,000
   * copies of one ID took about 8.6 s and the work grew with copies squared.
   */
  const LARGE = 200_000;
  const GUARD_MS = 30_000;

  it(`resolves ${LARGE.toLocaleString("en")} copies of one ID with exact counts and a bounded report`, () => {
    const times = Array.from({ length: LARGE }, (_, i) => (i === 123_456 ? LARGE * 10 : i));
    const res = run(copies(times));
    expect(res.accepted.map((c) => c.index)).toEqual([123_456]);
    expect(res.skipped).toHaveLength(LARGE - 1);
    expect(res.flagged).toEqual([]);
    expectPartition(res);
    const issues = dupIssues(res);
    expect(issues).toEqual([
      { code: "DUPLICATE_ID_SUPERSEDED", sourceId: "dup", duplicateGroup: { occurrences: LARGE, sampleIndices: [...Array(10).keys()], truncated: true, keptIndex: 123_456 } },
    ]);
    expect(JSON.stringify(res.issues).length).toBeLessThan(300);
  }, GUARD_MS);

  it(`flags ${LARGE.toLocaleString("en")} tied copies with one bounded issue`, () => {
    const res = run(copies(Array.from({ length: LARGE }, () => 7)));
    expect(res.accepted).toEqual([]);
    expect(res.flagged).toHaveLength(LARGE);
    expectPartition(res);
    expect(res.issues).toHaveLength(1);
    expect(JSON.stringify(res.issues).length).toBeLessThan(300);
  }, GUARD_MS);

  it("emits one issue per group for 100,000 two-copy groups", () => {
    const data = Array.from({ length: 200_000 }, (_, i) => ({ conversation_id: `g${i >> 1}`, update_time: i, mapping: {} }));
    const res = run(data);
    expect(res.accepted).toHaveLength(100_000);
    expect(res.skipped).toHaveLength(100_000);
    expectPartition(res);
    expect(res.issues).toHaveLength(100_000);
    expect(res.issues.every((i) => i.duplicateGroup!.occurrences === 2 && i.duplicateGroup!.sampleIndices.length === 2)).toBe(true);
  }, GUARD_MS);

  it("never puts titles or other content in duplicate reports", () => {
    const res = run(copies([1, 2, 2, undefined]));
    const report = JSON.stringify({ issues: res.issues, flagged: res.flagged, skipped: res.skipped });
    expect(report).not.toContain("canary");
  });
});

describe("identifier length limit (Q12)", () => {
  const conv = (ids: Record<string, unknown>) => ({ ...ids, title: "synthetic canary", mapping: {} });
  const run = (data: unknown[]): Ok => {
    const res = parseChatGptExport(data);
    if (!res.ok) throw new Error(res.error.code);
    return res;
  };

  it.each([511, 512])("accepts a conversation_id of %i characters", (n) => {
    const id = "c".repeat(n);
    expect(run([conv({ conversation_id: id })]).accepted.map((c) => c.sourceId)).toEqual([id]);
  });

  it("skips a 513-character conversation_id without falling back to id or a derived ID", () => {
    const res = run([conv({ conversation_id: "c".repeat(513), id: "short-id" })]);
    expect(res.accepted).toEqual([]);
    expect(res.skipped).toEqual([{ index: 0, code: "CONVERSATION_ID_TOO_LONG" }]);
    expect(res.issues).toEqual([{ code: "CONVERSATION_ID_TOO_LONG", index: 0, field: "conversation_id" }]);
  });

  it("skips a 513-character id (no conversation_id) without deriving an ID", () => {
    const mapping = { a: { parent: null, children: [], message: { content: { content_type: "text", parts: ["hi"] } } } };
    const res = run([{ id: "i".repeat(513), mapping }]);
    expect(res.skipped).toEqual([{ index: 0, code: "CONVERSATION_ID_TOO_LONG" }]);
    expect(res.issues.map((i) => i.code)).toEqual(["CONVERSATION_ID_TOO_LONG"]);
  });

  it("counts characters, not UTF-16 code units", () => {
    const emoji = "\u{1F600}";
    expect(run([conv({ conversation_id: emoji.repeat(512) })]).accepted).toHaveLength(1);
    expect(run([conv({ conversation_id: emoji.repeat(513) })]).skipped.map((s) => s.code)).toEqual(["CONVERSATION_ID_TOO_LONG"]);
  });

  it("ignores an oversized id when conversation_id is used, with FIELD_TOO_LONG instead of a mismatch", () => {
    const res = run([conv({ conversation_id: "cid", id: "i".repeat(513) })]);
    expect(res.accepted.map((c) => c.sourceId)).toEqual(["cid"]);
    expect(res.issues).toEqual([{ code: "FIELD_TOO_LONG", index: 0, sourceId: "cid", field: "id" }]);
  });

  it("keeps the rest of the file and never echoes a 1 MB ID", () => {
    const huge = "h".repeat(1_000_000);
    const res = run([conv({ conversation_id: "ok-1" }), conv({ conversation_id: huge }), conv({ id: huge }), conv({ conversation_id: "ok-2", id: huge })]);
    expect(res.accepted.map((c) => c.sourceId)).toEqual(["ok-1", "ok-2"]);
    expect(res.skipped.map((s) => [s.index, s.code])).toEqual([
      [1, "CONVERSATION_ID_TOO_LONG"],
      [2, "CONVERSATION_ID_TOO_LONG"],
    ]);
    expect(JSON.stringify({ issues: res.issues, skipped: res.skipped, flagged: res.flagged }).length).toBeLessThan(500);
  });

  describe("mapping keys and parent references", () => {
    const n = (parent: unknown, children: unknown[] = []) => ({
      parent,
      children,
      message: { author: { role: "user" }, content: { content_type: "text", parts: ["synthetic canary"] } },
    });

    it.each([511, 512])("accepts a mapping key of %i characters", (len) => {
      const key = "k".repeat(len);
      expect(run([{ id: "c", mapping: { [key]: n(null) } }]).accepted).toHaveLength(1);
    });

    it("skips the whole conversation for a 513-character mapping key, keeping the rest of the file", () => {
      const key = "k".repeat(513);
      const res = run([
        { id: "ok-1", mapping: { a: n(null) } },
        { id: "bad", mapping: { r: n(null, [key, "b"]), [key]: n("r"), b: n("r") } },
        { id: "ok-2", mapping: { a: n(null) } },
      ]);
      expect(res.accepted.map((c) => c.sourceId)).toEqual(["ok-1", "ok-2"]);
      expect(res.skipped).toEqual([{ index: 1, code: "CONVERSATION_NODE_ID_TOO_LONG", sourceId: "bad" }]);
      expect(res.issues).toEqual([{ code: "CONVERSATION_NODE_ID_TOO_LONG", index: 1, sourceId: "bad", field: "mapping" }]);
    });

    it("skips the conversation for a 513-character parent reference, naming only the node", () => {
      const res = run([{ id: "bad", mapping: { a: n("p".repeat(513)), b: n("a") } }]);
      expect(res.skipped).toEqual([{ index: 0, code: "CONVERSATION_NODE_ID_TOO_LONG", sourceId: "bad" }]);
      expect(res.issues).toEqual([
        { code: "CONVERSATION_NODE_ID_TOO_LONG", index: 0, sourceId: "bad", field: "parent", nodeId: "a" },
      ]);
    });

    it("counts characters, not UTF-16 code units", () => {
      const emoji = "\u{1F600}";
      expect(run([{ id: "c", mapping: { a: n(emoji.repeat(512)) } }]).accepted).toHaveLength(1);
      expect(run([{ id: "c", mapping: { a: n(emoji.repeat(513)) } }]).skipped.map((x) => x.code)).toEqual([
        "CONVERSATION_NODE_ID_TOO_LONG",
      ]);
    });

    it("skips an ID-less conversation before deriving an ID from the oversized key", () => {
      const res = run([{ mapping: { ["k".repeat(513)]: n(null) } }]);
      expect(res.skipped).toEqual([{ index: 0, code: "CONVERSATION_NODE_ID_TOO_LONG" }]);
      expect(res.issues.map((i) => i.code)).toEqual(["CONVERSATION_NODE_ID_TOO_LONG"]);
    });

    it("does not skip for oversized child entries, message IDs or current_node (the tree is unaffected)", () => {
      const long = "x".repeat(513);
      const res = run([
        { id: "c", current_node: long, mapping: { a: { ...n(null, [long]), message: { ...n(null).message, id: long } } } },
      ]);
      expect(res.accepted).toHaveLength(1);
      expect(res.skipped).toEqual([]);
    });

    it("ignores non-string parents here (they are node warnings in tree.ts)", () => {
      expect(run([{ id: "c", mapping: { a: n(12345) } }]).accepted).toHaveLength(1);
    });

    it("never echoes a 1 MB key or parent, or any content", () => {
      const huge = "h".repeat(1_000_000);
      const res = run([
        { id: "k", mapping: { [huge]: n(null) } },
        { id: "p", mapping: { a: n(huge) } },
      ]);
      expect(res.skipped).toHaveLength(2);
      const report = JSON.stringify({ issues: res.issues, skipped: res.skipped, flagged: res.flagged });
      expect(report.length).toBeLessThan(500);
      expect(report).not.toContain("canary");
    });
  });

  it("does not let an oversized duplicate take part in duplicate resolution", () => {
    const res = run([
      { conversation_id: "d", update_time: 1, mapping: {} },
      { conversation_id: "d".repeat(513), update_time: 2, mapping: {} },
    ]);
    expect(res.accepted.map((c) => c.index)).toEqual([0]);
  });
});
