// compare.mjs <ref.json> <response.json>: max abs diff and byte equality of the vectors.
import fs from "node:fs";
const [a, b] = process.argv.slice(2).map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
if (!b.vectors) { console.log("no vectors:", JSON.stringify(b).slice(0, 200)); process.exit(1); }
const x = Buffer.from(a.vectors, "base64"), y = Buffer.from(b.vectors, "base64");
const fx = new Float32Array(x.buffer, x.byteOffset, x.length / 4), fy = new Float32Array(y.buffer, y.byteOffset, y.length / 4);
let m = 0; for (let i = 0; i < fx.length; i++) m = Math.max(m, Math.abs(fx[i] - fy[i]));
console.log(JSON.stringify({ bytesEqual: x.equals(y), maxAbsDiff: m, n: fx.length, startMs: b.startMs, workersLive: b.workersLive, instances: b.instances }));
