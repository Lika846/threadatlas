// Builds the equivalence test inputs: every v0 message as a passage, every v0 query, long texts over 512 tokens,
// edge cases (empty after prefix, whitespace, emoji, mixed scripts, markup-like text).
import fs from "node:fs";
const d = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const msgs = d.conversations.flatMap((c) => c.messages);
const long = [];
for (let i = 0; i < 6; i++) long.push(msgs.slice(i * 30, i * 30 + 30).join("\n\n"));
const edge = ["", "   ", "🙂🚲 ✓", "Mix: café, blåbær, ключ, 東京", "<b>bold</b> & <script>x</script>", "a".repeat(3000), "line1\n\n\nline2\t\ttab"];
const texts = [
  ...msgs.map((t) => "passage: " + t),
  ...d.queries.map((q) => "query: " + q.text),
  ...long.map((t) => "passage: " + t),
  ...edge.map((t) => "passage: " + t),
];
fs.writeFileSync(process.argv[3], JSON.stringify(texts));
console.log(texts.length, "texts");
