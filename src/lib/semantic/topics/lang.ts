/**
 * Message language for the experimental topic grouping (`tree-map.ts`). Server-only, pure.
 *
 * Only what the grouping needs: e5 vectors carry a strong language signal, so conversations
 * in one language cluster together before conversations on one subject do (mind-map spikes
 * v1 and v2, `docs/spikes/mindmap/`). The grouping removes each language's average vector;
 * this module says which language a message is in.
 *
 * A stopword count, as frozen in the spikes (1,406 of 1,414 synthetic messages right):
 * - more than 30% Cyrillic letters → "ru" (so Ukrainian, Bulgarian and others count as "ru");
 * - otherwise English against Norwegian function words (å/æ/ø count for Norwegian);
 * - neither: "other" for a message of at least `MIN_WORDS_FOR_OTHER` words (another
 *   language, or code), else too short to tell (`null`), and the message takes its
 *   conversation's main language (`resolveLanguages`).
 * German, Spanish and other languages sharing words with the English list ("in", "is") can
 * be read as English. Messages are never logged or stored here.
 */

export type Lang = "en" | "no" | "ru" | "other";

const NO_WORDS = new Set("og ikke jeg det er på til med som har vi du kan hva hvordan å av den om så min må skal vil bør når eller fra hvis meg hun han oss deg også bare noe etter".split(" "));
const EN_WORDS = new Set("the and is to of in it you that with my what how can on this be are your do if or from should when not have will about".split(" "));

/** A message this long with no English or Norwegian function word is "other", not "too short to tell". */
export const MIN_WORDS_FOR_OTHER = 12;

/** The message's language, or null when it is too short (or has no letters) to tell. */
export function detectLanguage(text: string): Lang | null {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return null;
  const cyrillic = letters.filter((c) => /[Ѐ-ӿ]/.test(c)).length;
  if (cyrillic / letters.length > 0.3) return "ru";
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  let no = /[æøå]/i.test(text) ? 2 : 0;
  let en = 0;
  for (const w of words) {
    if (NO_WORDS.has(w)) no++;
    if (EN_WORDS.has(w)) en++;
  }
  if (no > en) return "no";
  if (en > 0) return "en";
  return words.length >= MIN_WORDS_FOR_OTHER ? "other" : null;
}

const ORDER: readonly Lang[] = ["en", "no", "ru", "other"];

/**
 * One conversation's messages: a message too short to tell takes the conversation's most
 * common detected language (ties in the order en, no, ru, other); "other" when none is known.
 */
export function resolveLanguages(detected: readonly (Lang | null)[]): Lang[] {
  const counts = new Map<Lang, number>();
  for (const l of detected) if (l !== null) counts.set(l, (counts.get(l) ?? 0) + 1);
  let main: Lang = "other";
  let best = 0;
  for (const l of ORDER) {
    const c = counts.get(l) ?? 0;
    if (c > best) {
      best = c;
      main = l;
    }
  }
  return detected.map((l) => l ?? main);
}
