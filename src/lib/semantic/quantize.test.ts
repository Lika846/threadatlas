import { describe, expect, it } from "vitest";
import { dequantizeInt8, dotInt8, QUANTIZATION_VERSION, quantizedByteLength, quantizeInt8 } from "./quantize";

function unitVector(seed: number, dims = 384): Float32Array {
  let s = seed;
  const v = new Float32Array(dims);
  for (let i = 0; i < dims; i++) {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    v[i] = s / 2 ** 30 - 1;
  }
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

describe("int8 quantisation", () => {
  it("uses 388 bytes for 384 dimensions with a little-endian float32 scale first", () => {
    const v = unitVector(1);
    const q = quantizeInt8(v);
    expect(q.length).toBe(quantizedByteLength(384));
    expect(q.length).toBe(388);
    const max = Math.max(...v.map(Math.abs));
    expect(new DataView(q.buffer).getFloat32(0, true)).toBeCloseTo(max / 127, 7);
    expect(QUANTIZATION_VERSION).toBe("int8-absmax-v1");
  });

  it("round-trips within half a quantisation step and is deterministic", () => {
    const v = unitVector(2);
    const q = quantizeInt8(v);
    const scale = new DataView(q.buffer).getFloat32(0, true);
    const back = dequantizeInt8(q, v.length);
    for (let i = 0; i < v.length; i++) expect(Math.abs(back[i]! - v[i]!)).toBeLessThanOrEqual(scale / 2 + 1e-9);
    expect(Buffer.from(quantizeInt8(v)).equals(Buffer.from(q))).toBe(true);
  });

  it("keeps dot products close to float32", () => {
    const a = unitVector(3);
    const b = unitVector(4);
    const exact = a.reduce((s, x, i) => s + x * b[i]!, 0);
    expect(Math.abs(dotInt8(a, quantizeInt8(b)) - exact)).toBeLessThan(0.01);
    expect(dotInt8(a, quantizeInt8(a))).toBeCloseTo(1, 2);
  });

  it("encodes the zero vector as scale 0 and zeros", () => {
    const q = quantizeInt8(new Float32Array(4));
    expect(Array.from(q)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(Array.from(dequantizeInt8(q, 4))).toEqual([0, 0, 0, 0]);
  });

  it("maps the largest magnitude to ±127", () => {
    const q = quantizeInt8(Float32Array.from([0.5, -1, 0.25, 1]));
    expect(Array.from(new Int8Array(q.buffer, 4, 4))).toEqual([64, -127, 32, 127]);
  });

  it("rejects non-finite values and wrong lengths", () => {
    expect(() => quantizeInt8(Float32Array.from([1, Number.NaN]))).toThrow(RangeError);
    expect(() => dequantizeInt8(new Uint8Array(10), 384)).toThrow(RangeError);
    expect(() => dotInt8(new Float32Array(384), new Uint8Array(10))).toThrow(RangeError);
  });
});
