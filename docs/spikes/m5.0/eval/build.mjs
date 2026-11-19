import fs from "node:fs";
const dir = process.argv[2];
const { conversations, queries } = await import(`${dir}/dataset.mjs`);
const ids = new Set();
for (const c of conversations) { if (ids.has(c.id)) throw new Error(`dup ${c.id}`); ids.add(c.id); if (c.messages.length < 2) throw new Error(c.id); }
const qids = new Set();
for (const q of queries) {
  if (qids.has(q.id)) throw new Error(`dup ${q.id}`); qids.add(q.id);
  for (const id of Object.keys(q.relevant)) if (!ids.has(id)) throw new Error(`${q.id} -> ${id}`);
  if (q.target) { const c = conversations.find((x) => x.id === q.target[0]); if (!c || [q.target[1]].flat().some((n) => n < 1 || n > c.messages.length)) throw new Error(`target ${q.id}`); if (!(q.target[0] in q.relevant)) throw new Error(`target not relevant ${q.id}`); }
}
fs.writeFileSync(`${dir}/dataset.json`, JSON.stringify({ conversations, queries }));
const by = (xs, k) => Object.entries(xs.reduce((a, x) => ((a[x[k]] = (a[x[k]] ?? 0) + 1), a), {}));
const msgs = conversations.reduce((n, c) => n + c.messages.length, 0);
const chars = conversations.reduce((n, c) => n + c.messages.join("").length, 0);
console.log(JSON.stringify({ conversations: conversations.length, byKind: by(conversations, "kind"), byLang: by(conversations, "lang"), messages: msgs, chars, queries: queries.length, byCategory: by(queries, "category"), byQueryLang: by(queries, "lang") }));
