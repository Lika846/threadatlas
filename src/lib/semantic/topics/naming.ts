/**
 * Names for themes and topics (the atlas, `atlas.ts`). Server-only, pure, no dependencies.
 *
 * A group is named by the **words that are common in its conversations and rare elsewhere**,
 * in whatever languages its conversations use, so a topic of English, Norwegian and Russian
 * conversations about cats can be called "cat, katt, кошка". Words come from each
 * conversation's title and the text of its user messages (what the person asked about);
 * assistant text is left out, because it is long and generic ("here are some tips").
 *
 * - **Filler words are removed:** function words and chat filler in English, Norwegian and
 *   Russian (`STOPWORDS`), numbers, and words shorter than three letters.
 * - **Light normalisation** so that forms of one word count together: English plurals,
 *   Norwegian definite and plural endings (by the conversation's language), Russian case
 *   endings (`wordKey`). It is deliberately crude: it only decides what counts as the same
 *   word; the name shows the form that occurs most often.
 * - **Score:** the share of the group's conversations *in the word's language* that use it
 *   (weighted by the square root of that language's share of the group), times its inverse
 *   frequency across the archive (each conversation counts once). A word must occur in at
 *   least two of the group's conversations, with that weighted share at least `MIN_COVERAGE`.
 * - **Fallback:** when no word qualifies (small or very mixed groups), the title of the most
 *   typical conversation.
 *
 * Text passed in is read only to count words; nothing is logged or kept.
 */

import type { Lang } from "./lang.ts";

export const MAX_NAME_WORDS = 3;
/** A naming word must occur in at least this share of the group's conversations. */
export const MIN_COVERAGE = 0.2;

const EN =
  "a about above after again against all also am an and any are aren't as at be because been before being below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further get gets getting got had has have having he her here hers herself him himself his how i i'd i'll i'm i've if in into is isn't it it's its itself just let me more most my myself no nor not now of off on once only or other ought our ours out over own same she should shouldn't so some such than that that's the their theirs them themselves then there there's these they this those through to too under until up very was wasn't we were what what's when where which while who whom why will with won't would wouldn't you you'd you'll you're you've your yours yourself " +
  // Chat filler: requests, politeness, vague nouns and verbs that say nothing about a subject.
  "help please thanks thank hi hello hey ok okay yes yeah sure really actually maybe much many lot lots thing things stuff way ways something anything everything someone anyone " +
  "want wants need needs like know think make makes making use using used try trying tried give tell show explain write writing find best good better great new old first one two three four five " +
  "top question questions idea ideas tip tips advice guide example examples simple quick easy short long possible should could would chat untitled conversation still even every always never " +
  "since without within per via vs etc well right left time times day days year years month months today tomorrow yesterday";
const NO =
  "og i på til med for er det som en et ei å av at de den dei du han hun hen jeg meg min mitt mine din ditt dine sin sitt sine vi oss vår vårt våre dere deres seg selv " +
  "ikke om så men eller hvis når hvor hva hvem hvordan hvorfor hvilken hvilke hvilket kan kunne skal skulle vil ville må måtte bør burde blir ble blitt bli har hadde hatt være var vært " +
  "etter før fra over under mellom mot uten ved inn ut opp ned her der nå da også bare noe noen ingen alle alt mye mange mer mest litt få fikk gjør gjøre gjort " +
  "hjelp takk hei ja nei kanskje egentlig ting måte gang ganger dag dager uke uker år måned beste god bra ny nytt nye første tips råd spørsmål enkel enkelt lett lage bruke prøve trenger vet tror";
const RU =
  "и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее её мне было вот от меня еще ещё нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее неё сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между " +
  "это мне меня мой моя мои моё мое свой своя свои сколько почему какие каких какую каким которые который которая нужно нужен нужна хочу хочется помогите помоги подскажите скажите спасибо пожалуйста привет вопрос совет советы лучший лучшая просто очень можно ли чтобы делать сделать стоит стал стала стали день дня дней год года лет неделю";

/** Function words and chat filler, by surface form (lower case). */
export const STOPWORDS: ReadonlySet<string> = new Set(`${EN} ${NO} ${RU}`.split(/\s+/).filter((w) => w !== ""));

const CYRILLIC = /[Ѐ-ӿ]/;
const RU_ENDINGS = ["ями", "ами", "ого", "его", "ому", "ему", "ыми", "ими", "ость", "ой", "ей", "ий", "ый", "ая", "яя", "ое", "ее", "ые", "ие", "ов", "ев", "ам", "ям", "ах", "ях", "ом", "ем", "ую", "юю", "ть", "а", "я", "ы", "и", "у", "ю", "е", "о", "ь"];
const NO_ENDINGS = ["ene", "ane", "en", "et", "er", "ar", "a", "e"];

/**
 * What counts as the same word: Russian case endings (any Cyrillic word), Norwegian definite
 * and plural endings (in a Norwegian conversation, or a word with æ, ø or å), and English
 * plurals (otherwise) are stripped, keeping at least three letters of an English word and four
 * of the others. Crude by design.
 */
export function wordKey(word: string, lang: Lang | null = null): string {
  if (CYRILLIC.test(word)) {
    for (const e of RU_ENDINGS) if (word.length - e.length >= 4 && word.endsWith(e)) return word.slice(0, -e.length);
    return word;
  }
  if (lang === "no" || /[æøå]/.test(word)) {
    for (const e of NO_ENDINGS) if (word.length - e.length >= 4 && word.endsWith(e)) return word.slice(0, -e.length);
    return word;
  }
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith("s") && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

/** The naming words of one text: lower case, NFKC, letters only, no filler words. */
export function words(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.normalize("NFKC").toLowerCase().match(/\p{L}[\p{L}'’-]*\p{L}|\p{L}/gu) ?? []) {
    const w = raw.replace(/’/g, "'");
    if (w.length < 3 || STOPWORDS.has(w) || STOPWORDS.has(w.replace(/'s$/, ""))) continue;
    out.push(w);
  }
  return out;
}

/** One conversation: its title, its user messages' text, and its main language if known. */
export type NamingDoc = { title: string | null; text: string; lang?: Lang | null };
/** Per conversation: word key → its surface forms seen (counted). */
type DocWords = Map<string, Map<string, number>>;

function docWords(d: NamingDoc): DocWords {
  const out: DocWords = new Map();
  for (const w of words(`${d.title ?? ""}\n${d.text}`)) {
    const k = wordKey(w, d.lang ?? null);
    let forms = out.get(k);
    if (!forms) out.set(k, (forms = new Map()));
    forms.set(w, (forms.get(w) ?? 0) + 1);
  }
  return out;
}

export type Namer = {
  /** Up to `MAX_NAME_WORDS` naming words for a group (indices into the docs); empty when none qualifies. */
  name(members: readonly number[], exclude?: ReadonlySet<string>): { words: string[]; keys: string[] };
};

/** Prepares the archive's word statistics once; then names any group of its conversations. */
export function createNamer(docs: readonly NamingDoc[]): Namer {
  const perDoc = docs.map(docWords);
  const docLang = docs.map((d) => d.lang ?? "other");
  const df = new Map<string, number>();
  for (const d of perDoc) for (const k of d.keys()) df.set(k, (df.get(k) ?? 0) + 1);
  const n = Math.max(1, docs.length);
  return {
    name(members, exclude = new Set()) {
      const count = new Map<string, Map<string, number>>();
      const forms = new Map<string, Map<string, number>>();
      const langSize = new Map<string, number>();
      for (const i of members) {
        const lang = docLang[i]!;
        langSize.set(lang, (langSize.get(lang) ?? 0) + 1);
        for (const [k, fs] of perDoc[i]!) {
          let byLang = count.get(k);
          if (!byLang) count.set(k, (byLang = new Map()));
          byLang.set(lang, (byLang.get(lang) ?? 0) + 1);
          let all = forms.get(k);
          if (!all) forms.set(k, (all = new Map()));
          for (const [f, c] of fs) all.set(f, (all.get(f) ?? 0) + c);
        }
      }
      const size = Math.max(1, members.length);
      // Coverage is measured within the language that uses the word most, so a word only one
      // language's conversations can use ("katt") isn't diluted by the others; weighted by
      // that language's share of the group.
      const ranked = [...count]
        .filter(([k]) => !exclude.has(k))
        .map(([k, byLang]) => {
          let best = 0;
          let total = 0;
          for (const [lang, c] of byLang) {
            total += c;
            const share = langSize.get(lang)! / size;
            best = Math.max(best, (c / langSize.get(lang)!) * Math.sqrt(share));
          }
          return { k, total, best, s: best * Math.log(n / df.get(k)!) };
        })
        .filter((x) => x.total >= 2 && x.best >= MIN_COVERAGE && x.s > 0)
        .sort((a, b) => b.s - a.s || (a.k < b.k ? -1 : 1))
        .slice(0, MAX_NAME_WORDS);
      const surface = (k: string) => [...forms.get(k)!].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || (a[0] < b[0] ? -1 : 1))[0]![0];
      return { words: ranked.map((x) => surface(x.k)), keys: ranked.map((x) => x.k) };
    },
  };
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const isPlaceholder = (t: string) => /^new chat$/i.test(t);

/** Distinct real titles, most typical first (placeholders like "New chat" left out). */
export function typicalTitles(titles: readonly (string | null)[], count: number, length = 60): string[] {
  const picked: string[] = [];
  for (const raw of titles) {
    const t = (raw ?? "").replace(/\s+/g, " ").trim();
    if (t === "" || isPlaceholder(t) || picked.includes(t)) continue;
    picked.push(t);
    if (picked.length === count) break;
  }
  return picked.map((t) => truncate(t, length));
}

/** The display name from naming words ("Cat, katt, кошка"), or the fallback title. */
export function displayName(nameWords: readonly string[], fallbackTitles: readonly string[]): string {
  if (nameWords.length > 0) {
    const [first, ...rest] = nameWords;
    return [first!.charAt(0).toLocaleUpperCase() + first!.slice(1), ...rest].join(", ");
  }
  return fallbackTitles[0] ?? "Untitled conversations";
}
