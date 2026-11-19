// Mind-map spike v2, step 1: embed the v2 test set with the PRODUCTION chunker and inference
// child (per-conversation batching, as the indexer does). Reads only conversations.json (text),
// never labels.json. Synthetic data only; no database is opened.
// Usage: fnm exec --using=24 -- node docs/spikes/mindmap/v2/embed-v2.mts <out.json>
import fs from "node:fs";
import path from "node:path";
import { InferenceProcess, productionChildEntry } from "../../../../src/lib/semantic/inference-process.ts";
import { resolveModelDir } from "../../../../src/lib/semantic/model-files.ts";

const ROOT = process.cwd();
const out = process.argv[2];
if (!out) throw new Error("usage: embed-v2.mts <out.json>");
type Conv = { id: string; title: string | null; messages: { role: "user" | "assistant"; text: string }[] };
const convs = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/spikes/mindmap/v2/conversations.json"), "utf8")) as Conv[];

const p = await InferenceProcess.start({ entry: productionChildEntry(ROOT), modelDir: resolveModelDir({ env: process.env, root: ROOT }) });
const result = [];
const t0 = performance.now();
try {
  for (const c of convs) {
    const chunks = await p.chunk(c.messages.map((m, i) => ({ sourceNodeId: `m${i}`, text: m.text })));
    const vecs: Float32Array[] = [];
    for (let w = 0; w < chunks.length; w += 256) vecs.push(...(await p.embedPassages(chunks.slice(w, w + 256).map((k) => k.text))));
    const rows = chunks.map((k, i) => {
      const msg = Number(k.sourceNodeId.slice(1));
      return { msg, role: c.messages[msg]!.role, tokenCount: k.tokenCount, start: k.start, end: k.end, text: k.text, v: Array.from(vecs[i]!) };
    });
    // Production has no title for "New chat"/empty; embed a title only when there is one.
    const titleV = c.title ? Array.from((await p.embedPassages([c.title]))[0]!) : null;
    result.push({ id: c.id, title: c.title, chunks: rows, titleV });
  }
} finally {
  await p.close();
}
fs.writeFileSync(out, JSON.stringify(result));
console.log(`${result.length} conversations, ${result.reduce((n, c) => n + c.chunks.length, 0)} chunks, ${Math.round(performance.now() - t0)} ms → ${out}`);
