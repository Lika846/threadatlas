// Search spike v3: embed the chatter-heavy test archive (tests/helpers/chat-corpus.ts: CHAT_CORPUS
// plus 300 template "filler" conversations) with the production chunker and inference child, as the
// opt-in model test indexes it. Synthetic data only; no database.
// Usage: fnm exec --using=24 -- node docs/spikes/search-v3/embed-chat.mts <out.json>
import fs from "node:fs";
import { InferenceProcess, productionChildEntry } from "../../../src/lib/semantic/inference-process.ts";
import { resolveModelDir } from "../../../src/lib/semantic/model-files.ts";
import { CHAT_CORPUS, CHAT_FILLER } from "../../../tests/helpers/chat-corpus.ts";

const out = process.argv[2];
if (!out) throw new Error("usage: embed-chat.mts <out.json>");
const ROOT = process.cwd();
const p = await InferenceProcess.start({ entry: productionChildEntry(ROOT), modelDir: resolveModelDir({ env: process.env, root: ROOT }) });
const result = [];
try {
  for (const c of [...CHAT_CORPUS, ...CHAT_FILLER]) {
    const chunks = await p.chunk(c.messages.map((m, i) => ({ sourceNodeId: `m${i}`, text: m })));
    const vecs = await p.embedPassages(chunks.map((k) => k.text));
    result.push({ id: c.id, chunks: chunks.map((k, i) => ({ msg: Number(k.sourceNodeId.slice(1)), tokenCount: k.tokenCount, text: k.text, v: Array.from(vecs[i]!) })) });
  }
} finally {
  await p.close();
}
fs.writeFileSync(out, JSON.stringify(result));
console.log(`${result.length} conversations → ${out}`);
