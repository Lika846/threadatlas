// Builds tests/fixtures/semantic/e5-reference.json, the equivalence fixture for M5.1a:
// token ids and vectors computed by Transformers.js 3.8.1 (the independent reference
// pipeline of Experiment 1) for synthetic texts from the v0 evaluation set.
//
// Usage (offline, in the M5.0 scratch environment):
//   sandbox-exec -f nonet.sb node --import ./tripwire.mjs make-reference-fixture.mjs \
//     <exp1 rt node_modules> <models dir> <docs/spikes/m5.0/eval/dataset.json> <out.json>
//
// - single:  each text embedded alone (batch of 1), with its token ids.
// - batch:   8 passages embedded in one call, ordered by token length (ties by position),
//            the order the production pipeline uses, so its batch is identical.
// - long:    a text over 512 tokens: its full, untruncated ids (truncation check only;
//            Transformers.js 3.8.1 truncates differently, so no reference vector).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [rt, models, datasetFile, outFile] = process.argv.slice(2);
const tf = await import(pathToFileURL(path.join(rt, "@huggingface/transformers/dist/transformers.node.mjs")).href);
Object.assign(tf.env, { allowRemoteModels: false, allowLocalModels: true, localModelPath: models + "/", useFSCache: false, useBrowserCache: false });
const ex = await tf.pipeline("feature-extraction", "Xenova/multilingual-e5-small", { dtype: "q8", device: "cpu" });
const d = JSON.parse(fs.readFileSync(datasetFile, "utf8"));

const b64 = (vs) => Buffer.from(new Float32Array(vs.flatMap((v) => Array.from(v))).buffer).toString("base64");
const idsOf = (t, truncation = true) => Array.from(ex.tokenizer(t, { truncation }).input_ids.data, Number);
async function embed(texts) {
  const r = await ex(texts, { pooling: "mean", normalize: true });
  const [n, dim] = r.dims;
  return Array.from({ length: n }, (_, k) => r.data.slice(k * dim, (k + 1) * dim));
}
const prefix = { query: "query: ", passage: "passage: " };

const queries = ["p01", "p05", "x01", "x04", "b02", "k01", "u01", "d01"].map((id) => d.queries.find((q) => q.id === id)).filter(Boolean);
const shortMessages = d.conversations.flatMap((c) => c.messages).filter((m) => idsOf(prefix.passage + m).length <= 64);
const singles = [
  ...queries.map((q) => ({ kind: "query", text: q.text })),
  ...shortMessages.slice(0, 10).map((text) => ({ kind: "passage", text })),
  ...["", "🙂🚲 ✓", "Mix: café, blåbær, ключ, 東京", "<b>bold</b> & <script>x</script>", "line1\n\n\nline2\t\ttab"].map((text) => ({ kind: "passage", text })),
];
const single = [];
for (const s of singles) {
  const full = prefix[s.kind] + s.text;
  const [v] = await embed([full]);
  single.push({ ...s, ids: idsOf(full), vector: b64([v]) });
}

const batchTexts = shortMessages
  .slice(10, 18)
  .map((text, i) => ({ text, i, n: idsOf(prefix.passage + text).length }))
  .sort((a, b) => a.n - b.n || a.i - b.i)
  .map((x) => x.text);
const batchVectors = await embed(batchTexts.map((t) => prefix.passage + t));

const longText = d.conversations.flatMap((c) => c.messages).slice(0, 30).join("\n\n");
const out = {
  _synthetic: true,
  about: "Reference token ids and vectors from Transformers.js 3.8.1 for synthetic texts (docs/spikes/m5.0/eval/dataset.json).",
  generator: "docs/spikes/m5.0/experiment-2/bench/make-reference-fixture.mjs",
  reference: { runtime: "@huggingface/transformers@3.8.1 on onnxruntime-node@1.23.2", model: "Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78 (q8)", pooling: "mean", normalize: true },
  dims: 384,
  single,
  batch: { kind: "passage", texts: batchTexts, vectors: b64(batchVectors) },
  long: { kind: "passage", text: longText, fullIds: idsOf(prefix.passage + longText, false) },
};
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(out) + "\n");
console.log(`single ${single.length}, batch ${batchTexts.length}, long ${out.long.fullIds.length} ids; tripwire ${globalThis.__tripwireAttempts?.()}`);
