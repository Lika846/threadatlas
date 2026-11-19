// Lifecycle scenarios for the scratch indexer. Synthetic data, temporary databases, offline.
// Usage: node --import ../bench/tripwire.mjs scenario.mjs <projectDir> <rt> <modelDir> <union.json> <tmpDir>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createDirectEmbedder } from "../bench/direct.mjs";
import { deleteAll, importConversation, Indexer, openDb, progress, recover, search } from "./indexer.mjs";

const [projectDir, rt, modelDir, unionFile, tmpDir] = process.argv.slice(2);
const convs = JSON.parse(fs.readFileSync(unionFile, "utf8")).conversations;
const out = {};
const fresh = (name) => { const f = path.join(tmpDir, name); for (const s of ["", "-wal", "-shm"]) fs.rmSync(f + s, { force: true }); return openDb(projectDir, f); };
const consistent = (db) => {
  // Every conversation is either fully indexed (chunks, no job) or waiting (job, no chunks); no running job when idle.
  const rows = db.prepare(`SELECT v.id, (SELECT count(*) FROM chunk c WHERE c.conversation_id = v.id) n, (SELECT count(*) FROM chunk c WHERE c.conversation_id = v.id AND c.generation <> v.generation) stale,
    (SELECT state FROM embed_job j WHERE j.conversation_id = v.id) job FROM conversation v`).all();
  return { ok: rows.every((r) => r.stale === 0 && ((r.n > 0 && r.job === null) || (r.n === 0 && r.job === "pending"))), running: rows.filter((r) => r.job === "running").length };
};

// S1 — full index via the worker; main-thread responsiveness measured meanwhile.
{
  const db = fresh("s1.db");
  convs.forEach((c) => importConversation(db, c));
  const events = [];
  const ix = new Indexer({ db, rt, modelDir, onProgress: (p) => events.push(p) });
  const ready = await ix.ready;
  const h = monitorEventLoopDelay({ resolution: 10 }); h.enable();
  const t0 = performance.now();
  assert.equal(await ix.run(), "done");
  const ms = performance.now() - t0;
  h.disable();
  const p = progress(db);
  out.S1_fullIndex = { conversations: p.total, chunks: p.chunks, seconds: +(ms / 1000).toFixed(1), workerLoadMs: Math.round(ready.loadMs), progressEvents: events.length,
    firstEvent: events[0], lastEvent: events.at(-1), eventLoopDelayMs: { p50: +(h.percentile(50) / 1e6).toFixed(1), p99: +(h.percentile(99) / 1e6).toFixed(1), max: +(h.max / 1e6).toFixed(1) },
    consistent: consistent(db).ok };
  // Search through the generation join; "family calendar" should find L04's chunk with the calendar idea.
  const qv = await ix.queryVector("felles kalender for å reservere hyttehelger");
  const top = search(db, qv, 3);
  const msg = db.prepare("SELECT text FROM message WHERE conversation_id = ? AND source_node_id = ?").get(top[0].cid, top[0].node).text;
  out.S1_search = { top: top.map((r) => r.cid), excerpt: msg.slice(top[0].start, top[0].end).slice(0, 120) };
  out.S1_expectedChunks = p.chunks;
  await ix.close(); db.close();
}

// Same work inline on the main thread (first 15 conversations) for comparison.
{
  const e = await createDirectEmbedder({ rt, modelDir });
  const { makeChunker } = await import("./chunker.mjs");
  const chunk = makeChunker(e.tokenizer, 64);
  const h = monitorEventLoopDelay({ resolution: 10 }); h.enable();
  for (const c of convs.slice(0, 15)) {
    const texts = c.messages.flatMap((m) => chunk(m).map((s) => "passage: " + m.slice(s.start, s.end)));
    await e.embedBatched(texts, 16);
  }
  h.disable();
  out.S1b_inlineMainThread = { conversations: 15, eventLoopDelayMs: { p50: +(h.percentile(50) / 1e6).toFixed(1), p99: +(h.percentile(99) / 1e6).toFixed(1), max: +(h.max / 1e6).toFixed(1) } };
  await e.release();
}

// S2 — cancellation and resume.
{
  const db = fresh("s2.db");
  convs.forEach((c) => importConversation(db, c));
  let n = 0;
  const ix = new Indexer({ db, rt, modelDir, onProgress: () => { if (++n === 10) ix.cancel(); } });
  assert.equal(await ix.run(), "cancelled");
  const mid = { ...progress(db), ...consistent(db) };
  assert.equal(await ix.run(), "done");
  out.S2_cancel = { afterCancel: mid, afterResume: { ...progress(db), ...consistent(db) } };
  assert.equal(progress(db).chunks, out.S1_expectedChunks);
  await ix.close(); db.close();
}

// S3 — a re-import arrives while the worker embeds the old version.
{
  const db = fresh("s3.db");
  convs.forEach((c) => importConversation(db, c));
  const changed = convs.find((c) => c.id === "L04");
  const v2 = { ...changed, messages: changed.messages.map((m, i) => (i === 1 ? m.replace("felles kalender på nett", "felles bookingside på nett") : m)) };
  let fired = false;
  const ix = new Indexer({ db, rt, modelDir, hooks: { beforeCommit: (job) => { if (job.cid === "L04" && !fired) { fired = true; importConversation(db, v2); } } } });
  assert.equal(await ix.run(), "done");
  const gens = db.prepare("SELECT DISTINCT generation g FROM chunk WHERE conversation_id = 'L04'").all().map((r) => r.g);
  const qv = await ix.queryVector("shared family booking page for the cabin weekends");
  const top = search(db, qv, 60).find((r) => r.cid === "L04");
  const text = db.prepare("SELECT text FROM message WHERE conversation_id = 'L04' AND source_node_id = ?").get(top.node).text.slice(top.start, top.end);
  out.S3_reimportDuringInference = { staleCommitsDiscarded: ix.stats.discardedStale, chunkGenerationsForL04: gens, currentGeneration: db.prepare("SELECT generation FROM conversation WHERE id = 'L04'").get().generation,
    resultShowsNewText: text.includes("bookingside"), resultShowsOldText: text.includes("felles kalender"), ...consistent(db) };
  // S6 — between a re-import and its re-index, the conversation has no chunks, so no stale passage can be shown.
  importConversation(db, changed);
  const before = search(db, qv, 60).find((r) => r.cid === "L04");
  out.S6_staleWindow = { L04InSemanticResultsBeforeReindex: Boolean(before), pendingJobs: progress(db).remaining };
  await ix.run();
  await ix.close(); db.close();
}

// S4 — delete-all while a job is being embedded.
{
  const db = fresh("s4.db");
  convs.slice(0, 20).forEach((c) => importConversation(db, c));
  let k = 0;
  const ix = new Indexer({ db, rt, modelDir, hooks: { beforeCommit: () => { if (++k === 5) deleteAll(db); } } });
  assert.equal(await ix.run(), "done");
  out.S4_deleteAllDuringInference = { ...progress(db), staleCommitsDiscarded: ix.stats.discardedStale, jobs: db.prepare("SELECT count(*) n FROM embed_job").get().n };
  await ix.close(); db.close();
}

// S5 — hard kill (SIGKILL) of an indexing process, then recovery.
{
  const file = path.join(tmpDir, "s5.db");
  for (const s of ["", "-wal", "-shm"]) fs.rmSync(file + s, { force: true });
  const db0 = openDb(projectDir, file); convs.forEach((c) => importConversation(db0, c)); db0.close();
  const child = spawn(process.execPath, ["--import", fileURLToPath(new URL("../bench/tripwire.mjs", import.meta.url)), fileURLToPath(new URL("./crash-child.mjs", import.meta.url)), projectDir, rt, modelDir, file], { stdio: ["ignore", "pipe", "ignore"] });
  let commits = 0;
  await new Promise((res) => {
    child.stdout.on("data", (d) => { commits += String(d).split("\n").filter((l) => l === "commit").length; if (commits >= 12 && !child.killed) child.kill("SIGKILL"); });
    child.on("exit", res);
  });
  const db = openDb(projectDir, file);
  const atCrash = { ...progress(db), ...consistent(db) };
  const reset = recover(db);
  const ix = new Indexer({ db, rt, modelDir });
  assert.equal(await ix.run(), "done");
  const dup = db.prepare("SELECT count(*) n FROM (SELECT conversation_id, source_node_id, chunk_index, count(*) c FROM chunk GROUP BY 1, 2, 3 HAVING c > 1)").get().n;
  out.S5_crashRecovery = { killedAfterCommits: commits, atCrash, runningJobsReset: reset, afterRecovery: { ...progress(db), ...consistent(db) }, duplicateChunks: dup, chunksMatchFullIndex: progress(db).chunks === out.S1_expectedChunks, integrity: db.pragma("integrity_check", { simple: true }) };
  await ix.close(); db.close();
}

out.tripwire = globalThis.__tripwireAttempts?.();
console.log(JSON.stringify(out, null, 1));
