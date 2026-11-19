// Vector storage comparison on temporary databases (scratch only).
// A: ordinary table, float32 BLOB, brute force in JS (vectors read per query, and from an in-memory cache)
// B: ordinary table, int8 BLOB + scale, brute force in JS (cache)
// C: sqlite-vec scalar function vec_distance_cosine over A's BLOBs
// D: sqlite-vec vec0 virtual table (float[384], cosine), KNN query
// Also: insertion time, file size per vector, deletion (one conversation, all), residue of deleted
// vector bytes in the file (secure_delete + VACUUM), and SQL-level load_extension().
// Usage: node storage.mjs <projectDir> <vec0.dylib> <tmpDir> <N> [<N2> ...]
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const [projectDir, vecLib, tmpDir, ...sizes] = process.argv.slice(2);
const Database = createRequire(path.join(projectDir, "package.json"))("better-sqlite3");
const D = 384, K = 20, PER_CONV = 50, QUERIES = 30;
const ext = vecLib.replace(/\.dylib$/, "");

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function randomUnit(r) { const v = new Float32Array(D); let n = 0; for (let i = 0; i < D; i++) { v[i] = r() - 0.5; n += v[i] * v[i]; } n = Math.sqrt(n); for (let i = 0; i < D; i++) v[i] /= n; return v; }
const CANARY = 0.0123456789; // a recognisable float: its 4 bytes are searched for in the file after deletion
function canaryVec() { const v = new Float32Array(D).fill(CANARY); return v; }
const buf = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
function q8(v) { let m = 0; for (const x of v) m = Math.max(m, Math.abs(x)); const s = m / 127 || 1; const o = Buffer.alloc(4 + D); o.writeFloatLE(s, 0); for (let i = 0; i < D; i++) o.writeInt8(Math.round(v[i] / s), 4 + i); return o; }
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2); };
const time = (f) => { const t = performance.now(); const r = f(); return [performance.now() - t, r]; };
const fileBytes = (f) => ["", "-wal", "-journal"].reduce((n, s) => n + (fs.existsSync(f + s) ? fs.statSync(f + s).size : 0), 0);
function residue(file) { const b = fs.readFileSync(file); const pat = Buffer.alloc(4); pat.writeFloatLE(CANARY, 0); let n = 0; for (let i = b.indexOf(pat); i !== -1; i = b.indexOf(pat, i + 1)) n++; return n; }

const results = { sqlite: null, loadExtensionSql: null, sizes: {} };
{
  const db = new Database(":memory:");
  results.sqlite = db.prepare("select sqlite_version() v").get().v;
  try { db.prepare("select load_extension(?)").get(ext); results.loadExtensionSql = "allowed"; } catch (e) { results.loadExtensionSql = `refused: ${e.message}`; }
  db.loadExtension(ext);
  results.sqliteVec = db.prepare("select vec_version() v").get().v;
  db.close();
}

for (const N of sizes.map(Number)) {
  const r = rng(N);
  const vecs = Array.from({ length: N }, () => randomUnit(r));
  const qs = Array.from({ length: QUERIES }, () => randomUnit(r));
  const res = {};
  for (const variant of ["float32", "int8", "vec0"]) {
    const file = path.join(tmpDir, `store-${variant}-${N}.db`);
    for (const s of ["", "-wal", "-journal"]) fs.rmSync(file + s, { force: true });
    const db = new Database(file);
    db.pragma("journal_mode = DELETE");
    db.loadExtension(ext);
    const empty = fileBytes(file);
    if (variant === "vec0") db.exec(`CREATE VIRTUAL TABLE v USING vec0(embedding float[${D}] distance_metric=cosine); CREATE TABLE meta (id INTEGER PRIMARY KEY, conv TEXT, chunk INTEGER); CREATE INDEX meta_conv ON meta(conv);`);
    else db.exec(`CREATE TABLE v (id INTEGER PRIMARY KEY, conv TEXT NOT NULL, chunk INTEGER NOT NULL, model TEXT NOT NULL, hash TEXT NOT NULL, vec BLOB NOT NULL); CREATE INDEX v_conv ON v(conv);`);
    const [insertMs] = time(() => {
      const ins = variant === "vec0" ? db.prepare("INSERT INTO v(rowid, embedding) VALUES (?, ?)") : db.prepare("INSERT INTO v (id, conv, chunk, model, hash, vec) VALUES (?, ?, ?, 'e5s@761b726d', ?, ?)");
      const meta = variant === "vec0" ? db.prepare("INSERT INTO meta (id, conv, chunk) VALUES (?, ?, ?)") : null;
      db.transaction(() => {
        for (let i = 0; i < N; i++) {
          const v = i < PER_CONV ? canaryVec() : vecs[i]; // conversation c0 holds the canary vectors
          const conv = `c${Math.floor(i / PER_CONV)}`;
          if (variant === "vec0") { ins.run(BigInt(i + 1), buf(v)); meta.run(i + 1, conv, i % PER_CONV); }
          else ins.run(i + 1, conv, i % PER_CONV, "h" + i, variant === "int8" ? q8(v) : buf(v));
        }
      })();
    });
    const bytes = fileBytes(file) - empty;
    // Retrieval
    const lat = { coldScanMs: [], warmScanMs: [], sqlFnMs: [], knnMs: [] };
    let cacheLoadMs = null, cacheMb = null;
    if (variant !== "vec0") {
      const rows = db.prepare("SELECT id, conv, vec FROM v");
      const scanRows = (q, all) => { const top = []; for (const row of all) { let s = 0; if (variant === "int8") { const sc = row.vec.readFloatLE(0); for (let k = 0; k < D; k++) s += q[k] * row.vec.readInt8(4 + k) * sc; } else { const f = new Float32Array(row.vec.buffer, row.vec.byteOffset, D); for (let k = 0; k < D; k++) s += q[k] * f[k]; } top.push(s); } return top.length; };
      for (const q of qs.slice(0, 5)) lat.coldScanMs.push(time(() => scanRows(q, rows.all()))[0]);
      // In-memory cache: one contiguous typed array.
      let mat;
      [cacheLoadMs] = time(() => {
        const all = rows.all();
        mat = variant === "int8" ? { q: new Int8Array(N * D), s: new Float32Array(N) } : new Float32Array(N * D);
        all.forEach((row, i) => {
          if (variant === "int8") { mat.s[i] = row.vec.readFloatLE(0); mat.q.set(new Int8Array(row.vec.buffer, row.vec.byteOffset + 4, D), i * D); }
          else mat.set(new Float32Array(row.vec.buffer.slice(row.vec.byteOffset, row.vec.byteOffset + D * 4)), i * D);
        });
      });
      cacheMb = +((variant === "int8" ? N * D + N * 4 : N * D * 4) / 1048576).toFixed(1);
      for (const q of qs) lat.warmScanMs.push(time(() => {
        const best = [];
        for (let i = 0; i < N; i++) { let s = 0; const o = i * D; if (variant === "int8") { for (let k = 0; k < D; k++) s += q[k] * mat.q[o + k]; s *= mat.s[i]; } else { for (let k = 0; k < D; k++) s += q[k] * mat[o + k]; } if (best.length < K || s > best[K - 1]) { best.push(s); best.sort((a, b) => b - a); best.length = Math.min(best.length, K); } }
        return best;
      })[0]);
      if (variant === "float32") { const st = db.prepare(`SELECT id, vec_distance_cosine(vec, ?) d FROM v ORDER BY d LIMIT ${K}`); for (const q of qs) lat.sqlFnMs.push(time(() => st.all(buf(q)))[0]); }
    } else {
      const st = db.prepare(`SELECT rowid, distance FROM v WHERE embedding MATCH ? AND k = ${K}`);
      for (const q of qs) lat.knnMs.push(time(() => st.all(buf(q)))[0]);
    }
    // Deletion: one conversation (the canary one), then everything, then secure delete + VACUUM.
    const [deleteOneMs] = time(() => db.transaction(() => {
      if (variant === "vec0") { const ids = db.prepare("SELECT id FROM meta WHERE conv = 'c0'").all().map((x) => x.id); const d = db.prepare("DELETE FROM v WHERE rowid = ?"); for (const id of ids) d.run(BigInt(id)); db.prepare("DELETE FROM meta WHERE conv = 'c0'").run(); }
      else db.prepare("DELETE FROM v WHERE conv = 'c0'").run();
    })());
    const residueAfterDelete = residue(file);
    db.pragma("secure_delete = ON");
    db.exec("VACUUM");
    const residueAfterVacuum = residue(file);
    const [deleteAllMs] = time(() => db.transaction(() => { db.exec(variant === "vec0" ? "DELETE FROM v; DELETE FROM meta;" : "DELETE FROM v;"); })());
    db.exec("VACUUM");
    const afterAll = fileBytes(file) - empty;
    const shadow = variant === "vec0" ? db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'v_%'").all().map((x) => x.name) : [];
    db.close();
    res[variant] = {
      insertMs: +insertMs.toFixed(0), insertPerSec: Math.round(N / (insertMs / 1000)), bytes, bytesPerVector: +(bytes / N).toFixed(0),
      coldScanMs: lat.coldScanMs.length ? { p50: pct(lat.coldScanMs, 0.5), max: pct(lat.coldScanMs, 1) } : undefined,
      cacheLoadMs: cacheLoadMs === null ? undefined : +cacheLoadMs.toFixed(0), cacheMb: cacheMb ?? undefined,
      warmScanMs: lat.warmScanMs.length ? { p50: pct(lat.warmScanMs, 0.5), p95: pct(lat.warmScanMs, 0.95) } : undefined,
      sqlFunctionMs: lat.sqlFnMs.length ? { p50: pct(lat.sqlFnMs, 0.5), p95: pct(lat.sqlFnMs, 0.95) } : undefined,
      knnMs: lat.knnMs.length ? { p50: pct(lat.knnMs, 0.5), p95: pct(lat.knnMs, 0.95) } : undefined,
      deleteOneConversationMs: +deleteOneMs.toFixed(1), canaryResidueAfterDelete: residueAfterDelete, canaryResidueAfterSecureDeleteVacuum: residueAfterVacuum,
      deleteAllMs: +deleteAllMs.toFixed(0), bytesAfterDeleteAllVacuum: afterAll, extraSchemaObjects: shadow.length ? shadow : undefined,
    };
    for (const s of ["", "-wal", "-journal"]) fs.rmSync(file + s, { force: true });
  }
  results.sizes[N] = res;
  console.error(`N=${N} done`);
}
console.log(JSON.stringify(results, null, 1));
