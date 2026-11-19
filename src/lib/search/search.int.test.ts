import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importText } from "../../../tests/helpers/import";
import { exportText, syntheticConversation } from "../../../tests/helpers/synthetic-export";
import { createTestDb, type TestDb } from "../../../tests/helpers/test-db";
import { getConversationDetail } from "../conversations/queries";
import { deleteAllImportedData } from "../data/delete-all";
import { SEARCH_INDEX_TRIGGERS } from "./fts-index";
import { searchLinkHref } from "./link";
import { MAX_QUERY_CHARS } from "./query";
import { SEARCH_RESULTS_PER_PAGE, searchConversations, TITLE_WEIGHT, type SearchOutcome, type SearchResultItem } from "./search";

/**
 * Search query layer (M2.2) against synthetic data in temporary databases.
 * Every conversation and word here is invented; planted words start with
 * "zq" so they occur nowhere else.
 */

let t: TestDb;
beforeEach(() => {
  t = createTestDb();
});
afterEach(async () => {
  await t.cleanup();
});

type ConvSpec = {
  messages?: number;
  title?: string;
  updateTime?: number | null;
  /** Message text by 1-based node number (others keep the synthetic default). */
  texts?: Record<number, string>;
  /** Hidden messages: a system message, or one marked visually hidden in the export. */
  hidden?: Record<number, "system" | "visual">;
  /** Alternative versions (off the stored path) of node `at`, with their text. */
  branches?: { at: number; text: string }[];
};

type Node = { id: string; parent: string | null; children: string[]; message: Record<string, unknown> | null };

/** A synthetic linear conversation with planted texts, hidden messages and branches. */
function conv(id: string, spec: ConvSpec = {}): Record<string, unknown> {
  const c = syntheticConversation({ id, messages: spec.messages ?? 6, title: spec.title ?? `Plain ${id}`, updateTime: spec.updateTime, tag: "plain" });
  const mapping = c.mapping as Record<string, Node>;
  for (const [k, text] of Object.entries(spec.texts ?? {})) {
    (mapping[`n${k}`]!.message!.content as { parts: string[] }).parts = [text];
  }
  for (const [k, kind] of Object.entries(spec.hidden ?? {})) {
    const message = mapping[`n${k}`]!.message!;
    if (kind === "system") message.author = { role: "system" };
    else message.metadata = { is_visually_hidden_from_conversation: true };
  }
  for (const [i, b] of (spec.branches ?? []).entries()) {
    const original = mapping[`n${b.at}`]!;
    const altId = `n${b.at}-alt${i}`;
    const message = { ...original.message!, id: `m${b.at}-alt${i}`, content: { content_type: "text", parts: [b.text] } };
    mapping[altId] = { id: altId, parent: original.parent, children: [], message };
    mapping[original.parent!]!.children.push(altId);
  }
  return c;
}

const importAll = (convs: unknown[]) => importText(exportText(convs), { writer: t.writer });
const sourceIdOf = async (id: string) => (await t.db.conversation.findUniqueOrThrow({ where: { id }, select: { sourceId: true } })).sourceId;

async function search(q: unknown, page?: string | string[]): Promise<Extract<SearchOutcome, { status: "ok" }>> {
  const r = await searchConversations(t.db, q, page);
  if (r.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r;
}
const sourceIds = async (results: SearchResultItem[]) => Promise.all(results.map((r) => sourceIdOf(r.conversationId)));
const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

/** Opens the link exactly as the detail page would and returns the message it points at. */
async function linkedMessage(r: SearchResultItem) {
  expect(r.link.messageNumber).not.toBeNull();
  const d = (await getConversationDetail(t.db, r.conversationId, { includeHidden: false, page: String(r.link.page) }))!;
  expect(d.page).toBe(r.link.page);
  const m = d.messages.find((x) => x.number === r.link.messageNumber);
  expect(m, `message #${r.link.messageNumber} on page ${r.link.page}`).toBeDefined();
  return m!;
}

/** Raw bm25 of every matching row of one index (for checking the ranking). */
function rawBm25(table: "message_fts" | "conversation_fts", match: string): number[] {
  const db = new Database(t.file, { readonly: true });
  try {
    return (db.prepare(`SELECT bm25("${table}") AS s FROM "${table}" WHERE "${table}" MATCH ? ORDER BY rowid`).all(match) as { s: number }[]).map((r) => r.s);
  } finally {
    db.close();
  }
}

describe("titles and message text", () => {
  it("finds title and message matches, ignoring case and accents", async () => {
    await importAll([
      conv("t", { title: "Zqalpha planning notes" }),
      conv("m", { texts: { 3: "We met at the ZQBETA Café on Tuesday." } }),
      conv("none"),
    ]);
    const title = await search("zqalpha");
    expect(await sourceIds(title.results)).toEqual(["t"]);
    expect(title.results[0]).toMatchObject({ titleMatch: true, matchingMessages: 0, snippet: null, link: { page: 1, messageNumber: null } });
    expect(title.results[0]!.titleSegments).toEqual([
      { text: "Zqalpha", match: true },
      { text: " planning notes", match: false },
    ]);

    const msg = await search("zqbeta");
    expect(await sourceIds(msg.results)).toEqual(["m"]);
    expect(msg.results[0]).toMatchObject({ titleMatch: false, matchingMessages: 1 });
    expect(msg.results[0]!.snippet!.filter((s) => s.match).map((s) => s.text)).toEqual(["ZQBETA"]);
    expect(msg.results[0]!.titleSegments).toEqual([{ text: "Plain m", match: false }]);

    for (const q of ["cafe", "CAFÉ", "café", "Café", "ＺＱＢＥＴＡ"]) expect(await sourceIds((await search(q)).results), q).toEqual(["m"]);
    expect((await search("zqmissing")).total).toBe(0);
  });

  it("requires every term, in the title or the messages", async () => {
    await importAll([
      conv("both", { texts: { 1: "zqone and zqtwo together" } }),
      conv("one", { texts: { 1: "only zqone here" } }),
      conv("split", { title: "zqone title", texts: { 2: "zqtwo in a message" } }),
    ]);
    expect(await sourceIds((await search("zqone zqtwo")).results)).toEqual(["both"]);
    // Terms are matched per title or per message, never across the two.
    expect((await search("zqone")).total).toBe(3);
  });

  it("matches phrases only as adjacent words, in order", async () => {
    await importAll([
      conv("adjacent", { texts: { 2: "a red apple and a green pear" } }),
      conv("apart", { texts: { 2: "apple trees are red in autumn" } }),
    ]);
    expect(await sourceIds((await search(`"red apple"`)).results)).toEqual(["adjacent"]);
    expect((await search(`"apple red"`)).total).toBe(0);
    expect((await search("red apple")).total).toBe(2);
  });

  it("matches a trailing prefix on the last word", async () => {
    await importAll([
      conv("a", { texts: { 1: "zqprogramming languages" } }),
      conv("b", { texts: { 1: "zqprogress report" } }),
      conv("c", { title: "Zqprogram review" }),
      conv("d", { texts: { 1: "unrelated zqpr text" } }),
    ]);
    expect((await sourceIds((await search("zqprog*")).results)).sort()).toEqual(["a", "b", "c"]);
    expect((await search("zqprog")).total).toBe(0);
    expect((await sourceIds((await search("languages zqprog*")).results))).toEqual(["a"]);
  });
});

describe("special characters and FTS5 syntax are searched as words", () => {
  beforeEach(async () => {
    await importAll([
      conv("cpp", { texts: { 1: "I write zqlang C++ every day" } }),
      conv("dotnet", { texts: { 1: "zqlang uses the .NET runtime" } }),
      conv("email", { texts: { 1: "zqlang mail alice@example.com today" } }),
      conv("alice", { texts: { 1: "zqlang alice wrote example code" } }),
      conv("foo", { texts: { 1: "zqop foo and bar" } }),
      conv("notfoo", { texts: { 1: "zqop not foo here" } }),
      conv("dash", { texts: { 1: "zqop state-of-the-art" } }),
    ]);
  });

  it("C++, .NET and email-like strings", async () => {
    expect(await sourceIds((await search("zqlang C++")).results)).toEqual(["cpp"]);
    expect(await sourceIds((await search("zqlang .NET")).results)).toEqual(["dotnet"]);
    expect(await sourceIds((await search("alice@example.com")).results)).toEqual(["email"]);
    expect(await sourceIds((await search("state-of-the-art")).results)).toEqual(["dash"]);
  });

  it("operators are words: OR and NOT do not change the meaning, NEAR and column filters do nothing special", async () => {
    expect((await search("foo OR zqnothing")).total).toBe(0); // all three words required
    expect(await sourceIds((await search("zqop NOT foo")).results)).toEqual(["notfoo"]); // "not" is a required word
    expect(await sourceIds((await search("zqop AND bar")).results)).toEqual(["foo"]);
    expect((await search("NEAR(foo bar)")).total).toBe(0); // the phrase "near foo" occurs nowhere
    expect((await search("title:zqop")).total).toBe(0); // the phrase "title zqop", not a column filter
    expect((await search("contentText:foo")).total).toBe(0);
  });

  it("no input from a hostile set produces a database error", async () => {
    const inputs = [
      `"`, `""`, `"""`, `*`, `**`, `foo*bar*`, `"foo"*`, `(`, `)`, `()`, `NEAR(`, `NEAR()`, `NEAR(a b, -1)`, `a:`, `:a`, `{a}:b`, `^`, `^a`,
      `-a`, `+a`, `a AND`, `OR`, `NOT`, `AND OR NOT`, `a\u0000b`, `‮abc`, `\ud800`, `abc\udfff`, `x`, `rank:1`, `rowid`,
      `message_fts:foo`, `'; DROP TABLE "Message"; --`, `%`, `_`, `\\`, `a'b`, `𝒜𝒜`, `ﷺ`, `x`.repeat(MAX_QUERY_CHARS),
    ];
    let seed = 11;
    const pieces = [`"`, "*", "(", ")", ":", "^", "+", "-", "AND", "OR", "NOT", "NEAR", "{", "}", "a", "zq", "é", " ", "\u0000", "🙂", "1", ","];
    const rand = (n: number) => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648), seed % n);
    for (let i = 0; i < 300; i++) inputs.push(Array.from({ length: 1 + rand(12) }, () => pieces[rand(pieces.length)]).join(rand(2) ? " " : ""));
    for (const q of inputs) {
      const r = await searchConversations(t.db, q, undefined);
      expect(r.status, JSON.stringify(q)).not.toBe("error");
    }
  });
});

describe("validation outcomes", () => {
  it("returns typed rejections without querying", async () => {
    expect(await searchConversations(t.db, "", undefined)).toEqual({ status: "invalid", rejection: { reason: "empty" } });
    expect(await searchConversations(t.db, "!!!", undefined)).toEqual({ status: "invalid", rejection: { reason: "no_terms" } });
    expect(await searchConversations(t.db, "a".repeat(MAX_QUERY_CHARS + 1), undefined)).toMatchObject({ status: "invalid", rejection: { reason: "too_long" } });
    expect(await searchConversations(t.db, Array.from({ length: 17 }, (_, i) => `w${i}`).join(" "), undefined)).toMatchObject({ status: "invalid", rejection: { reason: "too_many_terms" } });
    expect(await searchConversations(t.db, "a*", undefined)).toMatchObject({ status: "invalid", rejection: { reason: "prefix_too_short" } });
  });

  it("an empty database gives an empty first page", async () => {
    expect(await searchConversations(t.db, "anything", "3")).toEqual({ status: "ok", results: [], total: 0, page: 1, totalPages: 1 });
  });
});

describe("ranking", () => {
  it("FTS5's bm25 is lower-is-better, and results are ordered by it ascending", async () => {
    const filler = Array.from({ length: 60 }, (_, i) => `filler${i}`).join(" ");
    await importAll([
      conv("weak", { texts: { 1: `zqrank ${filler}` } }),
      conv("strong", { texts: { 1: "zqrank zqrank zqrank" } }),
      conv("middle", { texts: { 1: `zqrank zqrank ${filler.slice(0, 120)}` } }),
    ]);
    // Direction check on the raw index: the dense short message scores lowest.
    const db = new Database(t.file, { readonly: true });
    const raw = db.prepare(`SELECT m."contentText" AS text, bm25("message_fts") AS s FROM "message_fts" JOIN "Message" m ON m.rowid = "message_fts".rowid WHERE "message_fts" MATCH 'zqrank' ORDER BY s`).all() as { text: string; s: number }[];
    db.close();
    expect(raw[0]!.text).toBe("zqrank zqrank zqrank");
    expect(raw.every((r) => r.s < 0)).toBe(true);

    const r = await search("zqrank");
    expect(await sourceIds(r.results)).toEqual(["strong", "middle", "weak"]);
    const scores = r.results.map((x) => x.score);
    expect(scores).toEqual([...scores].sort((a, b) => a - b));
    expect(scores[0]).toBe(raw[0]!.s);
  });

  it(`a title match scores its bm25 × ${TITLE_WEIGHT}; a conversation scores its best match`, async () => {
    await importAll([
      conv("title", { title: "Zqweight planning" }),
      conv("message", { texts: { 2: "zqweight in a message" } }),
      conv("both", { title: "Zqweight both", texts: { 4: "zqweight zqweight zqweight" } }),
    ]);
    const r = await search("zqweight");
    const by = new Map((await sourceIds(r.results)).map((s, i) => [s, r.results[i]!]));
    const titleScores = rawBm25("conversation_fts", "zqweight"); // rowid order = import order: title, both
    const messageScores = rawBm25("message_fts", "zqweight"); // message, both
    expect(by.get("title")!.score).toBeCloseTo(TITLE_WEIGHT * titleScores[0]!, 12);
    expect(by.get("message")!.score).toBeCloseTo(messageScores[0]!, 12);
    expect(by.get("both")!.score).toBeCloseTo(Math.min(messageScores[1]!, TITLE_WEIGHT * titleScores[1]!), 12);
    expect(by.get("both")).toMatchObject({ titleMatch: true, matchingMessages: 1 });
    expect(r.results.map((x) => x.score)).toEqual(r.results.map((x) => x.score).sort((a, b) => a - b));
  });

  it("the title weight changes the order: a title that scores worse unweighted ranks first when doubled", async () => {
    await importAll([
      ...Array.from({ length: 10 }, (_, i) => conv(`f${i}`, { title: `Plain f${i}` })),
      conv("msg", { title: "Other words", texts: { 1: "zqequal one two three four five" } }),
      conv("ttl", { title: "zqequal" }),
    ]);
    const message = rawBm25("message_fts", "zqequal")[0]!;
    const title = rawBm25("conversation_fts", "zqequal")[0]!;
    expect(title).toBeGreaterThan(message); // unweighted, the message match would rank first
    expect(TITLE_WEIGHT * title).toBeLessThan(message); // weighted, the title match does
    const r = await search("zqequal");
    expect(await sourceIds(r.results)).toEqual(["ttl", "msg"]);
  });
});

describe("pagination", () => {
  it("is deterministic: equal scores ordered by update time (missing last), then id; every result exactly once", async () => {
    const convs = Array.from({ length: 45 }, (_, i) =>
      conv(`tie${String(i).padStart(2, "0")}`, { title: "Same", texts: { 1: "zqtie common text" }, updateTime: i % 9 === 0 ? null : 1_767_300_000 + (i % 7) }),
    );
    await importAll(convs);
    const pages = [await search("zqtie"), await search("zqtie", "2"), await search("zqtie", "3")];
    expect(pages.map((p) => p.results.length)).toEqual([SEARCH_RESULTS_PER_PAGE, SEARCH_RESULTS_PER_PAGE, 5]);
    expect(pages.every((p) => p.total === 45 && p.totalPages === 3)).toBe(true);
    const all = pages.flatMap((p) => p.results);
    expect(new Set(all.map((r) => r.conversationId)).size).toBe(45);
    expect(new Set(all.map((r) => r.score)).size).toBe(1); // identical documents, identical scores
    const expected = [...all].sort((a, b) => {
      if (a.updatedAtSec !== b.updatedAtSec) {
        if (a.updatedAtSec === null) return 1;
        if (b.updatedAtSec === null) return -1;
        return b.updatedAtSec - a.updatedAtSec;
      }
      return a.conversationId < b.conversationId ? 1 : -1;
    });
    expect(all.map((r) => r.conversationId)).toEqual(expected.map((r) => r.conversationId));
    const again = [await search("zqtie"), await search("zqtie", "2"), await search("zqtie", "3")].flatMap((p) => p.results);
    expect(again.map((r) => r.conversationId)).toEqual(all.map((r) => r.conversationId));
  });

  it("clamps pages like the conversation list", async () => {
    await importAll(Array.from({ length: 25 }, (_, i) => conv(`p${i}`, { texts: { 1: "zqpage" } })));
    expect((await search("zqpage", "99")).page).toBe(2);
    expect((await search("zqpage", "abc")).page).toBe(1);
    expect((await search("zqpage", "0")).page).toBe(1);
    expect((await search("zqpage", ["2", "1"])).page).toBe(2);
  });
});

describe("visibility: only titles and messages the detail page shows", () => {
  beforeEach(async () => {
    await importAll([
      conv("hidden", { texts: { 2: "zqhidden in a system message", 3: "zqvisual marked hidden" }, hidden: { 2: "system", 3: "visual" } }),
      conv("branch", { texts: { 3: "on the path" }, branches: [{ at: 3, text: "zqbranch only in a regenerated version" }] }),
      conv("mixed", { texts: { 2: "zqmix hidden copy", 5: "zqmix visible copy" }, hidden: { 2: "system" }, branches: [{ at: 4, text: "zqmix branch copy" }] }),
      conv("titled", { title: "Zqtitled conversation", texts: { 2: "zqtitled in a hidden message" }, hidden: { 2: "system" } }),
    ]);
  });

  it("matches only in hidden or branch messages are neither returned nor counted", async () => {
    for (const q of ["zqhidden", "zqvisual", "zqbranch", "regenerated"]) {
      expect(await search(q), q).toEqual({ status: "ok", results: [], total: 0, page: 1, totalPages: 1 });
    }
  });

  it("a conversation with a visible match counts and links only its visible matches", async () => {
    const r = await search("zqmix");
    expect(await sourceIds(r.results)).toEqual(["mixed"]);
    expect(r.results[0]!.matchingMessages).toBe(1);
    expect((await linkedMessage(r.results[0]!)).sourceNodeId).toBe("n5");
    expect(r.results[0]!.snippet!.map((s) => s.text).join("")).toContain("visible copy");
  });

  it("a title match is returned even when the only message match is hidden", async () => {
    const r = await search("zqtitled");
    expect(await sourceIds(r.results)).toEqual(["titled"]);
    expect(r.results[0]).toMatchObject({ titleMatch: true, matchingMessages: 0, snippet: null, link: { messageNumber: null, page: 1 } });
  });
});

describe("links to visible messages", () => {
  it("count only displayed messages: hidden messages before the match are skipped", async () => {
    await importAll([conv("h", { messages: 8, texts: { 6: "zqlink target" }, hidden: { 2: "system", 4: "visual" } })]);
    const [r] = (await search("zqlink")).results;
    expect(r!.link).toMatchObject({ page: 1, messageNumber: 4 }); // n1, n3, n5, n6
    expect((await linkedMessage(r!)).sourceNodeId).toBe("n6");
    expect(searchLinkHref(r!.link)).toBe(`/conversations/${r!.conversationId}#m-4`);
  });

  it("alternative branches are not counted and never linked", async () => {
    await importAll([
      conv("b", {
        messages: 7,
        texts: { 5: "zqpath target", 3: "path three" },
        branches: [
          { at: 2, text: "zqpath alternative two" },
          { at: 3, text: "alternative three" },
        ],
      }),
    ]);
    const [r] = (await search("zqpath")).results;
    expect(r!.matchingMessages).toBe(1);
    expect(r!.link.messageNumber).toBe(5);
    expect((await linkedMessage(r!)).sourceNodeId).toBe("n5");
  });

  it("conversations over 1,000 messages link to the right page and number", async () => {
    // 2,100 messages; every 10th is a system message (hidden), as in the detail-page tests.
    const hidden: Record<number, "system"> = {};
    for (let k = 10; k <= 2_100; k += 10) hidden[k] = "system";
    await importAll([
      conv("long", {
        messages: 2_100,
        hidden,
        texts: { 999: "zqearly target", 1_500: "zqmiddle target", 2_099: "zqlate target", 2_100: "zqlate hidden copy" },
      }),
    ]);
    // Number = node − hidden nodes up to it (99 before n999, 209 before n2099).
    const cases: [string, string, number, number][] = [
      ["zqearly", "n999", 1, 999 - 99],
      ["zqlate", "n2099", 2, 2_099 - 209],
    ];
    for (const [q, node, page, number] of cases) {
      const [r] = (await search(q)).results;
      expect(r!.link, q).toEqual({ conversationId: r!.conversationId, page, messageNumber: number });
      expect((await linkedMessage(r!)).sourceNodeId, q).toBe(node);
      expect(searchLinkHref(r!.link)).toBe(`/conversations/${r!.conversationId}${page > 1 ? `?page=${page}` : ""}#m-${number}`);
    }
    // n1500 is a system message (every 10th), so its match is hidden: not found.
    expect((await search("zqmiddle")).total).toBe(0);
    // n2100 (hidden) also holds zqlate; only the visible n2099 counts.
    expect((await search("zqlate")).results[0]!.matchingMessages).toBe(1);
  });

  it("a visible match on page 2 of a long conversation", async () => {
    const hidden: Record<number, "system"> = {};
    for (let k = 10; k <= 2_100; k += 10) hidden[k] = "system";
    await importAll([conv("long2", { messages: 2_100, hidden, texts: { 1_501: "zqpagetwo target" } })]);
    const [r] = (await search("zqpagetwo")).results;
    expect(r!.link).toMatchObject({ page: 2, messageNumber: 1_501 - 150 });
    expect((await linkedMessage(r!)).sourceNodeId).toBe("n1501");
  });

  it("links the best match; equal matches link the earliest", async () => {
    await importAll([
      conv("best", { texts: { 2: `zqbest ${"filler ".repeat(40)}`, 5: "zqbest zqbest" } }),
      conv("tie", { texts: { 2: "zqtwice alpha", 5: "zqtwice alpha" } }),
    ]);
    const best = (await search("zqbest")).results[0]!;
    expect(best.matchingMessages).toBe(2);
    expect((await linkedMessage(best)).sourceNodeId).toBe("n5");
    const tie = (await search("zqtwice")).results[0]!;
    expect((await linkedMessage(tie)).sourceNodeId).toBe("n2");
  });

  it("every link opens a displayed message that contains the term (mixed corpus)", async () => {
    const convs = Array.from({ length: 12 }, (_, i) =>
      conv(`mix${i}`, {
        messages: 10 + i * 3,
        texts: { [3 + (i % 5)]: `zqcross term ${i}`, [8 + i]: `zqcross later ${i}` },
        hidden: (i % 2 ? { [2 + (i % 3)]: "system", 7: "visual" } : { [2 + (i % 3)]: "system" }) as Record<number, "system" | "visual">,
        branches: i % 3 === 0 ? [{ at: 4, text: "zqcross in a branch" }] : [],
      }),
    );
    await importAll(convs);
    const r = await search("zqcross");
    expect(r.total).toBe(12);
    for (const item of r.results) expect(fold((await linkedMessage(item)).contentText)).toContain("zqcross");
  });
});

describe("snippets", () => {
  it("forged markers, markup and long tokens stay plain, capped text", async () => {
    const forged = "fake  ";
    await importAll([
      conv("snip", {
        title: "Zqsnip <b>title</b>",
        texts: { 2: `${"x".repeat(5_000)} ${forged} <script>alert(1)</script> zqsnip <b>bold</b> ${"y".repeat(5_000)}` },
      }),
    ]);
    const [r] = (await search("zqsnip")).results;
    const segments = r!.snippet!;
    expect(segments.filter((s) => s.match).map((s) => s.text)).toEqual(["zqsnip"]);
    const text = segments.map((s) => s.text).join("");
    expect(text).toContain("<script>alert(1)</script>");
    expect(text).toContain("<b>bold</b>");
    expect(text).toContain(forged);
    for (const s of segments) {
      expect(Array.from(s.text).length).toBeLessThanOrEqual(121);
      expect(s.text).not.toMatch(/[-][0-9a-f]{32}[-]/); // no real marker survives
    }
    expect(r!.titleSegments).toEqual([
      { text: "Zqsnip", match: true },
      { text: " <b>title</b>", match: false },
    ]);
  });

  it("marks every matched term and prefix in the snippet", async () => {
    await importAll([conv("terms", { texts: { 1: "first zqalpha then zqbetamax and more zqalpha words" } })]);
    const [r] = (await search("zqalpha zqbeta*")).results;
    expect(r!.snippet!.filter((s) => s.match).map((s) => s.text)).toEqual(["zqalpha", "zqbetamax", "zqalpha"]);
  });
});

describe("index changes: re-import, deletion, missing index", () => {
  it("a replacing re-import drops old words and adds new ones; an unchanged one adds no duplicates", async () => {
    const v1 = conv("r", { title: "Zqoldtitle", texts: { 2: "zqoldword here" }, updateTime: 1_767_300_000 });
    const v2 = conv("r", { title: "Zqnewtitle", texts: { 2: "zqnewword here" }, updateTime: 1_767_400_000 });
    await importAll([v1]);
    await importAll([v1]);
    expect((await search("zqoldword")).total).toBe(1);
    await importAll([v2]);
    for (const q of ["zqoldword", "zqoldtitle"]) expect((await search(q)).total, q).toBe(0);
    for (const q of ["zqnewword", "zqnewtitle"]) expect((await search(q)).total, q).toBe(1);
    const [r] = (await search("zqnewword")).results;
    expect((await linkedMessage(r!)).contentText).toBe("zqnewword here");
  });

  it("after delete-all nothing is found", async () => {
    await importAll([conv("d", { title: "Zqgone", texts: { 1: "zqgone text" } })]);
    expect((await search("zqgone")).total).toBe(1);
    const del = await deleteAllImportedData({ writer: t.writer });
    expect(del.status).toBe("complete");
    expect(await search("zqgone")).toEqual({ status: "ok", results: [], total: 0, page: 1, totalPages: 1 });
  });

  it("a database without the search-index migration returns DB_NOT_MIGRATED", async () => {
    await importAll([conv("x", { texts: { 1: "zqmissing" } })]);
    const raw = new Database(t.file);
    for (const tr of SEARCH_INDEX_TRIGGERS) raw.exec(`DROP TRIGGER "${tr}"`);
    raw.exec(`DROP TABLE "message_fts"; DROP TABLE "conversation_fts";`);
    raw.close();
    const reader = t.reader();
    expect(await searchConversations(reader, "zqmissing", undefined)).toEqual({ status: "error", code: "DB_NOT_MIGRATED" });
    // Validation still comes first and needs no database.
    expect(await searchConversations(reader, "", undefined)).toEqual({ status: "invalid", rejection: { reason: "empty" } });
  });
});

describe("privacy", () => {
  it("logs nothing and never returns or searches raw payloads", async () => {
    const spies = (["log", "info", "warn", "error", "debug", "trace"] as const).map((k) => vi.spyOn(console, k));
    try {
      await importAll([conv("p", { title: "Zqprivate", texts: { 2: "zqvisible text" } })]);
      // Plant a raw payload with a canary on the matching message (test-only, temporary database).
      const raw = new Database(t.file);
      raw.prepare(`UPDATE "Message" SET "rawContentJson" = ? WHERE "contentText" = 'zqvisible text'`).run(JSON.stringify({ canary: "zqrawcanary" }));
      raw.close();
      const hit = await searchConversations(t.db, "zqvisible", undefined);
      expect(hit.status).toBe("ok");
      expect(JSON.stringify(hit)).not.toContain("zqrawcanary");
      expect(JSON.stringify(hit)).not.toContain("rawContentJson");
      expect(await search("zqrawcanary")).toMatchObject({ total: 0 }); // raw payloads are not indexed
      await searchConversations(t.db, `"bad (query* NEAR`, "x");
      await searchConversations(t.db, "", undefined);
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  it("the SQL binds the query as a parameter and never names rawContentJson", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "lib", "search", "search.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("rawContentJson");
    // Only constants and placeholder lists are interpolated into SQL text.
    const interpolations = [...code.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]!.trim());
    const sqlInterpolations = interpolations.filter((x) => !x.startsWith("`"));
    expect(new Set(sqlInterpolations)).toEqual(
      new Set(["VISIBLE", "TITLE_WEIGHT", "placeholders(n)", "pairs(n)", "SNIPPET_TOKENS", "prefix ? ROWID_FILTER : ROWID_SEEK"]),
    );
    expect(code).not.toMatch(/\$queryRaw(Unsafe)?`/); // no tagged-template queries built from input
    expect(code).not.toContain("$executeRaw");
  });
});
