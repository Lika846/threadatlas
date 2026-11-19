import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixtureText } from "../../../tests/helpers/fixtures";
import { importText } from "../../../tests/helpers/import";
import { BASE_TIME, exportText, syntheticConversation } from "../../../tests/helpers/synthetic-export";
import { createTestDb, type TestDb } from "../../../tests/helpers/test-db";
import { parseExportText } from "../import/validate-export";
import {
  CONVERSATIONS_PER_PAGE,
  getConversationDetail,
  isConversationId,
  listConversations,
  MESSAGES_PER_PAGE,
  parsePage,
} from "./queries";

let t: TestDb;
beforeEach(() => {
  t = createTestDb();
});
afterEach(async () => {
  await t.cleanup();
});

const importAll = (convs: unknown[]) => importText(exportText(convs), { writer: t.writer });
const idOf = async (sourceId: string) => (await t.db.conversation.findFirstOrThrow({ where: { sourceId }, select: { id: true } })).id;
const detail = (id: string, over: { includeHidden?: boolean; page?: string } = {}) =>
  getConversationDetail(t.db, id, { includeHidden: over.includeHidden ?? false, page: over.page });

describe("parsePage and ids", () => {
  it.each<[string | string[] | undefined, number, number]>([
    [undefined, 5, 1], ["1", 5, 1], ["3", 5, 3], ["5", 5, 5], ["6", 5, 5], ["999999999", 5, 5],
    ["0", 5, 1], ["-1", 5, 1], ["abc", 5, 1], ["2.5", 5, 1], ["1e3", 5, 1], [" 2", 5, 1], ["", 5, 1],
    ["9999999999", 5, 1], [["2", "4"], 5, 2], ["3", 0, 1],
  ])("parsePage(%j, %d) = %d", (raw, total, expected) => {
    expect(parsePage(raw, total)).toBe(expected);
  });

  it("only looks up well-formed internal ids", () => {
    expect(isConversationId("cmw3fe2uy0zhad1sbme3cwj8h")).toBe(true);
    for (const bad of ["", "A".repeat(10), "a".repeat(65), "x'; DROP", "../etc", "id with space"]) expect(isConversationId(bad)).toBe(false);
  });
});

describe("listConversations", () => {
  it("orders by update time, newest first, missing times last, ties by id", async () => {
    await importAll([
      syntheticConversation({ id: "old", updateTime: BASE_TIME + 10 }),
      syntheticConversation({ id: "new", updateTime: BASE_TIME + 30 }),
      syntheticConversation({ id: "untimed", updateTime: null }),
      syntheticConversation({ id: "tie-a", updateTime: BASE_TIME + 20 }),
      syntheticConversation({ id: "tie-b", updateTime: BASE_TIME + 20 }),
    ]);
    const list = await listConversations(t.db, undefined);
    const order = await Promise.all(list.items.map(async (i) => (await t.db.conversation.findUniqueOrThrow({ where: { id: i.id } })).sourceId));
    expect(order[0]).toBe("new");
    expect(order.slice(1, 3).sort()).toEqual(["tie-a", "tie-b"]);
    expect(order.slice(3)).toEqual(["old", "untimed"]);
    // Ties are ordered by internal id, descending, so pages are stable.
    const ties = list.items.slice(1, 3).map((i) => i.id);
    expect(ties).toEqual([...ties].sort().reverse());
    expect(list).toMatchObject({ total: 5, page: 1, totalPages: 1 });
  });

  it("pages 50 at a time and clamps out-of-range pages", async () => {
    await importAll(Array.from({ length: 55 }, (_, i) => syntheticConversation({ id: `c${i}`, updateTime: BASE_TIME + i, messages: 1 })));
    const p1 = await listConversations(t.db, "1");
    const p2 = await listConversations(t.db, "2");
    expect(p1.items).toHaveLength(CONVERSATIONS_PER_PAGE);
    expect(p2.items).toHaveLength(5);
    expect(p1.totalPages).toBe(2);
    expect(new Set([...p1.items, ...p2.items].map((i) => i.id)).size).toBe(55);
    expect((await listConversations(t.db, "99")).page).toBe(2);
    expect((await listConversations(t.db, "junk")).page).toBe(1);
  });

  it("returns only the listed columns", async () => {
    await importAll([syntheticConversation({ id: "a" })]);
    const { items } = await listConversations(t.db, undefined);
    expect(Object.keys(items[0]!).sort()).toEqual(["createdAtSec", "id", "title", "updatedAtSec", "visibleMessageCount"]);
  });

  it("is empty for an empty database", async () => {
    expect(await listConversations(t.db, undefined)).toEqual({ items: [], total: 0, page: 1, totalPages: 1 });
  });
});

describe("getConversationDetail", () => {
  it("shows the stored visible path in pathIndex order, without structural nodes (R55)", async () => {
    const text = fixtureText("branching.json");
    await importText(text, { writer: t.writer });
    const parsed = parseExportText(text);
    if (!parsed.ok) throw new Error("parse");
    const c = parsed.conversations[0]!;
    const expected = c.nodes.filter((n) => n.pathIndex !== null && !n.isStructural && !n.isHidden).sort((a, b) => a.pathIndex! - b.pathIndex!);
    const d = (await detail(await idOf(c.sourceId)))!;
    expect(d.messages.map((m) => m.sourceNodeId)).toEqual(expected.map((n) => n.sourceNodeId));
    expect(d.messages.map((m) => m.contentText)).toEqual(expected.map((n) => n.contentText));
    expect(d.messages.map((m) => m.number)).toEqual(expected.map((_, i) => i + 1));
    // Branch markers: the edited first message and the regenerated answer.
    expect(d.messages.filter((m) => m.versions > 1).map((m) => m.versions)).toEqual([2, 2]);
  });

  it("never returns raw payloads", async () => {
    await importText(fixtureText("unsupported-content.json"), { writer: t.writer });
    const raw = await t.db.message.count({ where: { rawContentJson: { not: null } } });
    expect(raw).toBeGreaterThan(0); // the fixture does store payloads
    for (const c of await t.db.conversation.findMany({ select: { id: true } })) {
      const d = (await detail(c.id, { includeHidden: true }))!;
      for (const m of d.messages) expect("rawContentJson" in m).toBe(false);
      expect(JSON.stringify(d)).not.toContain("rawContentJson");
    }
  });

  it("hides hidden messages unless asked, with an exact count either way", async () => {
    await importText(fixtureText("hidden-messages.json"), { writer: t.writer });
    for (const c of await t.db.conversation.findMany({ select: { id: true } })) {
      const pathHidden = await t.db.message.count({ where: { conversationId: c.id, isStructural: false, isHidden: true, pathIndex: { not: null } } });
      const pathShown = await t.db.message.count({ where: { conversationId: c.id, isStructural: false, isHidden: false, pathIndex: { not: null } } });
      const def = (await detail(c.id))!;
      const all = (await detail(c.id, { includeHidden: true }))!;
      expect(def.hiddenCount).toBe(pathHidden);
      expect(all.hiddenCount).toBe(pathHidden);
      expect(def.messages.every((m) => !m.isHidden)).toBe(true);
      expect(def.displayedCount).toBe(pathShown);
      expect(all.displayedCount).toBe(pathShown + pathHidden);
    }
  });

  // This test has no timing assertion. Importing 2,100 messages took 855 ms on its
  // own but once exceeded Vitest's 5 s default (5.26 s) under the full parallel
  // suite, so the default timeout is replaced with an explicit one (D116).
  it("paginates displayed messages 1,000 per page, after filtering, in path order", { timeout: 30_000 }, async () => {
    // 2,100 messages; every 10th is a system message (hidden by default).
    const conv = syntheticConversation({ id: "long", messages: 2_100 });
    const mapping = conv.mapping as Record<string, { message: { author: { role: string } } | null }>;
    for (let k = 10; k <= 2_100; k += 10) mapping[`n${k}`]!.message!.author.role = "system";
    await importAll([conv]);
    const id = await idOf("long");
    const p1 = (await detail(id))!;
    const p3 = (await detail(id, { page: "3" }))!;
    expect(p1).toMatchObject({ displayedCount: 1_890, hiddenCount: 210, totalPages: 2, page: 1 });
    expect(p1.messages).toHaveLength(MESSAGES_PER_PAGE);
    expect(p3.page).toBe(2); // clamped
    expect(p3.messages).toHaveLength(890);
    expect(p3.messages[0]!.number).toBe(1_001);
    const joined = [...p1.messages, ...p3.messages].map((m) => m.sourceNodeId);
    const expected = Array.from({ length: 2_100 }, (_, i) => `n${i + 1}`).filter((_, i) => (i + 1) % 10 !== 0);
    expect(joined).toEqual(expected);
    const withHidden = (await detail(id, { includeHidden: true, page: "3" }))!;
    expect(withHidden).toMatchObject({ displayedCount: 2_100, totalPages: 3, page: 3 });
    expect(withHidden.messages.map((m) => m.sourceNodeId)).toEqual(Array.from({ length: 100 }, (_, i) => `n${2_001 + i}`));
    expect((await detail(id, { page: "abc" }))!.page).toBe(1);
  });

  it("keeps branch markers on the right message across pages and the hidden toggle", async () => {
    // Regenerate message 1,500 (a branch deep on page 2).
    const conv = syntheticConversation({ id: "fork", messages: 1_600 });
    const mapping = conv.mapping as Record<string, Record<string, unknown>>;
    mapping["n1500-alt"] = { ...mapping.n1500!, id: "n1500-alt", children: [] };
    (mapping.n1499!.children as string[]).push("n1500-alt");
    await importAll([conv]);
    const id = await idOf("fork");
    const p2 = (await detail(id, { page: "2" }))!;
    expect(p2.messages.filter((m) => m.versions > 1).map((m) => [m.sourceNodeId, m.versions])).toEqual([["n1500", 2]]);
    expect((await detail(id))!.messages.some((m) => m.versions > 1)).toBe(false);
  });

  it("returns null for unknown and malformed ids without querying messages", async () => {
    expect(await detail("cunknown00000000000000000")).toBeNull();
    expect(await detail("../../etc/passwd")).toBeNull();
    expect(await detail("")).toBeNull();
  });

  it("handles a conversation with no path (empty mapping → strategy none)", async () => {
    await importAll([syntheticConversation({ id: "empty", extra: { mapping: {}, current_node: null } })]);
    const id = await idOf("empty");
    const d = (await detail(id))!;
    expect(d.conversation.pathStrategy).toBe("none");
    expect(d).toMatchObject({ messages: [], displayedCount: 0, hiddenCount: 0, totalPages: 1, page: 1 });
  });
});
