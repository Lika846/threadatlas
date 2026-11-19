/**
 * Themes → topics: the two levels of the atlas (`atlas.ts`). Server-only, pure.
 *
 * One average-linkage tree of the centred, language-corrected conversation vectors
 * (`hierarchy.ts`), cut twice:
 * - **Topics** at the production topic cut (`chooseTopicCut`: the finest cut in [0.65, 0.85]
 *   that leaves at most 15% of conversations on their own).
 * - **Themes** at a coarser cut of the same tree, so every topic lies inside exactly one theme
 *   (merge heights have no inversions). The theme cut is a display rule (spike v3,
 *   `docs/spikes/mindmap/v3/README.md`): the finest cut at or above the topic cut, and at least
 *   `THEME_CUT.from`, that leaves at most `THEME_CUT.maxThemes` themes. A fixed distance gave
 *   slightly better scores but a theme count that keeps growing with the archive (14 → 24
 *   between 100 and 453 conversations); this rule stays at 14–15.
 *
 * Within a theme: its topics (groups of two or more at the topic cut), then its **loose**
 * conversations (alone at the topic cut, but inside the theme). Conversations alone even at the
 * theme cut are **other**. Every list is ordered most typical first (closest to its group's
 * average); themes and topics largest first.
 */
import { averageLinkage, chooseTopicCut, cutTree, type Merge } from "./hierarchy.ts";

export const THEME_CUT = { from: 0.8, to: 1.2, maxThemes: 15 } as const;

/** The theme cut: the finest t in [max(topicCut, 0.8), 1.2] that leaves at most 15 themes (groups of two or more). */
export function chooseThemeCut(n: number, merges: readonly Merge[], topicCut: number): number {
  const from = Math.max(Math.round(topicCut * 100), Math.round(THEME_CUT.from * 100));
  const to = Math.round(THEME_CUT.to * 100);
  for (let i = from; i <= to; i++) {
    const t = i / 100;
    if (groupCount(cutTree(n, merges, t)) <= THEME_CUT.maxThemes) return t;
  }
  return THEME_CUT.to;
}

function groupCount(assignment: readonly number[]): number {
  const count = new Map<number, number>();
  for (const a of assignment) count.set(a, (count.get(a) ?? 0) + 1);
  let groups = 0;
  for (const c of count.values()) if (c >= 2) groups++;
  return groups;
}

export type ThemeNode = {
  /** Every conversation in the theme, most typical first. */
  members: number[];
  /** Topics inside the theme, largest first; each most typical first. */
  topics: number[][];
  /** In the theme, but alone at the topic cut; most typical first. */
  loose: number[];
};

export type Hierarchy = {
  /** Null when nothing was grouped (fewer than two conversations, or all alone). */
  topicCut: number | null;
  themeCut: number | null;
  themes: ThemeNode[];
  /** Alone even at the theme cut, in input order. */
  other: number[];
};

const dot = (a: Float64Array, b: Float64Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};

/** Members ordered by closeness to their (unnormalised) average: most typical first, ties by index. */
function typicalFirst(members: readonly number[], centred: readonly Float64Array[]): number[] {
  if (members.length === 0) return [];
  const dims = centred[members[0]!]!.length;
  const centroid = new Float64Array(dims);
  for (const i of members) for (let d = 0; d < dims; d++) centroid[d]! += centred[i]![d]!;
  const score = new Map(members.map((i) => [i, dot(centred[i]!, centroid)]));
  return [...members].sort((a, b) => score.get(b)! - score.get(a)! || a - b);
}

function groupsOf(assignment: readonly number[]): number[][] {
  const members = new Map<number, number[]>();
  assignment.forEach((a, i) => {
    let m = members.get(a);
    if (!m) members.set(a, (m = []));
    m.push(i);
  });
  return [...members.values()];
}

const bySizeThenFirst = (a: readonly number[], b: readonly number[]) => b.length - a.length || Math.min(...a) - Math.min(...b);

/**
 * Builds the two levels from centred unit vectors in a stable order (the caller's order breaks
 * ties). Pass `merges` when the tree is already known.
 */
export function buildHierarchy(centred: readonly Float64Array[], merges: readonly Merge[] = averageLinkage(centred)): Hierarchy {
  const n = centred.length;
  if (n < 2) return { topicCut: null, themeCut: null, themes: [], other: centred.map((_, i) => i) };
  const topicCut = chooseTopicCut(n, merges);
  const themeCut = chooseThemeCut(n, merges, topicCut);
  const topicOf = cutTree(n, merges, topicCut);
  const themeGroups = groupsOf(cutTree(n, merges, themeCut));
  const topicSize = new Map<number, number>();
  for (const t of topicOf) topicSize.set(t, (topicSize.get(t) ?? 0) + 1);

  const themes: ThemeNode[] = [];
  const other: number[] = [];
  for (const g of themeGroups) {
    if (g.length < 2) {
      other.push(g[0]!);
      continue;
    }
    const topics = groupsOf(g.map((i) => topicOf[i]!))
      .map((local) => local.map((j) => g[j]!))
      .filter((m) => m.length >= 2)
      .map((m) => typicalFirst(m, centred))
      .sort(bySizeThenFirst);
    const loose = typicalFirst(g.filter((i) => topicSize.get(topicOf[i]!)! < 2), centred);
    themes.push({ members: typicalFirst(g, centred), topics, loose });
  }
  themes.sort((a, b) => bySizeThenFirst(a.members, b.members));
  other.sort((a, b) => a - b);
  const grouped = themes.length > 0;
  return { topicCut: grouped ? topicCut : null, themeCut: grouped ? themeCut : null, themes, other };
}
