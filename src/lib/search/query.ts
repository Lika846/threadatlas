/**
 * Search query parsing (M2.2; A93–A94; design in `docs/import-format.md`,
 * *Search queries*). Pure: no database, no logging.
 *
 * The user never writes FTS5 syntax. The input is read as:
 * - ordinary words, separated by whitespace;
 * - "quoted phrases" (an unbalanced quote is ignored, so the words are plain);
 * - a trailing `*` on the LAST unquoted word: "starts with" (at least
 *   `MIN_PREFIX_CHARS` letters or digits before it).
 * Every term must match (implicit AND). Each term becomes one FTS5 string,
 * `"..."` with any `"` doubled, so FTS5 operators and special characters
 * (AND, OR, NOT, NEAR, column filters, ^, +, -, parentheses, `*` elsewhere)
 * are only ever searched as words. FTS5's tokenizer then splits a term at
 * punctuation: `C++` searches the word `c`, `alice@example.com` the phrase
 * `alice example com`.
 *
 * Nothing meaningful is dropped silently: input over the length or term
 * limit is rejected with a typed reason. Only characters that can never be
 * searched are removed: control characters (read as spaces), `"` (phrase
 * delimiters), and terms without any letter or digit (punctuation or emoji
 * alone, which the tokenizer would ignore anyway).
 */

/** Maximum query length in Unicode code points, after trimming surrounding whitespace. */
export const MAX_QUERY_CHARS = 256;
/** Maximum number of terms (words and phrases). */
export const MAX_QUERY_TERMS = 16;
/** Minimum letters or digits before a trailing `*`. */
export const MIN_PREFIX_CHARS = 2;

export type QueryTerm = {
  /** The term as searched (normalised, quotes and trailing `*` removed). */
  text: string;
  phrase: boolean;
  prefix: boolean;
};

export type QueryRejection =
  | { reason: "empty" }
  /** Input present, but no word with a letter or digit. */
  | { reason: "no_terms" }
  | { reason: "too_long"; limit: number; length: number }
  | { reason: "too_many_terms"; limit: number; terms: number }
  | { reason: "prefix_too_short"; minimum: number };

export type ParsedQuery = { ok: true; fts: string; terms: QueryTerm[] } | { ok: false; rejection: QueryRejection };

const SEARCHABLE = /[\p{L}\p{N}]/u;
const SEARCHABLE_G = /[\p{L}\p{N}]/gu;
// C0 and C1 control characters (tab and newline included; they separate terms).
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
/** A quoted phrase (closing quote required) or a run of non-whitespace. */
const TOKEN = /"([^"]*)"|(\S+)/gu;

const codePoints = (s: string) => Array.from(s).length;

/**
 * A search by meaning (M5.2): the text as typed, trimmed, control characters read as
 * spaces. Same length limit as keyword search and at least one letter or digit; no term
 * syntax (quotes and `*` are just characters to the model).
 */
export function parseMeaningQuery(input: unknown): { ok: true; text: string } | { ok: false; rejection: QueryRejection } {
  if (typeof input !== "string") return { ok: false, rejection: { reason: "empty" } };
  const text = input.replace(CONTROL, " ").trim();
  if (text === "") return { ok: false, rejection: { reason: "empty" } };
  const length = codePoints(text);
  if (length > MAX_QUERY_CHARS) return { ok: false, rejection: { reason: "too_long", limit: MAX_QUERY_CHARS, length } };
  if (!SEARCHABLE.test(text)) return { ok: false, rejection: { reason: "no_terms" } };
  return { ok: true, text };
}

export function parseSearchQuery(input: unknown): ParsedQuery {
  if (typeof input !== "string") return { ok: false, rejection: { reason: "empty" } };
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, rejection: { reason: "empty" } };
  const length = codePoints(trimmed);
  if (length > MAX_QUERY_CHARS) return { ok: false, rejection: { reason: "too_long", limit: MAX_QUERY_CHARS, length } };

  const text = trimmed.normalize("NFKC").replace(CONTROL, " ");
  const raw: { text: string; phrase: boolean }[] = [];
  for (const m of text.matchAll(TOKEN)) {
    if (m[1] !== undefined) raw.push({ text: m[1], phrase: true });
    else raw.push({ text: m[2]!, phrase: false });
  }
  const candidates = raw
    .map((p) => ({ phrase: p.phrase, text: p.text.replace(/"/g, " ").replace(/\s+/g, " ").trim() }))
    .filter((p) => SEARCHABLE.test(p.text));
  if (candidates.length === 0) return { ok: false, rejection: { reason: "no_terms" } };
  if (candidates.length > MAX_QUERY_TERMS) return { ok: false, rejection: { reason: "too_many_terms", limit: MAX_QUERY_TERMS, terms: candidates.length } };

  const terms: QueryTerm[] = candidates.map((p, i) => {
    const last = i === candidates.length - 1;
    if (!last || p.phrase || !p.text.endsWith("*")) return { text: p.text, phrase: p.phrase, prefix: false };
    return { text: p.text.replace(/\*+$/, ""), phrase: false, prefix: true };
  });
  const lastTerm = terms[terms.length - 1]!;
  if (lastTerm.prefix && (lastTerm.text.match(SEARCHABLE_G)?.length ?? 0) < MIN_PREFIX_CHARS) {
    return { ok: false, rejection: { reason: "prefix_too_short", minimum: MIN_PREFIX_CHARS } };
  }
  const fts = terms.map((t) => `"${t.text.replace(/"/g, '""')}"${t.prefix ? "*" : ""}`).join(" ");
  return { ok: true, fts, terms };
}
