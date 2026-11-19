// Mind-map spike v2: scalable versions of the v1 algorithms (same results, verified on the dev set).
// - Average linkage by the nearest-neighbour chain: O(n²) time and memory (one Float64Array n×n).
// - Louvain on a sparse adjacency list (same visiting order and tie rules as v1's dense version).
import * as A from "../algorithms.mts";

export type Merge = { a: number; b: number; height: number };

/**
 * Average-linkage merges on distance 1 − similarity. Each merge names two item indices
 * (each cluster is represented by one of its items); heights have no inversions (average
 * linkage is reducible), so "all merges with height ≤ t" is exactly the cut at t.
 */
export function averageLinkageNN(vs: readonly Float64Array[]): Merge[] {
  const n = vs.length;
  const D = new Float64Array(n * n);
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const d = 1 - A.dot(vs[i]!, vs[j]!);
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
    // Nearest active neighbour; ties prefer the previous chain element (guarantees termination), then the lowest index.
    let b = -1;
    let best = Infinity;
    const row = a * n;
    for (let c = 0; c < n; c++) {
      if (c === a || !active[c]) continue;
      const d = D[row + c]!;
      if (d < best || (d === best && c === prev)) {
        best = d;
        b = c;
      }
    }
    if (b === prev) {
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
    } else chain.push(b);
  }
  return merges;
}

/** Flat clusters: union of all merges with height ≤ t (cluster ids by first appearance). */
export function cutMerges(n: number, merges: readonly Merge[], t: number): number[] {
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

// ---------------------------------------------------------------- sparse kNN graph + Louvain

type Graph = { nbr: number[][]; w: number[][]; loop: Float64Array };

/** Symmetric kNN graph (union), positive similarities only. Neighbour lists sorted by index. */
export function knnSparse(vs: readonly Float64Array[], k: number): Graph {
  const n = vs.length;
  const edges = Array.from({ length: n }, () => new Map<number, number>());
  const sims = new Float64Array(n);
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) sims[j] = j === i ? -Infinity : A.dot(vs[i]!, vs[j]!);
    const top = idx.slice().sort((a, b) => sims[b]! - sims[a]! || a - b).slice(0, k);
    for (const j of top) if (sims[j]! > 0) {
      edges[i]!.set(j, sims[j]!);
      edges[j]!.set(i, sims[j]!);
    }
  }
  const nbr = edges.map((m) => [...m.keys()].sort((a, b) => a - b));
  return { nbr, w: nbr.map((ns, i) => ns.map((j) => edges[i]!.get(j)!)), loop: new Float64Array(n) };
}

/** Louvain with resolution γ; identical rules to v1 `louvain()` (dense), on sparse lists. */
export function louvainSparse(g0: Graph, gamma = 1): number[] {
  let g = g0;
  let membership = g.nbr.map((_, i) => i);
  for (let level = 0; level < 50; level++) {
    const n = g.nbr.length;
    const k = Float64Array.from(g.nbr, (_, i) => g.w[i]!.reduce((a, b) => a + b, 0) + 2 * g.loop[i]!);
    const m2 = k.reduce((a, b) => a + b, 0);
    if (m2 === 0) break;
    const comm = Int32Array.from({ length: n }, (_, i) => i);
    const tot = Float64Array.from(k);
    let moved = false;
    for (let pass = 0; pass < 100; pass++) {
      let changed = false;
      for (let i = 0; i < n; i++) {
        const own = comm[i]!;
        tot[own]! -= k[i]!;
        const links = new Map<number, number>([[own, 0]]);
        const ns = g.nbr[i]!;
        const ws = g.w[i]!;
        for (let x = 0; x < ns.length; x++) links.set(comm[ns[x]!]!, (links.get(comm[ns[x]!]!) ?? 0) + ws[x]!);
        let best = own;
        let bestGain = links.get(own)! - (gamma * tot[own]! * k[i]!) / m2;
        for (const [c, w] of links) {
          const gain = w - (gamma * tot[c]! * k[i]!) / m2;
          if (gain > bestGain + 1e-12) {
            best = c;
            bestGain = gain;
          }
        }
        tot[best]! += k[i]!;
        if (best !== own) {
          comm[i] = best;
          changed = moved = true;
        }
      }
      if (!changed) break;
    }
    if (!moved) break;
    const ids = new Map<number, number>();
    for (const c of comm) if (!ids.has(c)) ids.set(c, ids.size);
    const m = ids.size;
    const agg = Array.from({ length: m }, () => new Map<number, number>());
    const loop = new Float64Array(m);
    for (let i = 0; i < n; i++) {
      const a = ids.get(comm[i]!)!;
      loop[a]! += g.loop[i]!;
      const ns = g.nbr[i]!;
      for (let x = 0; x < ns.length; x++) {
        const j = ns[x]!;
        if (j < i) continue; // each undirected edge once
        const b = ids.get(comm[j]!)!;
        const w = g.w[i]![x]!;
        if (a === b) loop[a]! += w;
        else {
          agg[a]!.set(b, (agg[a]!.get(b) ?? 0) + w);
          agg[b]!.set(a, (agg[b]!.get(a) ?? 0) + w);
        }
      }
    }
    const nbr = agg.map((mm) => [...mm.keys()].sort((x, y) => x - y));
    g = { nbr, w: nbr.map((ns, a) => ns.map((b) => agg[a]!.get(b)!)), loop };
    membership = membership.map((s) => ids.get(comm[s]!)!);
  }
  const renum = new Map<number, number>();
  return membership.map((c) => {
    if (!renum.has(c)) renum.set(c, renum.size);
    return renum.get(c)!;
  });
}
