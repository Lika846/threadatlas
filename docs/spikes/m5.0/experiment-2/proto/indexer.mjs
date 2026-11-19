// Scratch prototype of the M5 indexing lifecycle (not production code; temporary databases only).
//
// Invariants:
//  I1  Every conversation row has a `generation`, bumped by each import that replaces it.
//  I2  A replacing import deletes the conversation's chunks and (re)queues a job for the new generation,
//      in the same transaction as the message replacement (so no chunk outlives the text it came from).
//  I3  Delete-all bumps the global `epoch` and clears conversations, messages, chunks and jobs in one transaction.
//  I4  The worker commits a job's chunks in one transaction, and only if the conversation still has the
//      job's generation and the epoch is unchanged (compare-and-set); otherwise the result is discarded.
//  I5  A job marked `running` at start-up belongs to a crashed run and is reset to `pending`; chunks are
//      written only in the commit transaction, so there is never a half-written job.
//  I6  Search joins chunks to conversations on generation, so even a bug in I2 could not surface stale chunks.
import { createRequire } from "node:module";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { CHUNKER_VERSION } from "./chunker.mjs";

export const MODEL_ID = "Xenova/multilingual-e5-small@761b726d/q8";

export function openDb(projectDir, file) {
  const Database = createRequire(path.join(projectDir, "package.json"))("better-sqlite3");
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation (id TEXT PRIMARY KEY, title TEXT, generation INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS message (conversation_id TEXT NOT NULL, source_node_id TEXT NOT NULL, path_index INTEGER NOT NULL, text TEXT NOT NULL,
      PRIMARY KEY (conversation_id, source_node_id));
    CREATE TABLE IF NOT EXISTS embed_job (conversation_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending','running')),
      attempts INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS chunk (id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL, generation INTEGER NOT NULL, source_node_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL, start INTEGER NOT NULL, "end" INTEGER NOT NULL, model TEXT NOT NULL, chunker TEXT NOT NULL, vec BLOB NOT NULL,
      UNIQUE (conversation_id, generation, source_node_id, chunk_index));
    CREATE INDEX IF NOT EXISTS chunk_conv ON chunk(conversation_id);
    CREATE TABLE IF NOT EXISTS index_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO index_state VALUES ('epoch', '0');
  `);
  return db;
}

const epochOf = (db) => Number(db.prepare("SELECT value FROM index_state WHERE key = 'epoch'").get().value);

/** I1, I2: replaces a conversation's messages and requeues it, in one transaction. */
export function importConversation(db, conv) {
  db.transaction(() => {
    const cur = db.prepare("SELECT generation FROM conversation WHERE id = ?").get(conv.id);
    const gen = (cur?.generation ?? 0) + 1;
    db.prepare("INSERT INTO conversation (id, title, generation) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, generation = excluded.generation").run(conv.id, conv.title, gen);
    db.prepare("DELETE FROM message WHERE conversation_id = ?").run(conv.id);
    db.prepare("DELETE FROM chunk WHERE conversation_id = ?").run(conv.id);
    const ins = db.prepare("INSERT INTO message (conversation_id, source_node_id, path_index, text) VALUES (?, ?, ?, ?)");
    conv.messages.forEach((t, i) => ins.run(conv.id, `n${i + 1}`, i + 1, t));
    db.prepare("INSERT INTO embed_job (conversation_id, generation, state) VALUES (?, ?, 'pending') ON CONFLICT(conversation_id) DO UPDATE SET generation = excluded.generation, state = 'pending', attempts = 0").run(conv.id, gen);
  })();
}

/** I3 */
export function deleteAll(db) {
  db.transaction(() => {
    db.exec("DELETE FROM chunk; DELETE FROM embed_job; DELETE FROM message; DELETE FROM conversation;");
    db.prepare("UPDATE index_state SET value = CAST(value AS INTEGER) + 1 WHERE key = 'epoch'").run();
  })();
}

/** I5 */
export function recover(db) {
  return db.prepare("UPDATE embed_job SET state = 'pending' WHERE state = 'running'").run().changes;
}

export function progress(db) {
  const r = db.prepare("SELECT (SELECT count(*) FROM conversation) total, (SELECT count(*) FROM embed_job) remaining, (SELECT count(*) FROM chunk) chunks").get();
  return { total: r.total, indexed: r.total - r.remaining, remaining: r.remaining, chunks: r.chunks };
}

export class Indexer {
  constructor({ db, rt, modelDir, onProgress = () => {}, hooks = {} }) {
    this.db = db; this.onProgress = onProgress; this.hooks = hooks;
    this.worker = new Worker(new URL("./infer-worker.mjs", import.meta.url), { workerData: { rt, modelDir } });
    this.pending = new Map(); this.seq = 0; this.cancelled = false; this.stats = { committed: 0, discardedStale: 0 };
    this.ready = new Promise((res, rej) => {
      this.worker.once("error", rej);
      this.worker.on("message", (m) => {
        if (m.type === "ready") return res(m);
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.type === "error") p.reject(new Error(m.code));
        else p.resolve(m);
      });
    });
  }
  call(msg) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.worker.postMessage({ ...msg, id }); });
  }
  cancel() { this.cancelled = true; }

  claim() {
    return this.db.transaction(() => {
      const job = this.db.prepare("SELECT conversation_id AS cid, generation FROM embed_job WHERE state = 'pending' ORDER BY rowid LIMIT 1").get();
      if (!job) return null;
      this.db.prepare("UPDATE embed_job SET state = 'running', attempts = attempts + 1 WHERE conversation_id = ?").run(job.cid);
      const messages = this.db.prepare("SELECT source_node_id AS sourceNodeId, text FROM message WHERE conversation_id = ? ORDER BY path_index").all(job.cid);
      return { ...job, epoch: epochOf(this.db), messages };
    })();
  }

  /** I4: compare-and-set commit. */
  commit(job, res) {
    return this.db.transaction(() => {
      const cur = this.db.prepare("SELECT generation FROM conversation WHERE id = ?").get(job.cid);
      if (!cur || cur.generation !== job.generation || epochOf(this.db) !== job.epoch) return false;
      const ins = this.db.prepare(`INSERT INTO chunk (conversation_id, generation, source_node_id, chunk_index, start, "end", model, chunker, vec) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      res.spans.forEach((s, i) => ins.run(job.cid, job.generation, s.sourceNodeId, s.chunkIndex, s.start, s.end, MODEL_ID, CHUNKER_VERSION,
        Buffer.from(res.flat.buffer, res.flat.byteOffset + i * 384 * 4, 384 * 4)));
      this.db.prepare("DELETE FROM embed_job WHERE conversation_id = ? AND generation = ?").run(job.cid, job.generation);
      return true;
    })();
  }

  async run() {
    await this.ready;
    this.cancelled = false;
    for (;;) {
      if (this.cancelled) return "cancelled";
      const job = this.claim();
      if (!job) return "done";
      const res = await this.call({ type: "index", messages: job.messages });
      await this.hooks.beforeCommit?.(job);
      if (this.cancelled) { // put it back; nothing was written
        this.db.prepare("UPDATE embed_job SET state = 'pending' WHERE conversation_id = ? AND generation = ?").run(job.cid, job.generation);
        return "cancelled";
      }
      if (this.commit(job, res)) this.stats.committed++;
      else {
        this.stats.discardedStale++;
        // A newer job (re-import) is already pending; after delete-all there is no job. Only reset our own.
        this.db.prepare("UPDATE embed_job SET state = 'pending' WHERE conversation_id = ? AND generation = ? AND state = 'running'").run(job.cid, job.generation);
      }
      this.onProgress(progress(this.db));
    }
  }

  async queryVector(text) { return (await this.call({ type: "query", text })).v; }

  async close() {
    await new Promise((res) => { this.worker.once("message", (m) => m.type === "closed" && res()); this.worker.postMessage({ type: "shutdown" }); });
    await this.worker.terminate();
  }
}

/** I6: search over current chunks only (generation join), best chunk per conversation. */
export function search(db, qv, k = 10) {
  const rows = db.prepare(`SELECT c.conversation_id AS cid, c.source_node_id AS node, c.start, c."end", c.vec FROM chunk c
    JOIN conversation v ON v.id = c.conversation_id AND v.generation = c.generation`).all();
  const best = new Map();
  for (const r of rows) {
    const f = new Float32Array(r.vec.buffer, r.vec.byteOffset, 384);
    let s = 0;
    for (let i = 0; i < 384; i++) s += qv[i] * f[i];
    const b = best.get(r.cid);
    if (!b || s > b.s) best.set(r.cid, { s, node: r.node, start: r.start, end: r.end });
  }
  return [...best].sort((a, b) => b[1].s - a[1].s).slice(0, k).map(([cid, b]) => ({ cid, ...b }));
}
