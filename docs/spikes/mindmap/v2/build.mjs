// Mind-map spike v2: split the hand-written sources into text (for clustering) and labels.
// Usage: node docs/spikes/mindmap/v2/build.mjs [--tally] [--out <dir>]
// Writes v2/conversations.json (or <dir>/conversations.json with --out; the real-model search
// test builds into a temporary directory) (id, title, messages: {role, text}) and v2/labels.json
// (theme, topic, topic2, oneoff, lang, messageLangs). Prints a tally against taxonomy.json.
import fs from "node:fs";
import path from "node:path";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const outAt = process.argv.indexOf("--out");
const OUT = outAt > 0 ? path.resolve(process.argv[outAt + 1]) : DIR;
const taxonomy = JSON.parse(fs.readFileSync(path.join(DIR, "taxonomy.json"), "utf8"));
const themeOf = new Map();
for (const [theme, topics] of Object.entries(taxonomy)) for (const t of Object.keys(topics)) themeOf.set(t, theme);

const files = fs.readdirSync(path.join(DIR, "src")).filter((f) => f.endsWith(".txt")).sort();
const conversations = [];
const labels = {};
const errors = [];
for (const f of files) {
  const lines = fs.readFileSync(path.join(DIR, "src", f), "utf8").split("\n");
  let cur = null;
  let msg = null;
  const flush = () => {
    if (msg) {
      msg.text = msg.text.trim();
      cur.messages.push(msg);
      msg = null;
    }
  };
  for (const [n, line] of lines.entries()) {
    const head = line.match(/^=== (\S+) \| (.*?) \| (\S+) \| (\S+) \| (en|no|ru)\s*$/);
    if (head) {
      if (cur) flush();
      const [, id, title, topic, topic2, lang] = head;
      const oneoff = topic.startsWith("oneoff:");
      if (!oneoff && !themeOf.has(topic)) errors.push(`${f}:${n + 1} unknown topic ${topic}`);
      if (topic2 !== "-" && !themeOf.has(topic2)) errors.push(`${f}:${n + 1} unknown topic2 ${topic2}`);
      if (labels[id]) errors.push(`${f}:${n + 1} duplicate id ${id}`);
      cur = { id, title: title.trim() === "" ? null : title.trim(), messages: [], lang, langs: [] };
      conversations.push(cur);
      labels[id] = {
        theme: oneoff ? "oneoff" : themeOf.get(topic),
        topic,
        topic2: topic2 === "-" ? null : topic2,
        theme2: topic2 === "-" ? null : themeOf.get(topic2),
        oneoff,
        lang,
        messageLangs: [],
      };
      continue;
    }
    // "+++ <id> | <topic2 or ->": follow-up messages appended to an earlier conversation.
    const ext = line.match(/^\+\+\+ (\S+) \| (\S+)\s*$/);
    if (ext) {
      if (cur) flush();
      const target = conversations.find((c) => c.id === ext[1]);
      if (!target) {
        errors.push(`${f}:${n + 1} unknown id ${ext[1]}`);
        cur = null;
        continue;
      }
      if (ext[2] !== "-") {
        if (!themeOf.has(ext[2])) errors.push(`${f}:${n + 1} unknown topic2 ${ext[2]}`);
        labels[target.id].topic2 = ext[2];
        labels[target.id].theme2 = themeOf.get(ext[2]);
      }
      cur = target;
      continue;
    }
    const m = line.match(/^([UA])(?:\[(en|no|ru)\])?: ?(.*)$/);
    if (m && cur) {
      flush();
      msg = { role: m[1] === "U" ? "user" : "assistant", text: m[3] };
      labels[cur.id].messageLangs.push(m[2] ?? cur.lang);
      continue;
    }
    if (msg) msg.text += "\n" + line;
    else if (line.trim() && !line.startsWith("#")) errors.push(`${f}:${n + 1} stray line`);
  }
  if (cur) flush();
}
for (const c of conversations) {
  if (c.messages.some((m, i) => i > 0 && m.role === c.messages[i - 1].role && m.role === "assistant")) errors.push(`${c.id}: two assistant messages in a row`);
  if (c.messages.length === 0) errors.push(`${c.id}: no messages`);
  if (c.messages[0]?.role !== "user") errors.push(`${c.id}: first message is not the user's`);
  delete c.lang;
  delete c.langs;
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
fs.writeFileSync(path.join(OUT, "conversations.json"), JSON.stringify(conversations, null, 1));
fs.writeFileSync(path.join(OUT, "labels.json"), JSON.stringify(labels, null, 1));

// Tally.
const words = (c) => c.messages.reduce((s, m) => s + m.text.split(/\s+/).length, 0);
const band = (c) => (c.messages.length <= 2 ? "short" : c.messages.length <= 4 ? "medium" : "long");
const count = (f) => {
  const m = new Map();
  for (const c of conversations) m.set(f(c), (m.get(f(c)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ");
};
console.log(`${conversations.length} conversations, ${conversations.reduce((s, c) => s + words(c), 0)} words`);
console.log("languages:", count((c) => labels[c.id].lang));
console.log("length:", count(band));
console.log("titles missing/'New chat':", conversations.filter((c) => !c.title || /^new chat$/i.test(c.title)).length);
console.log("mixed-language conversations:", conversations.filter((c) => new Set(labels[c.id].messageLangs).size > 1).length);
console.log("with topic2:", Object.values(labels).filter((l) => l.topic2).length);
if (process.argv.includes("--tally")) {
  const have = new Map();
  for (const l of Object.values(labels)) have.set(l.oneoff ? "_" : l.topic, (have.get(l.oneoff ? "_" : l.topic) ?? 0) + 1);
  for (const [theme, topics] of Object.entries(taxonomy))
    console.log(theme.padEnd(9), Object.entries(topics).map(([t, n]) => `${t} ${have.get(t) ?? 0}/${n}`).join(" · "));
}
