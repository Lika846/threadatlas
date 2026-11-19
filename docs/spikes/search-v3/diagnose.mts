// Search quality spike (2026-11-19), step 1: why does "I can't stop thinking about work in the
// evening" rank "Overwhelmed and can't switch off" 21st? The production ranking rule
// (`topConversations`: a conversation scores its best chunk of at least MIN_SEARCH_TOKENS
// tokens) reproduced on the v2 synthetic set's production chunks and int8 vectors, with the
// query embedded by the production model. Synthetic data only; no database.
// Usage: fnm exec --using=24 -- node docs/spikes/search-v3/diagnose.mts <v2.json> [query]
import { InferenceProcess, productionChildEntry } from "../../../src/lib/semantic/inference-process.ts";
import { resolveModelDir } from "../../../src/lib/semantic/model-files.ts";
import { load, type Item } from "../mindmap/v3/shared-v3.mts";
import { MIN_SEARCH_TOKENS } from "../../../src/lib/semantic/search/vector-cache.ts";

const ROOT = process.cwd();
const [file, queryArg] = process.argv.slice(2);
if (!file) throw new Error("usage: diagnose.mts <v2.json> [query]");
const query = queryArg ?? "I can't stop thinking about work in the evening";
const items = load("test", file, ROOT);
const p = await InferenceProcess.start({ entry: productionChildEntry(ROOT), modelDir: resolveModelDir({ env: process.env, root: ROOT }) });
const q = await p.embedQuery(query);
await p.close();
const dot = (v: Float64Array) => v.reduce((s, x, i) => s + x * q[i]!, 0);

type Scored = { item: Item; best: number; bestText: string; chunks: { s: number; text: string; role: string; tokens: number }[] };
const scored: Scored[] = items.map((item) => {
  const chunks = item.chunks.map((k) => ({ s: dot(k.v), text: k.text ?? "", role: k.role, tokens: k.tokenCount }));
  const long = chunks.filter((c) => c.tokens >= MIN_SEARCH_TOKENS);
  const pool = long.length > 0 ? long : chunks;
  const best = pool.reduce((a, b) => (b.s > a.s ? b : a));
  return { item, best: best.s, bestText: best.text, chunks };
});
scored.sort((a, b) => b.best - a.best);
console.log(`Query: ${query}\n`);
scored.slice(0, 25).forEach((x, i) => console.log(`${String(i + 1).padStart(2)}. ${x.best.toFixed(3)} [${x.item.topics.join(",")}] ${x.item.title} — “${x.bestText.slice(0, 90).replace(/\n/g, " ")}”`));
const target = scored.findIndex((x) => x.item.title === "Overwhelmed and can't switch off");
if (target >= 0) {
  console.log(`\nTarget at rank ${target + 1}; its chunks:`);
  for (const c of scored[target]!.chunks) console.log(`  ${c.s.toFixed(3)} ${c.role} ${c.tokens} tok — “${c.text.slice(0, 110).replace(/\n/g, " ")}”`);
}
