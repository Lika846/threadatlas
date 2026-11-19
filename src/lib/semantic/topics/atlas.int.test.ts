/**
 * The atlas on temporary databases: the real import, indexer (fake, deterministic vectors: one
 * pseudo-random vector per chunk text) and vector reader. Conversations that share a message
 * share that chunk's vector, so "families" of conversations are similar and conversations with
 * only their own text are close to no other. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importText } from "../../../../tests/helpers/import";
import { conversationWithTexts, indexWith } from "../../../../tests/helpers/semantic-index";
import { BASE_TIME, exportText } from "../../../../tests/helpers/synthetic-export";
import { createTestDb, type TestDb } from "../../../../tests/helpers/test-db";
import { dropCorrectedVectors } from "../conversation-vectors";
import { dropVectorCache } from "../search/vector-cache";
import { buildAtlas, dropAtlasCache, rowsFingerprint, type Atlas } from "./atlas";
import { TOPIC_CUT } from "./hierarchy";

let dbs: TestDb[] = [];
const db = () => {
  const t = createTestDb();
  dbs.push(t);
  return t;
};
// The caches are keyed by the index state, which can be equal in two fresh test databases;
// production has one database.
const dropCaches = () => {
  dropVectorCache();
  dropCorrectedVectors();
  dropAtlasCache();
};
beforeEach(dropCaches);
afterEach(async () => {
  for (const t of dbs) await t.cleanup();
  dbs = [];
});

const LONG = "with enough words in it to count as a full chunk for the index";
const family = (name: string, members: number, offset: number, title?: (i: number) => string) =>
  Array.from({ length: members }, (_, i) => {
    const c = conversationWithTexts(`${name}-${i}`, [`The shared question about ${name} ${LONG}.`, `A private answer number ${i} for ${name} ${LONG}.`], BASE_TIME + offset + i);
    return title ? { ...c, title: title(i) } : c;
  });
const loner = (name: string, offset: number) => conversationWithTexts(name, [`Only ${name} asks this ${LONG}.`, `Only ${name} hears this ${LONG}.`], BASE_TIME + offset);
const archive = () => [...family("alpha", 4, 0), ...family("beta", 3, 10), ...family("gamma", 3, 20), loner("solo-1", 30), loner("solo-2", 31)];

async function load(t: TestDb, list: unknown[]) {
  expect((await importText(exportText(list), { writer: t.writer })).complete).toBe(true);
}
/** Themes as sorted lists of ChatGPT ids (comparable across databases). */
async function bySource(t: TestDb, atlas: Atlas) {
  const src = new Map((await t.db.conversation.findMany({ select: { id: true, sourceId: true } })).map((c) => [c.id, c.sourceId]));
  const ids = (cs: { id: string }[]) => cs.map((c) => src.get(c.id)!).sort();
  return { themes: atlas.themes.map((x) => ids(x.typical)).sort((a, b) => (a[0]! < b[0]! ? -1 : 1)), other: ids(atlas.other) };
}

describe("buildAtlas", { timeout: 60_000 }, () => {
  it("is empty without conversations", async () => {
    expect(await buildAtlas(db().db)).toEqual({ method: "topics", total: 0, indexed: false, cuts: null, themes: [], other: [], ungrouped: [] });
  });

  it("before indexing: nothing grouped, every conversation listed, newest first", async () => {
    const t = db();
    await load(t, archive());
    const atlas = await buildAtlas(t.db);
    expect(atlas).toMatchObject({ total: 12, indexed: false, cuts: null, themes: [], other: [] });
    expect(atlas.ungrouped).toHaveLength(12);
    expect(atlas.ungrouped[0]!.title).toBe("Synthetic solo-2");
  });

  it("after indexing: similar conversations form themes and topics, the rest are under Other", async () => {
    const t = db();
    await load(t, archive());
    expect((await indexWith(t)).status).toBe("finished");
    const atlas = await buildAtlas(t.db);
    expect(atlas.indexed).toBe(true);
    expect(atlas.ungrouped).toEqual([]);
    expect(await bySource(t, atlas)).toEqual({
      themes: [
        ["alpha-0", "alpha-1", "alpha-2", "alpha-3"],
        ["beta-0", "beta-1", "beta-2"],
        ["gamma-0", "gamma-1", "gamma-2"],
      ],
      other: ["solo-1", "solo-2"],
    });
    expect(atlas.cuts!.topic).toBeGreaterThanOrEqual(TOPIC_CUT.min);
    expect(atlas.cuts!.theme).toBeGreaterThanOrEqual(atlas.cuts!.topic);
    expect(atlas.themes[0]!.typical).toHaveLength(4); // largest first
    // Few topics: each theme is its one topic (no level is invented).
    for (const theme of atlas.themes) {
      expect(theme.topics).toHaveLength(1);
      expect(theme.loose).toEqual([]);
      expect(theme.topics[0]!.conversations.map((c) => c.id).sort()).toEqual(theme.typical.map((c) => c.id).sort());
      const times = theme.topics[0]!.conversations.map((c) => c.updatedAtSec ?? 0);
      expect(times).toEqual([...times].sort((a, b) => b - a)); // newest first
      expect(theme.topics[0]!.titles).toHaveLength(2);
      expect(theme.name).not.toBe("");
    }
    // Names are unique, and come from the vocabulary when its vectors match the code's model.
    expect(new Set(atlas.themes.map((x) => x.name)).size).toBe(atlas.themes.length);
    expect(atlas.themes.every((x) => x.nameSource === "vocabulary")).toBe(true);
    // Ids are stable and distinct: themes "th-…", topics inside them "th-….tp-…".
    expect(atlas.themes.every((x) => /^th-[0-9a-z]{8}$/.test(x.id) && x.topics.every((p) => p.id.startsWith(`${x.id}.tp-`)))).toBe(true);
    dropCaches();
    expect(await buildAtlas(t.db)).toEqual(atlas); // the same result when recomputed
  });

  it("gives the same themes whatever order the conversations were imported in", async () => {
    const [a, b] = [db(), db()];
    await load(a, archive());
    await load(b, [...archive()].reverse());
    await indexWith(a);
    await indexWith(b);
    const ga = await bySource(a, await buildAtlas(a.db));
    dropCaches();
    expect(await bySource(b, await buildAtlas(b.db))).toEqual(ga);
  });

  it("the k-means baseline: one level, every indexed conversation in a group, its own ids", async () => {
    const t = db();
    await load(t, archive());
    await indexWith(t);
    const km = await buildAtlas(t.db, { method: "kmeans" });
    expect(km.method).toBe("kmeans");
    expect(km.cuts).toBeNull();
    expect(km.other).toEqual([]);
    expect(km.themes.reduce((n, x) => n + x.typical.length, 0)).toBe(12);
    for (const x of km.themes) {
      expect(x.topics).toEqual([]);
      expect(x.loose).toHaveLength(x.typical.length);
      expect(x.id).toMatch(/^km-/);
    }
    expect((await buildAtlas(t.db)).method).toBe("topics"); // cached per method
  });
});

describe("the atlas cache", { timeout: 60_000 }, () => {
  it("is reused while nothing changes", async () => {
    const t = db();
    await load(t, archive());
    await indexWith(t);
    const first = await buildAtlas(t.db);
    expect(await buildAtlas(t.db)).toBe(first);
  });

  it("never shows an old title: changed conversations are not grouped until re-indexed, then grouped under their new titles", async () => {
    const t = db();
    await load(t, archive());
    await indexWith(t);
    const before = await buildAtlas(t.db);
    // Re-import alpha with new titles and a later update time (a content change for the index).
    await load(t, family("alpha", 4, 100, (i) => `Renamed alpha ${i}`));
    const after = await buildAtlas(t.db);
    expect(after).not.toBe(before);
    const shown = [...after.themes.flatMap((x) => [...x.typical, ...x.topics.flatMap((p) => p.conversations)]), ...after.other, ...after.ungrouped];
    expect(shown.some((c) => c.title?.startsWith("Synthetic alpha"))).toBe(false);
    expect(after.themes.flatMap((x) => x.topics.flatMap((p) => p.titles)).some((x) => x.startsWith("Synthetic alpha"))).toBe(false);
    expect(after.ungrouped.map((c) => c.title).sort()).toEqual(["Renamed alpha 0", "Renamed alpha 1", "Renamed alpha 2", "Renamed alpha 3"]);
    await indexWith(t);
    const reindexed = await buildAtlas(t.db);
    const alpha = reindexed.themes.find((x) => x.typical.some((c) => c.title?.startsWith("Renamed alpha")))!;
    expect(alpha.topics[0]!.titles.every((x) => x.startsWith("Renamed alpha"))).toBe(true);
  });

  it("lists conversations imported after indexing as not grouped yet, and regroups once the index changes", async () => {
    const t = db();
    await load(t, archive());
    await indexWith(t);
    const before = await buildAtlas(t.db);
    await load(t, family("alpha", 5, 0).slice(4)); // alpha-4: same shared question
    const late = await buildAtlas(t.db);
    expect(late.ungrouped.map((c) => c.title)).toEqual(["Synthetic alpha-4"]);
    expect(late.themes).toEqual(before.themes);
    await indexWith(t); // the index changes; no cache is dropped by hand
    const after = await buildAtlas(t.db);
    expect(after.ungrouped).toEqual([]);
    expect((await bySource(t, after)).themes[0]).toEqual(["alpha-0", "alpha-1", "alpha-2", "alpha-3", "alpha-4"]);
  });

  it("the fingerprint covers ids, titles and update times", () => {
    const rows = [{ id: "a", title: "T", updatedAtSec: 1 }];
    const fp = rowsFingerprint(rows);
    expect(rowsFingerprint([{ ...rows[0]!, title: "U" }])).not.toBe(fp);
    expect(rowsFingerprint([{ ...rows[0]!, title: null }])).not.toBe(fp);
    expect(rowsFingerprint([{ ...rows[0]!, updatedAtSec: 2 }])).not.toBe(fp);
    expect(rowsFingerprint([{ ...rows[0]!, id: "b" }])).not.toBe(fp);
    expect(rowsFingerprint([{ ...rows[0]! }])).toBe(fp);
  });
});

describe("off the request path", { timeout: 60_000 }, () => {
  it("computes the tree in a worker thread, with the same result as inline, and falls back inline", async () => {
    const { computeHierarchy, lastRun } = await import("./hierarchy-host");
    const { buildHierarchy } = await import("./themes");
    const r = (() => {
      let x = 11;
      return () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) - 0.5;
    })();
    const centres = Array.from({ length: 4 }, () => Float64Array.from({ length: 32 }, r));
    const vectors = Array.from({ length: 40 }, (_, i) => {
      const v = centres[i % 4]!.map((x) => x + 0.2 * r());
      const n = Math.hypot(...v);
      return v.map((x) => x / n);
    });
    const inline = buildHierarchy(vectors);
    expect(await computeHierarchy(vectors)).toEqual(inline);
    expect(lastRun.mode).toBe("worker");
    expect(await computeHierarchy(vectors, { entry: "/nonexistent/worker.ts" })).toEqual(inline);
    expect(lastRun.mode).toBe("inline");
  });

  it("shares one computation between concurrent requests", async () => {
    const t = db();
    await load(t, archive());
    await indexWith(t);
    const [a, b] = await Promise.all([buildAtlas(t.db), buildAtlas(t.db)]);
    expect(a).toBe(b);
  });
});
