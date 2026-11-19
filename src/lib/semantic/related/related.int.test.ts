/**
 * Related conversations on temporary databases: the real import, indexer (fake, deterministic
 * vectors: one pseudo-random vector per chunk text) and vector reader. Conversations that
 * share messages share those chunks' vectors, so a "family" is close in meaning; a
 * conversation with only its own text is close to none. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getConversationDetail } from "../../conversations/queries";
import { importText } from "../../../../tests/helpers/import";
import { conversationId, conversationWithTexts, indexWith } from "../../../../tests/helpers/semantic-index";
import { BASE_TIME, exportText } from "../../../../tests/helpers/synthetic-export";
import { createTestDb, type TestDb } from "../../../../tests/helpers/test-db";
import { dropCorrectedVectors } from "../conversation-vectors";
import { dropVectorCache } from "../search/vector-cache";
import { findRelated, type RelatedResult } from "./related";

let dbs: TestDb[] = [];
const db = () => {
  const t = createTestDb();
  dbs.push(t);
  return t;
};
beforeEach(() => {
  dropVectorCache();
  dropCorrectedVectors();
});
afterEach(async () => {
  for (const t of dbs) await t.cleanup();
  dbs = [];
});

const LONG = "with enough words in it to count as a full passage for the semantic index";
const BOILERPLATE = `I hope this helps! If you have any other questions, feel free to ask, ${LONG}.`;
/** Family members share two messages and have one of their own; some also end with the same boilerplate. */
const member = (family: string, i: number, boilerplate: boolean, time: number) =>
  conversationWithTexts(
    `${family}-${i}`,
    [`The first shared question about ${family} ${LONG}.`, `The shared answer about ${family} ${LONG}.`, `A private follow-up ${i} about ${family} ${LONG}.`, ...(boilerplate ? [BOILERPLATE] : [])],
    time,
  );
const loner = (name: string, boilerplate: boolean, time: number) =>
  conversationWithTexts(name, [`Only ${name} asks this ${LONG}.`, `Only ${name} hears this ${LONG}.`, ...(boilerplate ? [BOILERPLATE] : [])], time);
const archive = () => [
  ...[0, 1, 2, 3].map((i) => member("alpha", i, i < 2, BASE_TIME + i)),
  ...[0, 1, 2].map((i) => member("beta", i, i < 2, BASE_TIME + 10 + i)),
  loner("solo-quiet", false, BASE_TIME + 20),
  loner("solo-polite", true, BASE_TIME + 21),
  // Unrelated conversations, as in any real archive: without them the two families would be
  // most of the archive's average, and centring would remove much of what they share.
  ...Array.from({ length: 16 }, (_, i) => loner(`other-${i}`, false, BASE_TIME + 40 + i)),
];

async function load(t: TestDb, list: unknown[]) {
  expect((await importText(exportText(list), { writer: t.writer })).complete).toBe(true);
}
const titles = (r: RelatedResult) => (r.status === "ok" ? r.related.map((x) => x.title) : r.status);

describe("findRelated", { timeout: 60_000 }, () => {
  it("no index: says so for any conversation", async () => {
    const t = db();
    await load(t, archive());
    expect(await findRelated(t.db, await conversationId(t.db, "alpha-0"))).toEqual({ status: "no-index" });
    expect(await findRelated(t.db, "no-such-conversation")).toEqual({ status: "no-index" });
  });

  it("lists the closest conversations, most similar first, never itself, and nothing for a conversation close to none", async () => {
    const t = db();
    await load(t, archive());
    expect((await indexWith(t)).status).toBe("finished");
    const r = await findRelated(t.db, await conversationId(t.db, "alpha-0"));
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.related.slice(0, 3).map((x) => x.title).sort()).toEqual(["Synthetic alpha-1", "Synthetic alpha-2", "Synthetic alpha-3"]);
    expect(r.related.length).toBeLessThanOrEqual(5);
    expect(r.related.map((x) => x.title)).not.toContain("Synthetic alpha-0");
    const sims = r.related.map((x) => x.similarity);
    expect(sims).toEqual([...sims].sort((a, b) => b - a));
    for (const s of sims) expect(s).toBeGreaterThanOrEqual(0.35);

    expect(await findRelated(t.db, await conversationId(t.db, "solo-quiet"))).toEqual({ status: "ok", related: [] });
    expect(await findRelated(t.db, "no-such-conversation")).toEqual({ status: "not-indexed" });
  });

  it("explains a link with a passage from each side, linked to its message, and never with boilerplate", async () => {
    const t = db();
    await load(t, archive());
    await indexWith(t);
    for (const source of ["alpha-0", "alpha-1", "beta-0", "beta-1", "solo-polite"]) {
      const r = await findRelated(t.db, await conversationId(t.db, source));
      if (r.status !== "ok") throw new Error(r.status);
      for (const x of r.related) {
        if (!x.evidence) continue;
        expect(x.evidence.focus.text).not.toContain("I hope this helps");
        expect(x.evidence.other.text).not.toContain("I hope this helps");
      }
    }
    // alpha-0 and alpha-1 share the boilerplate *and* two family messages: the evidence is a family message.
    const id0 = await conversationId(t.db, "alpha-0");
    const r = await findRelated(t.db, id0);
    if (r.status !== "ok") throw new Error(r.status);
    const one = r.related.find((x) => x.title === "Synthetic alpha-1")!;
    expect(one.evidence).not.toBeNull();
    expect(one.evidence!.focus.text).toMatch(/shared (question|answer) about alpha/);
    expect(one.evidence!.focus.href).toMatch(new RegExp(`^/conversations/${id0}#m-\\d+$`));
    expect(one.evidence!.other.href).toMatch(new RegExp(`^/conversations/${one.id}#m-\\d+$`));
    // The link points at the message that holds the passage.
    const detail = (await getConversationDetail(t.db, id0, { includeHidden: false, page: undefined }))!;
    const message = detail.messages.find((m) => m.number === one.evidence!.focus.messageNumber)!;
    expect(JSON.stringify(message)).toContain(one.evidence!.focus.text.replace(/^… | …$/g, ""));
  });

  it("REGRESSION: many copies of an unrelated boilerplate conversation barely change who is related, and the copies match each other", async () => {
    const t = db();
    const original = archive();
    await load(t, original);
    await indexWith(t);
    const sources = original.map((c) => (c as { conversation_id: string }).conversation_id);
    const listsOf = async () => {
      const out = new Map<string, string[]>();
      for (const source of sources) out.set(source, titles(await findRelated(t.db, await conversationId(t.db, source))) as string[]);
      return out;
    };
    const before = await listsOf();
    // 120 identical template conversations (the same boilerplate exchange), unrelated to everything else.
    await load(t, Array.from({ length: 120 }, (_, i) => conversationWithTexts(`template-${i}`, [`Can you help me with something ${LONG}?`, BOILERPLATE], BASE_TIME + 100 + i)));
    await indexWith(t);
    const after = await listsOf();

    const jaccard = (a: string[], b: string[]) => (a.length + b.length === 0 ? 1 : a.filter((x) => b.includes(x)).length / new Set([...a, ...b]).size);
    let total = 0;
    for (const source of sources) {
      const [a, b] = [before.get(source)!, after.get(source)!];
      expect(b.some((x) => x.startsWith("Synthetic template-")), `${source} lists a template`).toBe(false);
      if (a.length > 0) expect(b, `${source}: its closest conversation is still listed`).toContain(a[0]);
      total += jaccard(a, b);
    }
    expect(total / sources.length).toBeGreaterThanOrEqual(0.9);
    expect(after.get("solo-quiet")).toEqual([]); // still no forced matches

    // Identical conversations still match each other.
    const copies = titles(await findRelated(t.db, await conversationId(t.db, "template-0"))) as string[];
    expect(copies).toHaveLength(5);
    for (const c of copies) expect(c).toMatch(/^Synthetic template-\d+$/);
  });

  it("a conversation imported after indexing isn't indexed yet; after the index changes it is related, with no cache dropped by hand", async () => {
    const t = db();
    await load(t, archive());
    await indexWith(t);
    const id0 = await conversationId(t.db, "alpha-0");
    const before = await findRelated(t.db, id0);
    await load(t, [member("alpha", 4, false, BASE_TIME + 30)]);
    const late = await conversationId(t.db, "alpha-4");
    expect(await findRelated(t.db, late)).toEqual({ status: "not-indexed" });
    expect(await findRelated(t.db, id0)).toEqual(before); // nothing changed in the index yet
    await indexWith(t);
    expect(titles(await findRelated(t.db, id0))).toContain("Synthetic alpha-4");
    expect(titles(await findRelated(t.db, late)).slice(0, 4)).toEqual(expect.arrayContaining(["Synthetic alpha-0", "Synthetic alpha-1", "Synthetic alpha-2", "Synthetic alpha-3"]));
  });
});
