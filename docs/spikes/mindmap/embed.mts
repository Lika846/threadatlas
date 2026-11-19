// Mind-map spike, step 1: embed the synthetic corpora with the PRODUCTION chunker and model
// (inference child, per-conversation batching, as the indexer does). Synthetic data only;
// no database is opened. Output: a JSON file of chunk vectors (float32) with message roles,
// plus one title vector (passage prefix) and query-prefixed user-chunk vectors (side check).
// Usage: fnm exec --using=24 -- node docs/spikes/mindmap/embed.mts <out.json>
import fs from "node:fs";
import path from "node:path";
import { InferenceProcess, productionChildEntry } from "../../../src/lib/semantic/inference-process.ts";
import { resolveModelDir } from "../../../src/lib/semantic/model-files.ts";
import { CHAT_CORPUS } from "../../../tests/helpers/chat-corpus.ts";

const ROOT = process.cwd();
const out = process.argv[2];
if (!out) throw new Error("usage: embed.mts <out.json>");
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(ROOT, "docs/spikes/m5.0/eval", f), "utf8"));

type Conv = { id: string; set: string; lang: string; title: string; messages: string[] };
const convs: Conv[] = [
  ...CHAT_CORPUS.map((c) => ({
    id: c.id,
    set: "chat",
    lang: c.id === "norwegian-phrases" ? "no" : "en",
    // Same rule as topics.model.test.ts: "python-keyerror" → "Python keyerror".
    title: c.id.replace(/-/g, " ").replace(/^./, (x) => x.toUpperCase()),
    messages: c.messages,
  })),
  ...read("dataset.json").conversations.map((c: Conv) => ({ ...c, set: "v0" })),
  ...read("long.json").conversations.map((c: Conv) => ({ ...c, set: "long" })),
];

const p = await InferenceProcess.start({ entry: productionChildEntry(ROOT), modelDir: resolveModelDir({ env: process.env, root: ROOT }) });
const result = [];
try {
  for (const c of convs) {
    const chunks = await p.chunk(c.messages.map((text, i) => ({ sourceNodeId: `m${i}`, text })));
    const vecs: Float32Array[] = [];
    for (let w = 0; w < chunks.length; w += 256) vecs.push(...(await p.embedPassages(chunks.slice(w, w + 256).map((k) => k.text))));
    const rows = [];
    for (let i = 0; i < chunks.length; i++) {
      const k = chunks[i]!;
      const msg = Number(k.sourceNodeId.slice(1));
      const role = msg % 2 === 0 ? "user" : "assistant";
      const q = role === "user" ? Array.from(await p.embedQuery(k.text)) : null;
      rows.push({ msg, role, tokenCount: k.tokenCount, v: Array.from(vecs[i]!), q });
    }
    const [title] = await p.embedPassages([c.title]);
    result.push({ id: c.id, set: c.set, lang: c.lang, title: c.title, chunks: rows, titleV: Array.from(title!) });
    process.stdout.write(".");
  }
} finally {
  await p.close();
}
fs.writeFileSync(out, JSON.stringify(result));
console.log(`\n${result.length} conversations, ${result.reduce((n, c) => n + c.chunks.length, 0)} chunks → ${out}`);
