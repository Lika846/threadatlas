// Sentence-packed chunker: exact substrings of the message with character offsets.
// Whole sentences up to `max` tokens, one sentence of overlap; an over-long sentence is its own chunk.
export const CHUNKER_VERSION = "sent-64-v1";
export function makeChunker(tokenizer, max = 64) {
  const ntok = (s) => tokenizer.encode(s, { add_special_tokens: false }).ids.length;
  return function chunk(text) {
    const ss = [];
    const re = /[^.!?\n]+(?:[.!?]+|$)|\n+/g;
    let m;
    while ((m = re.exec(text))) {
      if (/^\s*$/.test(m[0])) continue;
      const lead = m[0].length - m[0].trimStart().length;
      const start = m.index + lead, end = m.index + m[0].trimEnd().length;
      ss.push({ start, end, n: ntok(text.slice(start, end)) });
    }
    const out = [];
    let i = 0;
    while (i < ss.length) {
      let j = i, n = 0;
      while (j < ss.length && (j === i || n + ss[j].n <= max)) { n += ss[j].n; j++; }
      out.push({ start: ss[i].start, end: ss[j - 1].end });
      if (j >= ss.length) break;
      i = j - 1 > i ? j - 1 : j;
    }
    return out;
  };
}
