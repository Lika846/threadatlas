/**
 * Deterministic sentence-aware chunker (ADR 0002 decision 4, D122).
 *
 * A chunk is an exact substring of one message, identified by UTF-16 code-unit offsets
 * `[start, end)` into the message text, and holds at most `maxTokens` model tokens
 * (counted without special tokens and without the `passage: ` prefix).
 *
 * 1. **Units.** The text is split into lines at line breaks; each line into sentences.
 *    A sentence ends after `.`, `!`, `?`, `…` (or `‼ ⁇ ⁈ ⁉`), optionally followed by
 *    closing quotes or brackets, when whitespace or the end of the line follows; or
 *    directly after `。`, `！` or `？`. Spans are trimmed; blank spans are dropped.
 * 2. **Oversized units.** A unit over the budget is split at whitespace into the longest
 *    runs of words that fit. A single word over the budget is split at code-point
 *    boundaries into the longest prefixes that fit (never inside a surrogate pair).
 * 3. **Packing.** Consecutive units are packed into a chunk while the chunk's exact
 *    token count stays within the budget.
 * 4. **Overlap.** When a chunk has two or more units, the next chunk starts with its
 *    last unit, provided that unit and the following one fit together; otherwise the
 *    next chunk starts at the following unit (so no chunk is a subset of another).
 *
 * Same text, tokenizer and options → same chunks and chunk ids. Changing any rule here
 * requires a new `CHUNKER_VERSION`.
 *
 * Differences from the M5.0 research chunker (`sent-64-v1`): lines without final
 * punctuation are kept (the research regex dropped them), `.`/`!`/`?` must be followed by
 * whitespace (so `3.5` and `example.com` stay whole), CJK sentence marks are recognised,
 * oversized sentences are split, token budgets are exact counts of the chunk text, and
 * a redundant overlap-only chunk is never produced.
 */
import { createHash } from "node:crypto";

export const CHUNKER_VERSION = "sentence-pack-v1";
export const DEFAULT_CHUNK_TOKENS = 64;

export type Span = { readonly start: number; readonly end: number };

export type MessageInput = { readonly sourceNodeId: string; readonly text: string };

export type Chunk = {
  /** Content-addressed id: same message, offsets, text, chunker and tokenizer → same id. */
  readonly id: string;
  readonly sourceNodeId: string;
  /** Position of the chunk within its message, from 0. */
  readonly chunkIndex: number;
  readonly start: number;
  readonly end: number;
  readonly tokenCount: number;
  readonly text: string;
};

export type ChunkerOptions = {
  readonly countTokens: (text: string) => number;
  readonly maxTokens?: number;
  /** Identifies the tokenizer that counted the tokens; part of every chunk id. */
  readonly tokenizerKey: string;
};

const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/g;
// Terminal punctuation (. ! ? … ‼ ⁇ ⁈ ⁉), optional closing quotes or brackets, then
// whitespace or end of line; or a CJK sentence mark (。！？) with optional closers.
const CLOSERS = "[\"'\u201d\u2019\u00bb)\\]}\u300d\u300f]*";
const SENTENCE_END = new RegExp(
  `[.!?\u2026\u203c\u2047\u2048\u2049]+${CLOSERS}(?=\\s|$)|[\u3002\uff01\uff1f]+${CLOSERS}`,
  "gu",
);

function trimmed(text: string, start: number, end: number): Span | null {
  let s = start;
  let e = end;
  while (s < e && /\s/u.test(text[s]!)) s++;
  while (e > s && /\s/u.test(text[e - 1]!)) e--;
  return s < e ? { start: s, end: e } : null;
}

/** Sentence spans (step 1), in order, as offsets into `text`. */
export function splitSentences(text: string): Span[] {
  const out: Span[] = [];
  const lines: Span[] = [];
  let lineStart = 0;
  for (const m of text.matchAll(LINE_BREAK)) {
    lines.push({ start: lineStart, end: m.index });
    lineStart = m.index + m[0].length;
  }
  lines.push({ start: lineStart, end: text.length });
  for (const line of lines) {
    const body = text.slice(line.start, line.end);
    let from = 0;
    for (const m of body.matchAll(SENTENCE_END)) {
      const to = m.index + m[0].length;
      const span = trimmed(text, line.start + from, line.start + to);
      if (span) out.push(span);
      from = to;
    }
    const rest = trimmed(text, line.start + from, line.end);
    if (rest) out.push(rest);
  }
  return out;
}

/** Splits one word (no whitespace) at code-point boundaries into the longest prefixes that fit. */
function splitWord(text: string, span: Span, count: (s: string) => number, max: number): Span[] {
  const cps: number[] = []; // code-unit offset of each code point
  for (let i = span.start; i < span.end; ) {
    cps.push(i);
    i += (text.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
  }
  cps.push(span.end);
  const out: Span[] = [];
  let a = 0; // index into cps
  while (a < cps.length - 1) {
    // Largest b in (a, last] with count(text[cps[a], cps[b])) <= max; at least one code point.
    let lo = a + 1;
    let hi = cps.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (count(text.slice(cps[a], cps[mid])) <= max) lo = mid;
      else hi = mid - 1;
    }
    out.push({ start: cps[a]!, end: cps[lo]! });
    a = lo;
  }
  return out;
}

/** Splits an oversized unit (step 2). */
function splitOversized(text: string, unit: Span, count: (s: string) => number, max: number): Span[] {
  const words: Span[] = [];
  for (const m of text.slice(unit.start, unit.end).matchAll(/\S+/gu)) {
    words.push({ start: unit.start + m.index, end: unit.start + m.index + m[0].length });
  }
  const out: Span[] = [];
  let i = 0;
  while (i < words.length) {
    const first = words[i]!;
    if (count(text.slice(first.start, first.end)) > max) {
      out.push(...splitWord(text, first, count, max));
      i++;
      continue;
    }
    let j = i + 1;
    while (j < words.length && count(text.slice(first.start, words[j]!.end)) <= max) j++;
    out.push({ start: first.start, end: words[j - 1]!.end });
    i = j;
  }
  return out;
}

/** Chunk spans for one message text (steps 1–4). */
export function chunkSpans(text: string, opts: { countTokens: (s: string) => number; maxTokens?: number }): Span[] {
  const max = opts.maxTokens ?? DEFAULT_CHUNK_TOKENS;
  if (!Number.isInteger(max) || max < 1) throw new RangeError("maxTokens must be a positive integer");
  const count = opts.countTokens;
  const units: Span[] = [];
  for (const s of splitSentences(text)) {
    if (count(text.slice(s.start, s.end)) <= max) units.push(s);
    else units.push(...splitOversized(text, s, count, max));
  }
  const fits = (a: Span, b: Span) => count(text.slice(a.start, b.end)) <= max;
  const out: Span[] = [];
  let i = 0;
  while (i < units.length) {
    let j = i + 1;
    while (j < units.length && fits(units[i]!, units[j]!)) j++;
    out.push({ start: units[i]!.start, end: units[j - 1]!.end });
    if (j >= units.length) break;
    i = j - i >= 2 && fits(units[j - 1]!, units[j]!) ? j - 1 : j;
  }
  return out;
}

export function chunkId(parts: {
  tokenizerKey: string;
  maxTokens: number;
  sourceNodeId: string;
  chunkIndex: number;
  start: number;
  end: number;
  text: string;
}): string {
  const key = JSON.stringify([
    CHUNKER_VERSION,
    parts.maxTokens,
    parts.tokenizerKey,
    parts.sourceNodeId,
    parts.chunkIndex,
    parts.start,
    parts.end,
    parts.text,
  ]);
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 32);
}

/** Chunks every message, in input order. Messages with no text produce no chunks. */
export function chunkMessages(messages: readonly MessageInput[], opts: ChunkerOptions): Chunk[] {
  const maxTokens = opts.maxTokens ?? DEFAULT_CHUNK_TOKENS;
  const out: Chunk[] = [];
  for (const m of messages) {
    chunkSpans(m.text, { countTokens: opts.countTokens, maxTokens }).forEach((s, chunkIndex) => {
      const text = m.text.slice(s.start, s.end);
      out.push({
        id: chunkId({ tokenizerKey: opts.tokenizerKey, maxTokens, sourceNodeId: m.sourceNodeId, chunkIndex, start: s.start, end: s.end, text }),
        sourceNodeId: m.sourceNodeId,
        chunkIndex,
        start: s.start,
        end: s.end,
        tokenCount: opts.countTokens(text),
        text,
      });
    });
  }
  return out;
}
