/**
 * Model-independent tensor preparation and pooling, reproducing the M5.0 reference
 * pipeline (Experiment 2: identical to Transformers.js 3.8.1 within 1.3e-7):
 *
 * - **Truncation:** at most `maxTokens` ids including `<s>` and `</s>`. Longer inputs
 *   keep their first `maxTokens - 1` ids and end with `</s>`, as the reference Python
 *   tokenizers library does (Transformers.js 3.8.1 drops the final `</s>` instead).
 * - **Padding:** right padding with the pad id; attention mask 1 for real tokens.
 * - **Pooling:** mean of the token vectors where the attention mask is 1.
 * - **Normalisation:** L2, so a dot product is the cosine similarity.
 */
import type { EncodedBatch, HiddenStates } from "./backend.ts";

// BigInt(…) rather than `1n`: the project's TypeScript target is ES2017.
const ONE = BigInt(1);
const ZERO = BigInt(0);

export function truncateIds(ids: readonly number[], maxTokens: number, eosId: number): number[] {
  if (ids.length <= maxTokens) return [...ids];
  return [...ids.slice(0, maxTokens - 1), eosId];
}

export function buildBatch(rows: readonly (readonly number[])[], padId: number): EncodedBatch {
  const n = rows.length;
  const length = Math.max(1, ...rows.map((r) => r.length));
  const inputIds = new BigInt64Array(n * length);
  const attentionMask = new BigInt64Array(n * length);
  for (let i = 0; i < n; i++) {
    const row = rows[i] ?? [];
    for (let j = 0; j < length; j++) {
      const real = j < row.length;
      inputIds[i * length + j] = BigInt(real ? (row[j] ?? padId) : padId);
      attentionMask[i * length + j] = real ? ONE : ZERO;
    }
  }
  return { n, length, inputIds, attentionMask };
}

/**
 * Mean-pools and L2-normalises each row. Returns `n × dims` floats, row-major. A row
 * with no real tokens, or a zero vector, comes back as zeros.
 */
export function poolAndNormalise(batch: EncodedBatch, hidden: HiddenStates): Float32Array {
  const { n, length, attentionMask } = batch;
  const d = hidden.dims;
  if (hidden.data.length !== n * length * d) throw new RangeError("hidden state shape mismatch");
  const out = new Float32Array(n * d);
  const acc = new Float32Array(d);
  for (let i = 0; i < n; i++) {
    acc.fill(0);
    let count = 0;
    for (let j = 0; j < length; j++) {
      if (attentionMask[i * length + j] === ZERO) continue;
      count++;
      const o = (i * length + j) * d;
      for (let k = 0; k < d; k++) acc[k]! += hidden.data[o + k]!;
    }
    if (count === 0) continue;
    let norm = 0;
    for (let k = 0; k < d; k++) {
      acc[k]! /= count;
      norm += acc[k]! * acc[k]!;
    }
    norm = Math.sqrt(norm);
    if (norm === 0) continue;
    for (let k = 0; k < d; k++) out[i * d + k] = acc[k]! / norm;
  }
  return out;
}
