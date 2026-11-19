// Validates the long set, writes long.json and union.json (v0 + long conversations; queries kept separate),
// and reports token lengths and the token position of each evidence phrase.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [evalDir, v0File, rt, modelDir] = process.argv.slice(2);
const { conversations, queries } = await import(pathToFileURL(path.join(evalDir, "long.mjs")).href);
const v0 = JSON.parse(fs.readFileSync(v0File, "utf8"));
const { Tokenizer } = await import(pathToFileURL(path.join(rt, "@huggingface/tokenizers/dist/tokenizers.mjs")).href);
const tok = new Tokenizer(JSON.parse(fs.readFileSync(path.join(modelDir, "tokenizer.json"), "utf8")), JSON.parse(fs.readFileSync(path.join(modelDir, "tokenizer_config.json"), "utf8")));
const n = (t) => tok.encode(t, { add_special_tokens: false }).ids.length;
const ids = new Set(v0.conversations.map((c) => c.id));
for (const c of conversations) { if (ids.has(c.id)) throw new Error("dup " + c.id); ids.add(c.id); }
const byId = new Map([...v0.conversations, ...conversations].map((c) => [c.id, c]));
const rows = [];
for (const q of queries) {
  for (const id of Object.keys(q.relevant)) if (!byId.has(id)) throw new Error(`${q.id} -> ${id}`);
  const msg = byId.get(q.target[0]).messages[q.target[1] - 1];
  const at = msg.toLowerCase().indexOf(q.evidence.toLowerCase());
  if (at < 0) throw new Error(`evidence not found ${q.id}`);
  rows.push({ q: q.id, cat: q.category, msgTokens: n(msg), evidenceAtToken: n("passage: " + msg.slice(0, at)) + 1 });
}
fs.writeFileSync(path.join(evalDir, "long.json"), JSON.stringify({ conversations, queries }));
fs.writeFileSync(path.join(evalDir, "union.json"), JSON.stringify({ conversations: [...v0.conversations, ...conversations], queries }));
const longMsgs = conversations.flatMap((c) => c.messages.map((m, i) => ({ c: c.id, i: i + 1, t: n(m) })));
console.log("long conversations", conversations.length, "messages", longMsgs.length, "queries", queries.length);
console.log("message tokens (long set):", longMsgs.map((m) => `${m.c}#${m.i}:${m.t}`).join(" "));
console.log("evidence position (token index within the message, 512 = truncation limit):");
for (const r of rows) console.log(`  ${r.q} ${r.cat.padEnd(6)} message ${r.msgTokens} tokens, evidence at ${r.evidenceAtToken}${r.evidenceAtToken > 510 ? "  (beyond truncation)" : ""}`);
