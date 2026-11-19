/**
 * A small, safe Markdown parser for imported assistant messages (phase 3). Pure; produces a tree
 * that `src/components/markdown.tsx` renders as React elements.
 *
 * **Safety by construction:**
 * - **No HTML.** Tags in a message stay text, and React escapes them when rendering.
 * - **Links only to absolute `http:`, `https:` or `mailto:` URLs** (`safeHref`). Anything else
 *   (`javascript:`, `data:`, `file:`, relative or protocol-relative URLs, control characters)
 *   is shown as plain text, never as a link. A relative link would otherwise point inside the
 *   app.
 * - **Images are never loaded:** `![alt](url)` becomes a text placeholder, so a message can't
 *   make the browser fetch anything.
 * - **Bounded work:** messages over `MAX_MARKDOWN_CHARS` are left to the plain-text view
 *   (`parseMarkdown` returns null) and nesting deeper than `MAX_DEPTH` stays text. Every scan is
 *   linear in the text (brackets matched in one pass, failed emphasis searches remembered, link
 *   destinations and titles capped and ended by a bracket, no regular expression that can backtrack over a
 *   long run), so a crafted message can't stall the server: `parse.test.ts` times the worst
 *   inputs found.
 *
 * **Supported** (what chat assistants write): ATX headings; paragraphs (a single newline is a
 * line break, as in chat); fenced code blocks with a language; bullet and numbered lists, nested
 * by indentation; block quotes; horizontal rules; pipe tables; inline code, bold, italic,
 * strikethrough, links, `<autolinks>` and bare http(s) URLs. A link's text can't contain another
 * link (nested links are invalid HTML): the inner one stays text. Not supported (left as text):
 * raw HTML, HTML entities (`&amp;` is shown as typed), reference links, footnotes, task-list
 * checkboxes, maths, setext headings, indented code blocks.
 */

export const MAX_MARKDOWN_CHARS = 100_000;
export const MAX_DEPTH = 8;
/** Longest link destination looked for; a longer one leaves the text as it is. */
export const MAX_URL_CHARS = 2048;
/** Longest link title looked for (titles are ignored, but must be skipped). */
const MAX_TITLE_CHARS = 256;

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong" | "em" | "del"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] }
  | { type: "image"; alt: string }
  | { type: "br" };

export type Align = "left" | "center" | "right" | null;
export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "heading"; level: number; children: Inline[] }
  | { type: "code"; lang: string | null; text: string }
  | { type: "list"; ordered: boolean; start: number; items: Block[][] }
  | { type: "blockquote"; children: Block[] }
  | { type: "hr" }
  | { type: "table"; align: Align[]; header: Inline[][]; rows: Inline[][][] };

// ------------------------------------------------------------------------------ URLs

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** True when any character is whitespace, a C0/C1 control or a Unicode line/paragraph separator. */
function hasControlOrSpace(s: string): boolean {
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c <= 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || c === 0xa0 || c === 0xfeff) return true;
  }
  return false;
}

/**
 * The URL a link may point to, or null. Only absolute http(s) and mailto URLs, checked by the
 * URL parser after removing nothing: a value with whitespace or control characters anywhere is
 * refused (browsers strip some of them, which is how `java\tscript:` tricks work).
 */
export function safeHref(raw: string): string | null {
  const value = raw.trim();
  if (value === "" || hasControlOrSpace(value)) return null;
  let url: URL;
  try {
    url = new URL(value); // no base: relative and protocol-relative URLs throw
  } catch {
    return null;
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return null;
  if ((url.protocol === "http:" || url.protocol === "https:") && url.hostname === "") return null;
  return url.href;
}

// ------------------------------------------------------------------------------ inline

/** Characters a backslash can escape (CommonMark's ASCII punctuation). */
const ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

function pushText(out: Inline[], text: string) {
  if (text === "") return;
  const last = out[out.length - 1];
  if (last?.type === "text") last.text += text;
  else out.push({ type: "text", text });
}

/** The length of the run of `c` starting at `i`. */
function runLength(s: string, i: number, c: string): number {
  let n = 0;
  while (s[i + n] === c) n++;
  return n;
}

/**
 * The closing `]` of every `[` (-1 when unmatched), in one pass: nesting and escapes honoured,
 * brackets inside code spans ignored.
 */
function matchBrackets(s: string): Int32Array {
  const close = new Int32Array(s.length).fill(-1);
  const open: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") i++;
    else if (c === "`") {
      const run = runLength(s, i, "`");
      const end = s.indexOf("`".repeat(run), i + run);
      i = (end < 0 ? i + run : end + run) - 1;
    } else if (c === "[") open.push(i);
    else if (c === "]" && open.length > 0) close[open.pop()!] = i;
  }
  return close;
}

/** A link destination right after `](`: `(url)` or `(url "title")`; returns the URL and the end index. */
function destination(s: string, at: number): { url: string; end: number } | null {
  if (s[at] !== "(") return null;
  let i = at + 1;
  const limit = Math.min(s.length, i + MAX_URL_CHARS);
  let url = "";
  if (s[i] === "<") {
    let close = -1;
    for (let k = i + 1; k < limit && s[k] !== "\n" && s[k] !== "<"; k++) {
      if (s[k] === ">") {
        close = k;
        break;
      }
    }
    if (close < 0) return null;
    url = s.slice(i + 1, close);
    i = close + 1;
  } else {
    let depth = 0;
    const start = i;
    for (; i < limit; i++) {
      const c = s[i]!;
      if (c === "\\") i++;
      else if (c === "(") depth++;
      else if (c === ")") {
        if (depth === 0) break;
        depth--;
      } else if (c === "[" || c === "]") return null; // not in a bare destination; keeps scans short
      else if (/\s/.test(c)) break;
    }
    if (i === limit && limit < s.length) return null; // too long to be a link
    url = s.slice(start, i);
  }
  // An optional title, ignored; scanned by hand (a regular expression would backtrack).
  const end = Math.min(s.length, i + MAX_TITLE_CHARS);
  const space = (k: number) => k < end && /\s/.test(s[k]!);
  while (space(i)) i++;
  const quote = s[i] === '"' || s[i] === "'" ? s[i] : s[i] === "(" ? ")" : null;
  if (quote) {
    let k = i + 1;
    while (k < end && s[k] !== quote) k++;
    if (k >= end) return null;
    i = k + 1;
    while (space(i)) i++;
  }
  if (s[i] !== ")") return null;
  return { url, end: i + 1 };
}

const BARE_URL = /^https?:\/\/[^\s<>()[\]"'`]*[^\s<>()[\]"'`.,;:!?*_~]/;

/**
 * Parses inline Markdown. Emphasis uses `*`/`_` runs matched to the nearest closer of the same
 * kind. Inside a link's text (`inLink`) links, autolinks and bare URLs stay text.
 */
export function parseInline(s: string, depth = 0, inLink = false): Inline[] {
  const out: Inline[] = [];
  if (depth > MAX_DEPTH) {
    pushText(out, s);
    return out;
  }
  const bracket = matchBrackets(s);
  // Per marker: a search from `from` found no closer before `stop`. Whether a position closes
  // depends only on the position, so a later opener inside that range has none either.
  const noCloser = new Map<string, { from: number; stop: number }>();
  let i = 0;
  let text = "";
  const flush = () => {
    pushText(out, text);
    text = "";
  };
  while (i < s.length) {
    const c = s[i]!;
    if (c === "\\" && i + 1 < s.length) {
      if (s[i + 1] === "\n") {
        flush();
        out.push({ type: "br" });
        i += 2;
        continue;
      }
      if (ESCAPABLE.test(s[i + 1]!)) {
        text += s[i + 1];
        i += 2;
        continue;
      }
    }
    if (c === "\n") {
      flush();
      out.push({ type: "br" });
      i++;
      continue;
    }
    if (c === "`") {
      const run = "`".repeat(runLength(s, i, "`"));
      const end = s.indexOf(run, i + run.length);
      if (end > 0) {
        flush();
        let code = s.slice(i + run.length, end).replace(/\n/g, " ");
        if (/^ .* $/.test(code) && code.trim() !== "") code = code.slice(1, -1);
        out.push({ type: "code", text: code });
        i = end + run.length;
        continue;
      }
      text += run;
      i += run.length;
      continue;
    }
    if (c === "!" && s[i + 1] === "[") {
      const close = bracket[i + 1]!;
      const dest = close > 0 ? destination(s, close + 1) : null;
      if (dest) {
        flush();
        out.push({ type: "image", alt: s.slice(i + 2, close) });
        i = dest.end;
        continue;
      }
    }
    if (c === "[") {
      const close = bracket[i]!;
      const dest = close > 0 ? destination(s, close + 1) : null;
      if (dest) {
        flush();
        const label = parseInline(s.slice(i + 1, close), depth + 1, true);
        const href = inLink ? null : safeHref(dest.url);
        if (href) out.push({ type: "link", href, children: label });
        else for (const x of label) out.push(x); // an unsafe or relative URL: its text only
        i = dest.end;
        continue;
      }
    }
    if (c === "<") {
      const auto = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)>/.exec(s.slice(i));
      if (auto) {
        const href = inLink ? null : safeHref(auto[1]!);
        flush();
        if (href) out.push({ type: "link", href, children: [{ type: "text", text: auto[1]! }] });
        else pushText(out, auto[0]);
        i += auto[0].length;
        continue;
      }
    }
    if (!inLink && (c === "h" || c === "H") && (i === 0 || /[\s(]/.test(s[i - 1]!))) {
      const bare = BARE_URL.exec(s.slice(i));
      if (bare) {
        const href = safeHref(bare[0]);
        if (href) {
          flush();
          out.push({ type: "link", href, children: [{ type: "text", text: bare[0] }] });
          i += bare[0].length;
          continue;
        }
      }
    }
    if (c === "~" && s[i + 1] === "~") {
      const end = s.indexOf("~~", i + 2);
      if (end > i + 2 && !/\s/.test(s[i + 2]!) && !/\s/.test(s[end - 1]!)) {
        flush();
        out.push({ type: "del", children: parseInline(s.slice(i + 2, end), depth + 1, inLink) });
        i = end + 2;
        continue;
      }
    }
    if (c === "*" || c === "_") {
      const strong = s[i + 1] === c;
      const marker = strong ? c + c : c;
      const inner = i + marker.length;
      // Opens only before non-space; `_` only at a word boundary (snake_case stays text).
      const opens = inner < s.length && !/\s/.test(s[inner]!) && (c === "*" || i === 0 || !/[\p{L}\p{N}]/u.test(s[i - 1]!));
      const known = noCloser.get(marker);
      if (opens && !(known && inner >= known.from && inner < known.stop)) {
        let end = -1;
        let j = inner + 1;
        for (; j <= s.length - marker.length; j++) {
          if (s[j] === "\n" && s[j + 1] === "\n") break;
          // A single marker never closes inside a double one (`*a **b** c*`).
          const single = strong || (s[j + 1] !== c && s[j - 1] !== c);
          if (s.startsWith(marker, j) && !/\s/.test(s[j - 1]!) && single && (c === "*" || j + 1 >= s.length || !/[\p{L}\p{N}]/u.test(s[j + marker.length] ?? ""))) {
            end = j;
            break;
          }
        }
        if (end < 0) noCloser.set(marker, { from: inner, stop: j });
        // `***x***`: bold around italic, the closer taken from the end of the run.
        if (end > 0 && strong && s[inner] === c && s[end + 2] === c) end++;
        if (end > 0) {
          flush();
          out.push({ type: strong ? "strong" : "em", children: parseInline(s.slice(inner, end), depth + 1, inLink) });
          i = end + marker.length;
          continue;
        }
      }
    }
    text += c;
    i++;
  }
  flush();
  return out;
}

// ------------------------------------------------------------------------------ blocks

const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const BULLET = /^( *)([-*+])[ \t]+(.*)$/;
const ORDERED = /^( *)(\d{1,9})[.)][ \t]+(.*)$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;

const blank = (l: string) => l.trim() === "";
const indentOf = (l: string) => /^ */.exec(l.replace(/\t/g, "    "))![0].length;

/** An opening code fence: its marker and language, or null. Backtick fences allow no backtick after. */
function fenceOf(line: string): { marker: string; lang: string | null } | null {
  const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (!m) return null;
  const info = line.slice(m[0].length);
  if (m[1]![0] === "`" && info.includes("`")) return null;
  const lang = info.trim().split(/[ \t]/, 1)[0]!;
  return { marker: m[1]!, lang: lang ? lang.slice(0, 40) : null };
}

/** An ATX heading: its level and text (without a closing run of `#`), or null. */
function headingOf(line: string): { level: number; text: string } | null {
  const m = /^ {0,3}(#{1,6})(?=[ \t]|$)/.exec(line);
  if (!m) return null;
  let text = line.slice(m[0].length).trim();
  let k = text.length;
  while (k > 0 && text[k - 1] === "#") k--;
  if (k < text.length && (k === 0 || text[k - 1] === " " || text[k - 1] === "\t")) text = text.slice(0, k).trimEnd();
  return { level: m[1]!.length, text };
}

/** A table's delimiter row: cells of hyphens with optional alignment colons. */
function isDelimiterRow(line: string): boolean {
  if (!line.includes("-")) return false;
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").every((cell) => /^:?-+:?$/.test(cell.trim()));
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let code = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (c === "`") {
      code = !code;
      cur += c;
    } else if (c === "|" && !code) {
      cells.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function startsBlock(line: string): boolean {
  return fenceOf(line) !== null || headingOf(line) !== null || HR.test(line) || QUOTE.test(line) || BULLET.test(line) || ORDERED.test(line);
}

/** True when lines `i` and `i + 1` open a pipe table (a header row and a matching delimiter row). */
function startsTable(lines: readonly string[], i: number): boolean {
  const line = lines[i]!;
  const next = lines[i + 1];
  return line.includes("|") && next !== undefined && isDelimiterRow(next) && splitRow(line).length === splitRow(next).length;
}

function parseBlocks(lines: readonly string[], depth: number): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const fence = fenceOf(line);
    if (fence) {
      const closing = new RegExp(`^ {0,3}${fence.marker[0] === "`" ? "`" : "~"}{${fence.marker.length},}[ \\t]*$`);
      const indent = new RegExp(`^ {0,${indentOf(line)}}`);
      const body: string[] = [];
      i++;
      while (i < lines.length && !closing.test(lines[i]!)) {
        body.push(lines[i]!.replace(indent, ""));
        i++;
      }
      i++; // the closing fence (or the end)
      out.push({ type: "code", lang: fence.lang, text: body.join("\n") });
      continue;
    }
    const heading = headingOf(line);
    if (heading) {
      out.push({ type: "heading", level: heading.level, children: parseInline(heading.text) });
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push({ type: "hr" });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && !blank(lines[i]!)) {
        const q = QUOTE.exec(lines[i]!);
        inner.push(q ? q[1]! : lines[i]!);
        i++;
      }
      out.push(depth >= MAX_DEPTH ? { type: "paragraph", children: [{ type: "text", text: inner.join("\n") }] } : { type: "blockquote", children: parseBlocks(inner, depth + 1) });
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    if (bullet || ordered) {
      const isOrdered = ordered !== null;
      const base = indentOf(line);
      const items: string[][] = [];
      const itemIndent = new RegExp(`^ {0,${base + 4}}`);
      let start = isOrdered ? Number(ordered![2]) : 1;
      while (i < lines.length) {
        const l = lines[i]!;
        const m = isOrdered ? ORDERED.exec(l) : BULLET.exec(l);
        if (m && indentOf(l) === base) {
          items.push([m[3]!]);
          i++;
          continue;
        }
        if (blank(l)) {
          // A blank line continues the list only if the next line belongs to it.
          const next = lines[i + 1];
          if (next !== undefined && (indentOf(next) > base || (isOrdered ? ORDERED : BULLET).exec(next)?.[1]?.length === base)) {
            items[items.length - 1]!.push("");
            i++;
            continue;
          }
          break;
        }
        if (indentOf(l) > base) {
          items[items.length - 1]!.push(l.replace(itemIndent, ""));
          i++;
          continue;
        }
        if (!startsBlock(l) && items.length > 0) {
          items[items.length - 1]!.push(l.trim()); // a lazy continuation of the item's text
          i++;
          continue;
        }
        break;
      }
      if (!Number.isSafeInteger(start)) start = 1;
      out.push({
        type: "list",
        ordered: isOrdered,
        start,
        items: items.map((it) => (depth >= MAX_DEPTH ? [{ type: "paragraph", children: [{ type: "text", text: it.join("\n") }] } as Block] : parseBlocks(it, depth + 1))),
      });
      continue;
    }
    // A pipe table: a header row, a delimiter row, then rows.
    if (startsTable(lines, i)) {
      const header = splitRow(line);
      const delims = splitRow(lines[i + 1]!);
      {
        const align: Align[] = delims.map((d) => (d.startsWith(":") && d.endsWith(":") ? "center" : d.endsWith(":") ? "right" : d.startsWith(":") ? "left" : null));
        i += 2;
        const rows: Inline[][][] = [];
        while (i < lines.length && !blank(lines[i]!) && lines[i]!.includes("|")) {
          const cells = splitRow(lines[i]!);
          rows.push(header.map((_, k) => parseInline(cells[k] ?? "")));
          i++;
        }
        out.push({ type: "table", align, header: header.map((h) => parseInline(h)), rows });
        continue;
      }
    }
    // A paragraph: until a blank line or the start of another block (a table included). Trailing
    // spaces (a Markdown hard break) don't matter: every line break is kept.
    const para: string[] = [];
    while (i < lines.length && !blank(lines[i]!) && (para.length === 0 || (!startsBlock(lines[i]!) && !startsTable(lines, i)))) {
      para.push(lines[i]!.replace(/^ {0,3}/, "").trimEnd());
      i++;
    }
    out.push({ type: "paragraph", children: parseInline(para.join("\n")) });
  }
  return out;
}

/** The blocks of a message, or null when it is too long to render as Markdown (shown as text). */
export function parseMarkdown(text: string): Block[] | null {
  if (text.length > MAX_MARKDOWN_CHARS) return null;
  return parseBlocks(text.replace(/\r\n?/g, "\n").split("\n"), 0);
}
