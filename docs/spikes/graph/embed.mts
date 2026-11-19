// Graph spike: embed a conversations file with the PRODUCTION chunker and inference child
// (per-conversation batching, as the indexer does). Same output format as
// docs/spikes/mindmap/v2/embed-v2.mts. Synthetic data only; no database is opened.
// Usage: fnm exec --using=24 -- node docs/spikes/graph/embed.mts <conversations.json> <out.json>
import fs from "node:fs";
import { InferenceProcess, productionChildEntry } from "../../../src/lib/semantic/inference-process.ts";
import { resolveModelDir } from "../../../src/lib/semantic/model-files.ts";

const ROOT = process.cwd();
const [input, out] = process.argv.slice(2);
if (!input || !out) throw new Error("usage: embed.mts <conversations.json> <out.json>");
type Conv = { id: string; title: string | null; messages: { role: "user" | "assistant"; text: string }[] };
const convs = JSON.parse(fs.readFileSync(input, "utf8")) as Conv[];
const p = await InferenceProcess.start({ entry: productionChildEntry(ROOT), modelDir: resolveModelDir({ env: process.env, root: ROOT }) });
const result = [];
try {
  for (const c of convs) {
    const chunks = await p.chunk(c.messages.map((m, i) => ({ sourceNodeId: `m${i}`, text: m.text })));
    const vecs: Float32Array[] = [];
    for (let w = 0; w < chunks.length; w += 256) vecs.push(...(await p.embedPassages(chunks.slice(w, w + 256).map((k) => k.text))));
    result.push({
      id: c.id,
      title: c.title,
      chunks: chunks.map((k, i) => {
        const msg = Number(k.sourceNodeId.slice(1));
        return { msg, role: c.messages[msg]!.role, tokenCount: k.tokenCount, start: k.start, end: k.end, text: k.text, v: Array.from(vecs[i]!) };
      }),
      titleV: null,
    });
  }
} finally {
  await p.close();
}
fs.writeFileSync(out, JSON.stringify(result));
console.log(`${result.length} conversations, ${result.reduce((n, c) => n + c.chunks.length, 0)} chunks → ${out}`);
