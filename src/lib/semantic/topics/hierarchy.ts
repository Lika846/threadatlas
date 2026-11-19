/**
 * Average-linkage hierarchical clustering and the topic cut rule, for the experimental topic
 * grouping (`tree-map.ts`). Server-only, pure, no dependencies.
 *
 * - **Average linkage** on cosine distance (1 − dot product of unit vectors), by the
 *   nearest-neighbour chain: O(n²) time and one n × n Float32Array of distances (36 MB at
 *   3,000 conversations). Average linkage is reducible, so the chain finds the same tree as
 *   the textbook O(n³) method, and the merge heights have no inversions: "every merge at or
 *   below t" is exactly the cut at t. Without exact ties the tree doesn't depend on the input
 *   order; ties are broken by index (the caller passes a stable order).
 * - **Topic cut** (decided 2026-11-17 from the spikes, `docs/spikes/mindmap/v2/README.md`
 *   *Post-hoc control*): a single distance does not carry over between archives (0.85 was
 *   best on one synthetic set, 0.72–0.75 on another), so the cut is a display rule instead:
 *   the smallest t in [0.65, 0.85] that leaves at most 15% of conversations on their own.
 *   The clamp keeps the cut from drifting ever finer as an archive grows.
 */

export type Merge = { a: number; b: number; height: number };

/** The topic cut rule's bounds; t is searched in steps of 0.01. */
export const TOPIC_CUT = { min: 0.65, max: 0.85, maxUnsorted: 0.15 } as const;

function dot(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/**
 * Average-linkage merges (n − 1 of them) of unit vectors. Each merge names one item of each
 * cluster it joins; its height is the average distance between the two clusters.
 */
export function averageLinkage(vectors: readonly Float64Array[]): Merge[] {
  const n = vectors.length;
  const D = new Float32Array(n * n);
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const d = 1 - dot(vectors[i]!, vectors[j]!);
      D[i * n + j] = d;
      D[j * n + i] = d;
    }
  const size = new Int32Array(n).fill(1);
  const active = new Uint8Array(n).fill(1);
  const merges: Merge[] = [];
  const chain: number[] = [];
  let remaining = n;
  let nextStart = 0;
  while (remaining > 1) {
    if (chain.length === 0) {
      while (!active[nextStart]) nextStart++;
      chain.push(nextStart);
    }
    const a = chain[chain.length - 1]!;
    const prev = chain.length > 1 ? chain[chain.length - 2]! : -1;
    // Nearest active neighbour; a tie prefers the previous chain element (so the chain ends), then the lowest index.
    let b = -1;
    let best = Infinity;
    for (let c = 0, row = a * n; c < n; c++) {
      if (c === a || !active[c]) continue;
      const d = D[row + c]!;
      if (d < best || (d === best && c === prev)) {
        best = d;
        b = c;
      }
    }
    if (b !== prev) {
      chain.push(b);
      continue;
    }
    chain.pop();
    chain.pop();
    merges.push({ a, b, height: best });
    const keep = Math.min(a, b);
    const drop = Math.max(a, b);
    const sk = size[keep]!;
    const sd = size[drop]!;
    for (let c = 0; c < n; c++) {
      if (!active[c] || c === keep || c === drop) continue;
      const d = (sk * D[keep * n + c]! + sd * D[drop * n + c]!) / (sk + sd);
      D[keep * n + c] = d;
      D[c * n + keep] = d;
    }
    size[keep] = sk + sd;
    active[drop] = 0;
    remaining--;
  }
  return merges;
}

/** Flat clusters at distance t: a cluster number per item, numbered by first appearance. */
export function cutTree(n: number, merges: readonly Merge[], t: number): number[] {
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  for (const m of merges) if (m.height <= t) parent[find(m.a)] = find(m.b);
  const ids = new Map<number, number>();
  return Array.from({ length: n }, (_, i) => {
    const r = find(i);
    if (!ids.has(r)) ids.set(r, ids.size);
    return ids.get(r)!;
  });
}

/** Share of items alone in their cluster. */
export function singletonShare(assignment: readonly number[]): number {
  if (assignment.length === 0) return 0;
  const count = new Map<number, number>();
  for (const a of assignment) count.set(a, (count.get(a) ?? 0) + 1);
  return assignment.filter((a) => count.get(a) === 1).length / assignment.length;
}

/** The topic cut: the smallest t in [0.65, 0.85] leaving at most 15% alone; 0.85 when none does. */
export function chooseTopicCut(n: number, merges: readonly Merge[]): number {
  const steps = Math.round((TOPIC_CUT.max - TOPIC_CUT.min) * 100);
  for (let i = 0; i <= steps; i++) {
    const t = Math.round(TOPIC_CUT.min * 100 + i) / 100;
    if (singletonShare(cutTree(n, merges, t)) <= TOPIC_CUT.maxUnsorted) return t;
  }
  return TOPIC_CUT.max;
}
