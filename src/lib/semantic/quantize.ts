/**
 * Versioned int8 vector quantisation (ADR 0002 decision 5, D122). M5.0 Experiment 2
 * measured no retrieval loss against float32 on either evaluation set.
 *
 * Layout of `int8-absmax-v1` (little-endian, `dims + 4` bytes; 388 for 384 dims):
 *   bytes [0, 4)        float32 scale = max(|x|) / 127 (0 for an all-zero vector)
 *   bytes [4, 4 + dims) int8 q[i] = round(x[i] / scale), clamped to [-127, 127]
 * Dequantised value: q[i] * scale. `Math.round` rounds halves towards +∞, so the
 * encoding is fully deterministic.
 */

export const QUANTIZATION_VERSION = "int8-absmax-v1";

export function quantizedByteLength(dims: number): number {
  return dims + 4;
}

export function quantizeInt8(v: Float32Array): Uint8Array {
  const out = new Uint8Array(quantizedByteLength(v.length));
  const view = new DataView(out.buffer);
  let max = 0;
  for (const x of v) {
    if (!Number.isFinite(x)) throw new RangeError("vector contains a non-finite value");
    max = Math.max(max, Math.abs(x));
  }
  const scale = Math.fround(max / 127);
  view.setFloat32(0, scale, true);
  if (scale === 0) return out;
  const q = new Int8Array(out.buffer, 4, v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round(v[i]! / scale)));
  return out;
}

function parts(bytes: Uint8Array, dims: number): { scale: number; q: Int8Array } {
  if (bytes.length !== quantizedByteLength(dims)) throw new RangeError("quantised vector has the wrong length");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { scale: view.getFloat32(0, true), q: new Int8Array(bytes.buffer, bytes.byteOffset + 4, dims) };
}

export function dequantizeInt8(bytes: Uint8Array, dims: number): Float32Array {
  const { scale, q } = parts(bytes, dims);
  const out = new Float32Array(dims);
  for (let i = 0; i < dims; i++) out[i] = q[i]! * scale;
  return out;
}

/** Dot product of a float query with a quantised vector, without dequantising. */
export function dotInt8(query: Float32Array, bytes: Uint8Array): number {
  const { scale, q } = parts(bytes, query.length);
  let s = 0;
  for (let i = 0; i < query.length; i++) s += query[i]! * q[i]!;
  return s * scale;
}
