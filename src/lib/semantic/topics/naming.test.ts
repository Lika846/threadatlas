import { describe, expect, it } from "vitest";
import { createNamer, displayName, STOPWORDS, typicalTitles, wordKey, words, type NamingDoc } from "./naming";

describe("words (filler removal)", () => {
  it("drops function words and chat filler in English, Norwegian and Russian", () => {
    expect(words("How can I make my sourdough starter more active? Thanks!")).toEqual(["sourdough", "starter", "active"]);
    expect(words("Hvordan kan jeg få katten til å bruke kassen etter flyttingen?")).toEqual(["katten", "kassen", "flyttingen"]);
    expect(words("Как при этом сколько нужно белка для роста мышц?")).toEqual(["белка", "роста", "мышц"]);
  });

  it("regresses the k-means labels seen in the UI review: none of these is a naming word", () => {
    for (const w of ["как", "при", "сколько", "для", "etter", "hvem", "blir", "the", "how", "new"]) expect(STOPWORDS.has(w)).toBe(true);
    for (const w of ["work", "weekend", "drikke", "eksamen"]) expect(STOPWORDS.has(w)).toBe(false);
  });

  it("ignores numbers, short words and punctuation, and folds case and compatibility forms", () => {
    expect(words("Top 10 tips: CSV → JSON in 2 min, ok?")).toEqual(["csv", "json"]);
    expect(words("ＰＹＴＨＯＮ pandas")).toEqual(["python", "pandas"]);
  });
});

describe("wordKey", () => {
  it("counts forms of one word together", () => {
    expect(wordKey("cats")).toBe(wordKey("cat"));
    expect(wordKey("recipes")).toBe(wordKey("recipe"));
    expect(wordKey("batteries")).toBe("battery");
    expect(wordKey("katten", "no")).toBe(wordKey("katt", "no"));
    expect(wordKey("kassene", "no")).toBe(wordKey("kasse", "no"));
    expect(wordKey("кошки")).toBe(wordKey("кошка"));
    expect(wordKey("кошку")).toBe(wordKey("кошка"));
  });

  it("leaves words alone that only look inflected", () => {
    expect(wordKey("glass")).toBe("glass");
    expect(wordKey("virus")).toBe("virus");
    expect(wordKey("bus")).toBe("bus");
    expect(wordKey("kode")).toBe("kode"); // too short to strip
  });
});

describe("createNamer", () => {
  const doc = (title: string, text = "", lang: NamingDoc["lang"] = "en"): NamingDoc => ({ title, text, lang });
  const docs = [
    doc("Sourdough starter is sluggish", "my sourdough starter barely rises"),
    doc("Sourdough crumb too dense"),
    doc("Rye sourdough loaf"),
    doc("Katten tisser utenfor kassen", "katten min", "no"),
    doc("Ny katt i huset", "to katter", "no"),
    doc("Почему кошка мурлычет", "", "ru"),
    doc("Кошка не ест", "", "ru"),
    doc("Introducing a second cat", "the cats fight"),
    doc("Budget spreadsheet"),
    doc("Tax return deadline"),
  ];
  const namer = createNamer(docs);

  it("names a group by words common in it and rare elsewhere", () => {
    expect(namer.name([0, 1, 2]).words[0]).toBe("sourdough");
  });

  it("finds words in each language of a multilingual group, by coverage within that language", () => {
    const { words: w } = namer.name([3, 4, 5, 6, 7]);
    expect(w).toEqual(expect.arrayContaining(["кошка"]));
    expect(w.some((x) => x.startsWith("katt"))).toBe(true);
    expect(w).not.toContain("cat"); // only one English conversation uses it
  });

  it("needs a word in at least two of the group's conversations; otherwise no words", () => {
    expect(namer.name([8, 9]).words).toEqual([]);
  });

  it("can exclude words (by key)", () => {
    const first = namer.name([0, 1, 2]);
    expect(namer.name([0, 1, 2], new Set(first.keys)).words).not.toContain("sourdough");
  });
});

describe("typicalTitles and displayName", () => {
  it("skips placeholders and repeats, and truncates", () => {
    expect(typicalTitles(["New chat", null, "  A   title ", "A title", "Second"], 2)).toEqual(["A title", "Second"]);
    expect(typicalTitles(["x".repeat(80)], 1, 20)[0]).toHaveLength(20);
  });

  it("capitalises the first word, or falls back to a title", () => {
    expect(displayName(["cat", "katt", "кошка"], [])).toBe("Cat, katt, кошка");
    expect(displayName([], ["Introducing a second cat"])).toBe("Introducing a second cat");
    expect(displayName([], [])).toBe("Untitled conversations");
  });
});
