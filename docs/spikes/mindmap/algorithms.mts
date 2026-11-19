// Mind-map spike: clustering algorithms and metrics. Plain TypeScript, no dependencies.
// Vectors are unit Float64Arrays; similarity is the dot product.

export type Vec = Float64Array;
/** A grouping: each item's list of group ids (empty = unsorted). Usually one id per item. */
export type Grouping = number[][];

export const dot = (a: Vec, b: Vec) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};
export function normalise(v: Vec): Vec {
  const n = Math.sqrt(dot(v, v)) || 1;
  for (let i = 0; i < v.length; i++) v[i]! /= n;
  return v;
}
/** Subtract the mean vector, then renormalise (as topics.ts does). */
export function centre(vs: readonly Vec[]): Vec[] {
  const d = vs[0]!.length;
  const mean = new Float64Array(d);
  for (const v of vs) for (let i = 0; i < d; i++) mean[i]! += v[i]! / vs.length;
  return vs.map((v) => normalise(Float64Array.from(v, (x, i) => x - mean[i]!)));
}
export function simMatrix(vs: readonly Vec[]): Float64Array[] {
  return vs.map((a) => Float64Array.from(vs, (b) => dot(a, b)));
}

// ---------------------------------------------------------------- similarity graph + Louvain

/** Symmetric k-nearest-neighbour graph (union), weights = similarity, only positive weights. */
export function knnGraph(S: readonly Float64Array[], k: number, mutual = false): Float64Array[] {
  const n = S.length;
  const near = S.map((row, i) =>
    new Set(
      [...row.keys()]
        .filter((j) => j !== i)
        .sort((a, b) => row[b]! - row[a]! || a - b)
        .slice(0, k),
    ),
  );
  const W = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++)
    for (const j of near[i]!) {
      const keep = mutual ? near[j]!.has(i) : true;
      if (keep && S[i]![j]! > 0) W[i]![j] = W[j]![i] = S[i]![j]!;
    }
  return W;
}

/**
 * Louvain modularity optimisation with resolution γ, deterministic (fixed node order, ties keep
 * the current community, then the first community seen). Dense matrices: fine for a few thousand
 * nodes in a spike. Returns a community index per node, numbered by first appearance.
 */
export function louvain(W0: readonly Float64Array[], gamma = 1): number[] {
  let W = W0.map((r) => Float64Array.from(r));
  let membership = W.map((_, i) => i); // original node → current super-node
  for (let level = 0; level < 50; level++) {
    const n = W.length;
    const k = W.map((row, i) => row.reduce((a, b) => a + b, 0) + row[i]!); // self-loop counted twice
    const m2 = k.reduce((a, b) => a + b, 0);
    if (m2 === 0) break;
    const comm = W.map((_, i) => i);
    const tot = Float64Array.from(k);
    let moved = false;
    for (let pass = 0; pass < 100; pass++) {
      let changed = false;
      for (let i = 0; i < n; i++) {
        const own = comm[i]!;
        tot[own]! -= k[i]!;
        const links = new Map<number, number>();
        links.set(own, 0);
        for (let j = 0; j < n; j++) if (j !== i && W[i]![j]! > 0) links.set(comm[j]!, (links.get(comm[j]!) ?? 0) + W[i]![j]!);
        let best = own;
        let bestGain = links.get(own)! - (gamma * tot[own]! * k[i]!) / m2;
        for (const [c, w] of links) {
          const g = w - (gamma * tot[c]! * k[i]!) / m2;
          if (g > bestGain + 1e-12) {
            best = c;
            bestGain = g;
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
    // Aggregate.
    const ids = new Map<number, number>();
    for (const c of comm) if (!ids.has(c)) ids.set(c, ids.size);
    const m = ids.size;
    const A = Array.from({ length: m }, () => new Float64Array(m));
    for (let i = 0; i < n; i++)
      for (let j = i; j < n; j++) {
        const w = W[i]![j]!;
        if (w === 0) continue;
        const a = ids.get(comm[i]!)!;
        const b = ids.get(comm[j]!)!;
        if (a === b) A[a]![a]! += w; // pairs inside (counted once) and old loops
        else {
          A[a]![b]! += w;
          A[b]![a]! += w;
        }
      }
    membership = membership.map((s) => ids.get(comm[s]!)!);
    W = A;
  }
  const renum = new Map<number, number>();
  return membership.map((c) => {
    if (!renum.has(c)) renum.set(c, renum.size);
    return renum.get(c)!;
  });
}

// ---------------------------------------------------------------- hierarchical (average linkage)

export type Dendrogram = { merges: { a: number; b: number; height: number; size: number }[]; n: number };

/** Average-linkage agglomerative clustering on distance 1 − similarity. Deterministic. */
export function averageLinkage(S: readonly Float64Array[]): Dendrogram {
  const n = S.length;
  const D = new Map<number, Map<number, number>>();
  const size = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    size.set(i, 1);
    D.set(i, new Map());
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) D.get(i)!.set(j, 1 - S[i]![j]!);
  const merges: Dendrogram["merges"] = [];
  let next = n;
  while (size.size > 1) {
    let best: [number, number, number] = [-1, -1, Infinity];
    for (const [a, row] of D) for (const [b, d] of row) if (a < b && d < best[2]) best = [a, b, d];
    const [a, b, h] = best;
    const sa = size.get(a)!;
    const sb = size.get(b)!;
    const row = new Map<number, number>();
    for (const c of size.keys()) {
      if (c === a || c === b) continue;
      const d = (sa * D.get(a)!.get(c)! + sb * D.get(b)!.get(c)!) / (sa + sb);
      row.set(c, d);
      D.get(c)!.delete(a);
      D.get(c)!.delete(b);
      D.get(c)!.set(next, d);
    }
    D.delete(a);
    D.delete(b);
    D.set(next, row);
    size.delete(a);
    size.delete(b);
    size.set(next, sa + sb);
    merges.push({ a, b, height: h, size: sa + sb });
    next++;
  }
  return { merges, n };
}

/** Flat clusters: apply merges with height ≤ t. Returns a cluster index per item. */
export function cutAt(d: Dendrogram, t: number): number[] {
  const parent = new Map<number, number>();
  d.merges.forEach((m, i) => {
    if (m.height <= t) {
      parent.set(m.a, d.n + i);
      parent.set(m.b, d.n + i);
    }
  });
  const root = (x: number): number => (parent.has(x) ? root(parent.get(x)!) : x);
  const ids = new Map<number, number>();
  return Array.from({ length: d.n }, (_, i) => {
    const r = root(i);
    if (!ids.has(r)) ids.set(r, ids.size);
    return ids.get(r)!;
  });
}

// ---------------------------------------------------------------- helpers and metrics

/** Groups smaller than `min` become unsorted. */
export function toGrouping(assign: readonly number[], min = 2): Grouping {
  const count = new Map<number, number>();
  for (const a of assign) count.set(a, (count.get(a) ?? 0) + 1);
  return assign.map((a) => (count.get(a)! >= min ? [a] : []));
}

/** Members of each group id. */
export function groupsOf(g: Grouping): Map<number, number[]> {
  const out = new Map<number, number[]>();
  g.forEach((gs, i) => gs.forEach((x) => out.set(x, [...(out.get(x) ?? []), i])));
  return out;
}

/**
 * Extended BCubed (Amigó et al. 2009) for overlapping clusters and multi-label gold. An
 * unsorted item is its own singleton cluster (it costs recall, never precision).
 */
export function bcubed(g: Grouping, labels: readonly string[][]): { p: number; r: number; f: number } {
  const n = g.length;
  const cl = g.map((gs, i) => (gs.length > 0 ? gs.map(String) : [`u${i}`]));
  let P = 0;
  let R = 0;
  for (let i = 0; i < n; i++) {
    let ps = 0;
    let pn = 0;
    let rs = 0;
    let rn = 0;
    for (let j = 0; j < n; j++) {
      const C = cl[i]!.filter((x) => cl[j]!.includes(x)).length;
      const L = labels[i]!.filter((x) => labels[j]!.includes(x)).length;
      if (C > 0) {
        ps += Math.min(C, L) / C;
        pn++;
      }
      if (L > 0) {
        rs += Math.min(C, L) / L;
        rn++;
      }
    }
    P += ps / pn;
    R += rs / rn;
  }
  P /= n;
  R /= n;
  return { p: P, r: R, f: (2 * P * R) / (P + R) };
}

const choose2 = (x: number) => (x * (x - 1)) / 2;
/** Adjusted Rand index between two hard assignments (unsorted = own singleton). */
export function ari(a: readonly number[], b: readonly number[]): number {
  const n = a.length;
  const t = new Map<string, number>();
  const ra = new Map<number, number>();
  const rb = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    t.set(`${a[i]}|${b[i]}`, (t.get(`${a[i]}|${b[i]}`) ?? 0) + 1);
    ra.set(a[i]!, (ra.get(a[i]!) ?? 0) + 1);
    rb.set(b[i]!, (rb.get(b[i]!) ?? 0) + 1);
  }
  const sij = [...t.values()].reduce((s, x) => s + choose2(x), 0);
  const sa = [...ra.values()].reduce((s, x) => s + choose2(x), 0);
  const sb = [...rb.values()].reduce((s, x) => s + choose2(x), 0);
  const exp = (sa * sb) / choose2(n);
  const max = (sa + sb) / 2;
  return max === exp ? 1 : (sij - exp) / (max - exp);
}

/** Hard labels from a grouping: first group, or a unique id for unsorted items. */
export function hard(g: Grouping): number[] {
  return g.map((gs, i) => (gs.length > 0 ? gs[0]! : -1 - i));
}

/** Normalised mutual information (arithmetic mean normalisation). */
export function nmi(a: readonly (string | number)[], b: readonly (string | number)[]): number {
  const n = a.length;
  const c = (xs: readonly (string | number)[]) => {
    const m = new Map<string, number>();
    xs.forEach((x) => m.set(String(x), (m.get(String(x)) ?? 0) + 1));
    return m;
  };
  const H = (m: Map<string, number>) => -[...m.values()].reduce((s, x) => s + (x / n) * Math.log(x / n), 0);
  const joint = c(a.map((x, i) => `${x}|${b[i]}`));
  const ca = c(a);
  const cb = c(b);
  let I = 0;
  for (const [k, x] of joint) {
    const [p, q] = k.split("|");
    I += (x / n) * Math.log((x * n) / (ca.get(p!)! * cb.get(q!)!));
  }
  const h = (H(ca) + H(cb)) / 2;
  return h === 0 ? 1 : I / h;
}
