import { describe, expect, it } from "vitest";
import { detectLanguage, MIN_WORDS_FOR_OTHER, resolveLanguages } from "./lang";

describe("detectLanguage (experimental topics)", () => {
  it.each([
    ["How can I fix the error in my build script?", "en"],
    ["Hvordan kan jeg få surdeigen til å heve bedre?", "no"],
    ["Почему кошки мурлычут, когда их гладят?", "ru"],
    ["Чому кіт не їсть сухий корм?", "ru"], // Ukrainian counts as "ru" (documented)
  ])("%s → %s", (text, lang) => {
    expect(detectLanguage(text)).toBe(lang);
  });

  it("reads å, æ and ø as Norwegian evidence", () => {
    expect(detectLanguage("Kjøkkenbenk på hytta")).toBe("no");
  });

  it("ties between English and Norwegian go to English", () => {
    expect(detectLanguage("the og")).toBe("en");
  });

  it("mixed text follows the majority", () => {
    expect(detectLanguage("Jeg har en feil i koden, og det skjer når jeg kjører: TypeError is not a function")).toBe("no");
    expect(detectLanguage("I get this error when I run the script: kunne ikke finne filen")).toBe("en");
  });

  it("returns null for text without letters or too short to tell", () => {
    expect(detectLanguage("")).toBeNull();
    expect(detectLanguage("   ")).toBeNull();
    expect(detectLanguage("12 + 30 = 42 👍")).toBeNull();
    expect(detectLanguage("ok thanks!")).toBeNull();
    expect(detectLanguage("Katten tisser utenfor kassen")).toBeNull(); // short, no function word

  });

  it("long text with no English or Norwegian function word is 'other' (another language, or code)", () => {
    const german = "Wie kann ich meine Steuererklärung schneller machen, welche Unterlagen brauche ich dafür eigentlich alle genau jetzt";
    expect(german.split(" ").length).toBeGreaterThanOrEqual(MIN_WORDS_FOR_OTHER);
    expect(detectLanguage(german)).toBe("other");
    const code = "const result = items.filter(item => item.active).map(item => item.value).reduce((sum, value) => sum + value, 0); console.log(result);";
    expect(detectLanguage(code)).toBe("other");
  });

  it("German that shares words with the English list can be read as English (documented limitation)", () => {
    expect(detectLanguage("Ich wohne in Berlin")).toBe("en");
  });
});

describe("resolveLanguages", () => {
  it("messages too short to tell take the conversation's main language", () => {
    expect(resolveLanguages([null, "no", "no", "en", null])).toEqual(["no", "no", "no", "en", "no"]);
  });

  it("ties go in the order en, no, ru, other", () => {
    expect(resolveLanguages(["ru", "no", null])).toEqual(["ru", "no", "no"]);
    expect(resolveLanguages(["other", "ru", null])).toEqual(["other", "ru", "ru"]);
  });

  it("nothing detected → other", () => {
    expect(resolveLanguages([null, null])).toEqual(["other", "other"]);
    expect(resolveLanguages([])).toEqual([]);
  });
});
