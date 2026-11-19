/**
 * Worker thread against child process, measured in plain Node (M5.1b shutdown comparison).
 *   node bench.ts compare <ref.json>          startup, equality, throughput, memory, cancel, drain, crash isolation
 *   node bench.ts memory <thread|process>     resident memory in a fresh process
 *   node bench.ts parent-dies <exit|sigkill> <events file>
 *                                             start a busy child, then this process dies; the child must drain alone
 * Needs THREADATLAS_MODEL_DIR. Synthetic text only.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Embedder } from "../../../../src/lib/semantic/embedder.ts";
import { ProcessEmbedder } from "./process-embedder.ts";

const root = path.resolve(import.meta.dirname, "../../../..");
const modelDir = process.env.THREADATLAS_MODEL_DIR!;
const entry = path.join(import.meta.dirname, "child-entry.ts");
const workerUrl = pathToFileURL(path.join(root, "src/lib/semantic/worker.ts"));
const SYNTHETIC = [
  "The community garden plan needs a budget for seeds and tools.",
  "Hagen trenger et budsjett for frø og verktøy til våren.",
  "Бюджет на семена и инструменты для сада нужно утвердить.",
  "A short note.",
];
const texts = (n: number) => Array.from({ length: n }, (_, i) => `Synthetic passage ${i} about gardening budgets, travel plans and recipes.`);
type Any = Embedder | ProcessEmbedder;
const start = (mode: "thread" | "process", extra: { log?: string; stderr?: "inherit" } = {}): Promise<Any> =>
  mode === "thread" ? Embedder.start({ modelDir, verifyHashes: false, workerUrl }) : ProcessEmbedder.start({ modelDir, verifyHashes: false, entry, log: process.env.CHILD_LOG, ...extra });
const rssKb = (pid: number) => Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim());
const ms = (t: number) => Math.round(performance.now() - t);

async function compare(refFile: string) {
  const ref = Buffer.from(JSON.parse(fs.readFileSync(refFile, "utf8")).vectors, "base64");
  const out: { thread: Record<string, unknown>; process: Record<string, unknown> } = { thread: {}, process: {} };
  // Startup, alternating, 5 each.
  for (const mode of ["thread", "process"] as const) out[mode].startMs = [];
  for (let i = 0; i < 5; i++) {
    for (const mode of ["thread", "process"] as const) {
      const t = performance.now();
      const e = await start(mode);
      (out[mode].startMs as number[]).push(ms(t));
      await e.close();
    }
  }
  for (const mode of ["thread", "process"] as const) {
    const o = out[mode];
    const e = await start(mode);
    const v = [...(await e.embedPassages(SYNTHETIC)), await e.embedQuery("garden budget")];
    o.bitIdenticalToReference = Buffer.concat(v.map((x) => Buffer.from(x.buffer, x.byteOffset, x.byteLength))).equals(ref);
    let t = performance.now();
    await e.embedPassages(texts(2_000));
    o.embed2000Ms = ms(t);
    o.rssParentMb = Math.round(rssKb(process.pid) / 1024);
    if (e instanceof ProcessEmbedder) o.rssChildMb = Math.round(rssKb(e.pid) / 1024);
    // Cancellation latency during a long call.
    const p = e.embedPassages(texts(6_000)).catch((err: { code?: string }) => err.code);
    await new Promise((r) => setTimeout(r, 500));
    t = performance.now();
    e.cancel();
    o.cancelResult = await p;
    o.cancelMs = ms(t);
    // Drain: close while a batch is running.
    void e.embedPassages(texts(6_000)).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    t = performance.now();
    await e.close();
    o.closeDuringBatchMs = ms(t);
    await new Promise((r) => setTimeout(r, 50));
  }
  // Crash isolation: the inference process aborts mid-batch (SIGABRT, as ONNX Runtime does).
  const e = (await start("process")) as ProcessEmbedder;
  const p = e.embedPassages(texts(6_000)).catch((err: { code?: string }) => err.code);
  await new Promise((r) => setTimeout(r, 500));
  process.kill(e.pid, "SIGABRT");
  out.process.crashIsolation = { pendingRejectedWith: await p, parentAlive: true, stateAfter: e.state };
  const t = performance.now();
  const again = await start("process");
  out.process.crashIsolation = { ...(out.process.crashIsolation as object), restartMs: ms(t), worksAfterRestart: (await again.embedQuery("x")).length === 384 };
  await again.close();
  out.thread.crashIsolation = "none: a native abort in the worker thread ends the whole process (integration spike: 8 of 8)";
  console.log(JSON.stringify(out, null, 1));
}

async function parentDies(how: string, log: string) {
  const e = (await start("process", { log, stderr: "inherit" })) as ProcessEmbedder;
  void e.embedPassages(texts(6_000)).catch(() => {});
  await new Promise((r) => setTimeout(r, 700));
  fs.appendFileSync(log, JSON.stringify({ pid: process.pid, role: "parent", name: `dies-${how}`, at: Date.now(), child: e.pid }) + "\n");
  if (how === "exit") process.exit(143);
  process.kill(process.pid, "SIGKILL");
}

/** Memory in a fresh process: baseline, then after starting and embedding 2,000 texts. */
async function memory(mode: "thread" | "process") {
  const base = Math.round(rssKb(process.pid) / 1024);
  const e = await start(mode);
  await e.embedPassages(texts(2_000));
  const parent = Math.round(rssKb(process.pid) / 1024);
  const child = e instanceof ProcessEmbedder ? Math.round(rssKb(e.pid) / 1024) : 0;
  await e.close();
  await new Promise((r) => setTimeout(r, 2_000));
  const afterClose = Math.round(rssKb(process.pid) / 1024);
  console.log(JSON.stringify({ mode, baselineMb: base, parentMb: parent, childMb: child, totalMb: parent + child, parentAfterCloseMb: afterClose }));
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === "compare") await compare(a!);
else if (cmd === "memory") await memory(a as "thread" | "process");
else if (cmd === "parent-dies") await parentDies(a!, b!);
else console.error("usage: bench.ts compare <ref.json> | parent-dies <exit|sigkill> <events>");
