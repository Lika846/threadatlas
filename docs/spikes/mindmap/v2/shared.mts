// Mind-map spike v2: data loading, the frozen v1 language detector, and the frozen representations.
import fs from "node:fs";
import path from "node:path";
import { dequantizeInt8, quantizeInt8 } from "../../../../src/lib/semantic/quantize.ts";
import { MIN_SEARCH_TOKENS } from "../../../../src/lib/semantic/search/vector-cache.ts";
import { CHAT_CORPUS } from "../../../../tests/helpers/chat-corpus.ts";
import { LABELS as V1_LABELS } from "../labels.mjs";
import * as A from "../algorithms.mts";

// ---- Frozen: copied verbatim from v1 analyse.mts (SPEC.md).
const NO_WORDS = new Set("og ikke jeg det er på til med som har vi du kan hva hvordan å av den om så min må skal vil bør når eller fra hvis meg hun han oss deg også bare noe etter".split(" "));
const EN_WORDS = new Set("the and is to of in it you that with my what how can on this be are your do if or from should when not have will about".split(" "));
export function detectLang(text: string): string {
  const letters = text.match(/\p{L}/gu) ?? [];
  const cyr = letters.filter((c) => /[Ѐ-ӿ]/.test(c)).length;
  if (letters.length > 0 && cyr / letters.length > 0.3) return "ru";
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  const no = words.filter((w) => NO_WORDS.has(w)).length + (/[æøå]/i.test(text) ? 2 : 0);
  const en = words.filter((w) => EN_WORDS.has(w)).length;
  return no > en ? "no" : "en";
}

export type Chunk = { msg: number; role: string; tokenCount: number; v: Float64Array; text?: string };
export type Item = {
  id: string;
  set: "dev" | "test";
  lang: string;
  title: string | null;
  messages: string[];
  messageLangs: string[] | null;
  chunks: Chunk[];
  titleV: Float64Array | null;
  /** Topic labels (topic, optional topic2); one-offs have a unique label. */
  topics: string[];
  /** Theme labels (theme, optional theme2); one-offs have a unique label. */
  themes: string[];
  oneoff: boolean;
};

const int8 = (v: number[]) => Float64Array.from(dequantizeInt8(quantizeInt8(Float32Array.from(v)), v.length));

// v1 tags → v2 themes, for the combined theme-level evaluation only.
const V1_THEME: Record<string, string> = {
  code: "code", food: "food", garden: "garden", fitness: "fitness", health: "health", home: "home", moving: "admin",
  travel: "travel", languages: "learning", career: "career", money: "money", pets: "family", devices: "tech",
  crafts: "creative", music: "creative", writing: "creative", occasions: "creative", study: "learning",
  transport: "dev:transport", legal: "admin", business: "career", games: "dev:games",
};

type RawDev = { id: string; lang: string; title: string; chunks: { msg: number; role: string; tokenCount: number; v: number[] }[]; titleV: number[] };
type RawTest = { id: string; title: string | null; chunks: { msg: number; role: string; tokenCount: number; text: string; v: number[] }[]; titleV: number[] | null };

export function loadDev(file: string, root: string): Item[] {
  const evalSet = (f: string) => JSON.parse(fs.readFileSync(path.join(root, "docs/spikes/m5.0/eval", f), "utf8")).conversations as { id: string; messages: string[] }[];
  const messages = new Map<string, string[]>([...CHAT_CORPUS, ...evalSet("dataset.json"), ...evalSet("long.json")].map((c) => [c.id, c.messages]));
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as RawDev[];
  return raw
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((c) => {
      const tags = (V1_LABELS as Record<string, string[]>)[c.id]!;
      return {
        id: `dev:${c.id}`,
        set: "dev" as const,
        lang: c.lang,
        title: c.title,
        messages: messages.get(c.id)!,
        messageLangs: null,
        chunks: c.chunks.map((k) => ({ msg: k.msg, role: k.role, tokenCount: k.tokenCount, v: int8(k.v) })),
        titleV: int8(c.titleV),
        topics: tags.map((t) => `dev:${t}`),
        themes: [...new Set(tags.map((t) => V1_THEME[t]!))],
        oneoff: false,
      };
    });
}

type Label = { theme: string; topic: string; topic2: string | null; theme2: string | null; oneoff: boolean; lang: string; messageLangs: string[] };
export function loadTest(file: string, root: string): Item[] {
  const dir = path.join(root, "docs/spikes/mindmap/v2");
  const convs = JSON.parse(fs.readFileSync(path.join(dir, "conversations.json"), "utf8")) as { id: string; messages: { text: string }[] }[];
  const labels = JSON.parse(fs.readFileSync(path.join(dir, "labels.json"), "utf8")) as Record<string, Label>;
  const text = new Map(convs.map((c) => [c.id, c.messages.map((m) => m.text)]));
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as RawTest[];
  return raw
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((c) => {
      const l = labels[c.id]!;
      return {
        id: c.id,
        set: "test" as const,
        lang: l.lang,
        title: c.title,
        messages: text.get(c.id)!,
        messageLangs: l.messageLangs,
        chunks: c.chunks.map((k) => ({ msg: k.msg, role: k.role, tokenCount: k.tokenCount, text: k.text, v: int8(k.v) })),
        titleV: c.titleV ? int8(c.titleV) : null,
        topics: l.oneoff ? [l.topic] : [l.topic, ...(l.topic2 ? [l.topic2] : [])],
        themes: l.oneoff ? [l.topic] : [...new Set([l.theme, ...(l.theme2 ? [l.theme2] : [])])],
        oneoff: l.oneoff,
      };
    });
}

// ---- Frozen representations (v1 winners + the production baseline).
const meanOf = (vs: Float64Array[]) => {
  const out = new Float64Array(vs[0]!.length);
  for (const v of vs) for (let i = 0; i < v.length; i++) out[i]! += v[i]!;
  return A.normalise(out);
};
const longFirst = (cs: Chunk[]) => {
  const long = cs.filter((c) => c.tokenCount >= MIN_SEARCH_TOKENS);
  return long.length > 0 ? long : cs;
};
export type RepName = "all" | "all [det]" | "all+title [det]" | "all [detc]";

/**
 * Builds conversation vectors for a set of items. Language means are computed over the given
 * items' chunks (what production would do over the whole archive). `[det]` detects per message
 * (primary, frozen); `[detc]` per chunk text (secondary, test set only).
 */
export function buildReps(items: readonly Item[], rep: RepName): Float64Array[] {
  if (rep === "all") return items.map((c) => meanOf(longFirst(c.chunks).map((k) => k.v)));
  const perChunk = rep === "all [detc]";
  const langOf = (c: Item, k: Chunk) => detectLang(perChunk && k.text !== undefined ? k.text : c.messages[k.msg]!);
  const tagged = items.map((c) => c.chunks.map((k) => langOf(c, k)));
  const sums = new Map<string, { s: Float64Array; n: number }>();
  items.forEach((c, ci) =>
    c.chunks.forEach((k, ki) => {
      const l = tagged[ci]![ki]!;
      let acc = sums.get(l);
      if (!acc) sums.set(l, (acc = { s: new Float64Array(k.v.length), n: 0 }));
      for (let d = 0; d < k.v.length; d++) acc.s[d]! += k.v[d]!;
      acc.n++;
    }),
  );
  const mean = new Map([...sums].map(([l, a]) => [l, a.s.map((x) => x / a.n)]));
  const centred = (v: Float64Array, l: string) => A.normalise(Float64Array.from(v, (x, d) => x - mean.get(l)![d]!));
  return items.map((c, ci) => {
    const ks = c.chunks.map((k, ki) => ({ k, l: tagged[ci]![ki]! }));
    const long = ks.filter((x) => x.k.tokenCount >= MIN_SEARCH_TOKENS);
    const use = long.length > 0 ? long : ks;
    const base = meanOf(use.map((x) => centred(x.k.v, x.l)));
    if (rep !== "all+title [det]" || !c.titleV) return base;
    const counts = new Map<string, number>();
    for (const x of ks) counts.set(x.l, (counts.get(x.l) ?? 0) + 1);
    const top = [...counts].sort((a, b) => b[1] - a[1])[0]![0]; // ties: first seen (as v1)
    const t = centred(c.titleV, top);
    return A.normalise(Float64Array.from(base, (x, d) => x + t[d]!));
  });
}
