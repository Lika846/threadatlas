import { randomBytes } from "node:crypto";

/**
 * Snippet and title highlighting (M2.2; A97). Pure apart from the random
 * marker value.
 *
 * FTS5's `snippet()` and `highlight()` wrap each match in caller-chosen
 * marker strings. The markers here are private-use characters plus a 128-bit
 * random value created per search, so imported text cannot contain them
 * (even text that contains private-use characters). The marked text is
 * parsed into plain `{ text, match }` segments: the UI renders them as text
 * and `<mark>`, never as HTML. If the markers are not well formed (an
 * unmatched, nested or empty match), the whole snippet falls back to plain
 * text with every marker removed.
 *
 * Segments are capped, because a single "word" in imported text can be
 * arbitrarily long: context before the first match keeps its end, context
 * after the last match keeps its start, context between matches keeps both
 * ends, and a match keeps its start; each cut is shown as "…". Cuts never
 * split a character (code points, not UTF-16 units).
 */

export type SnippetSegment = { text: string; match: boolean };

export type SnippetMarkers = { start: string; end: string; ellipsis: string };

export const ELLIPSIS = "…";
/** Longest context segment kept (code points, before the "…"). */
export const MAX_CONTEXT_CHARS = 120;
/** Longest match segment kept (code points, before the "…"). */
export const MAX_MATCH_CHARS = 80;

export function createMarkers(): SnippetMarkers {
  const nonce = randomBytes(16).toString("hex");
  return { start: `${nonce}`, end: `${nonce}`, ellipsis: `${nonce}` };
}

function removeMarkers(s: string, m: SnippetMarkers): string {
  return s.split(m.start).join("").split(m.end).join("").split(m.ellipsis).join(ELLIPSIS);
}

/** Splits marked text into segments; null when the markers are not well formed. */
function split(s: string, m: SnippetMarkers): SnippetSegment[] | null {
  const out: SnippetSegment[] = [];
  let rest = s;
  while (rest.length > 0) {
    const a = rest.indexOf(m.start);
    const stray = rest.indexOf(m.end);
    if (a < 0) {
      if (stray >= 0) return null; // end marker without a start
      out.push({ text: rest, match: false });
      break;
    }
    if (stray >= 0 && stray < a) return null;
    if (a > 0) out.push({ text: rest.slice(0, a), match: false });
    const afterStart = rest.slice(a + m.start.length);
    const b = afterStart.indexOf(m.end);
    if (b < 0) return null; // start marker without an end
    const matched = afterStart.slice(0, b);
    if (matched.length === 0 || matched.includes(m.start)) return null; // empty or nested
    out.push({ text: matched, match: true });
    rest = afterStart.slice(b + m.end.length);
  }
  return out;
}

const cps = (s: string) => Array.from(s);

function capContext(text: string, where: "first" | "middle" | "last"): string {
  const c = cps(text);
  if (c.length <= MAX_CONTEXT_CHARS) return text;
  if (where === "first") return ELLIPSIS + c.slice(-MAX_CONTEXT_CHARS).join("");
  if (where === "last") return c.slice(0, MAX_CONTEXT_CHARS).join("") + ELLIPSIS;
  const half = MAX_CONTEXT_CHARS / 2;
  return c.slice(0, half).join("") + ELLIPSIS + c.slice(-half).join("");
}

function cap(segments: SnippetSegment[]): SnippetSegment[] {
  const firstMatch = segments.findIndex((s) => s.match);
  const lastMatch = segments.findLastIndex((s) => s.match);
  return segments.map((s, i) => {
    if (s.match) {
      const c = cps(s.text);
      return c.length <= MAX_MATCH_CHARS ? s : { text: c.slice(0, MAX_MATCH_CHARS).join("") + ELLIPSIS, match: true };
    }
    // No match at all: one plain segment, treated like trailing context.
    const where = firstMatch < 0 ? "last" : i < firstMatch ? "first" : i > lastMatch ? "last" : "middle";
    return { text: capContext(s.text, where), match: false };
  });
}

/** Merges adjacent segments of the same kind and drops empty ones. */
function tidy(segments: SnippetSegment[]): SnippetSegment[] {
  const out: SnippetSegment[] = [];
  for (const s of segments) {
    if (s.text.length === 0) continue;
    const prev = out[out.length - 1];
    if (prev && prev.match === s.match) prev.text += s.text;
    else out.push({ ...s });
  }
  return out;
}

/**
 * Parses text marked by FTS5 with `markers` into capped segments. Unexpected
 * marker structure gives one plain-text segment (markers removed).
 */
export function parseMarkedText(marked: string, markers: SnippetMarkers): SnippetSegment[] {
  const withEllipsis = marked.split(markers.ellipsis).join(ELLIPSIS);
  const parsed = split(withEllipsis, markers);
  const segments = parsed ?? [{ text: removeMarkers(withEllipsis, markers), match: false }];
  return tidy(cap(tidy(segments)));
}
