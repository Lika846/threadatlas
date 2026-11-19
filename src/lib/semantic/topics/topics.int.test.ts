/**
 * The topic map on temporary databases (Mind Map MVP): the real import, indexer (fake,
 * deterministic vectors) and vector reader. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importText } from "../../../../tests/helpers/import";
import { conversationWithTexts, indexWith } from "../../../../tests/helpers/semantic-index";
import { BASE_TIME, exportText } from "../../../../tests/helpers/synthetic-export";
import { createTestDb, type TestDb } from "../../../../tests/helpers/test-db";
import { dropVectorCache } from "../search/vector-cache";
import { buildTopicMap, topicCount, type TopicMap } from "./topics";

let dbs: TestDb[] = [];
const db = () => {
  const t = createTestDb();
  dbs.push(t);
  return t;
};
beforeEach(() => dropVectorCache());
afterEach(async () => {
  for (const t of dbs) await t.cleanup();
  dbs = [];
});

const convs = (n: number) =>
  Array.from({ length: n }, (_, i) => conversationWithTexts(`conv-${String(i).padStart(2, "0")}`, [`A question about subject ${i % 5} and detail ${i}.`, `An answer about subject ${i % 5}, with more words for detail ${i}.`], BASE_TIME + i));

async function load(t: TestDb, list: unknown[]) {
  expect((await importText(exportText(list), { writer: t.writer })).complete).toBe(true);
}
/** Groups as sets of ChatGPT ids (comparable across databases). */
async function groupsBySource(t: TestDb, map: TopicMap): Promise<string[][]> {
  const src = new Map((await t.db.conversation.findMany({ select: { id: true, sourceId: true } })).map((c) => [c.id, c.sourceId]));
  return map.topics.map((x) => x.conversations.map((c) => src.get(c.id)!).sort()).sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
}

describe("buildTopicMap", { timeout: 60_000 }, () => {
  it("is empty without conversations", async () => {
    expect(await buildTopicMap(db().db)).toEqual({ total: 0, indexed: false, topics: [], ungrouped: [] });
  });

  it("before indexing: nothing grouped, every conversation listed, newest first", async () => {
    const t = db();
    await load(t, convs(6));
    const map = await buildTopicMap(t.db);
    expect(map).toMatchObject({ total: 6, indexed: false, topics: [] });
    expect(map.ungrouped.map((c) => c.title)).toEqual(Array.from({ length: 6 }, (_, i) => `Synthetic conv-0${5 - i}`));
  });

  it("after indexing: every conversation in exactly one topic, about √n topics, the same result every time", async () => {
    const t = db();
    await load(t, convs(20));
    expect((await indexWith(t)).status).toBe("finished");
    const map = await buildTopicMap(t.db);
    expect(map.indexed).toBe(true);
    expect(map.ungrouped).toEqual([]);
    expect(map.topics.length).toBeGreaterThan(1);
    expect(map.topics.length).toBeLessThanOrEqual(topicCount(20));
    const ids = map.topics.flatMap((x) => x.conversations.map((c) => c.id));
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
    for (const topic of map.topics) {
      expect(topic.label.length).toBeGreaterThan(0);
      const times = topic.conversations.map((c) => c.updatedAtSec ?? 0);
      expect(times).toEqual([...times].sort((a, b) => b - a)); // newest first
    }
    expect(map.topics.map((x) => x.conversations.length)).toEqual([...map.topics.map((x) => x.conversations.length)].sort((a, b) => b - a));
    dropVectorCache();
    expect(await buildTopicMap(t.db)).toEqual(map);
  });

  it("gives the same groups whatever order the conversations were imported in", async () => {
    const [a, b] = [db(), db()];
    await load(a, convs(16));
    await load(b, [...convs(16)].reverse());
    await indexWith(a);
    await indexWith(b);
    const ga = await groupsBySource(a, await buildTopicMap(a.db));
    dropVectorCache();
    const gb = await groupsBySource(b, await buildTopicMap(b.db));
    expect(gb).toEqual(ga);
  });

  it("lists conversations imported after indexing as not grouped yet", async () => {
    const t = db();
    await load(t, convs(8));
    await indexWith(t);
    await load(t, [conversationWithTexts("late", ["A late conversation."], BASE_TIME + 100)]);
    const map = await buildTopicMap(t.db);
    expect(map.ungrouped.map((c) => c.title)).toEqual(["Synthetic late"]);
    expect(map.topics.flatMap((x) => x.conversations)).toHaveLength(8);
  });
});
