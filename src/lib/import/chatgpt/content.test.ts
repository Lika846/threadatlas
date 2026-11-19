import { describe, expect, it } from "vitest";
import { displayTypeName, extractContent } from "./content";

describe("extractContent: supported types", () => {
  it("joins text parts with a blank line", () => {
    expect(extractContent({ content_type: "text", parts: ["a", "b"] })).toEqual({
      contentType: "text",
      text: "a\n\nb",
      codeLanguage: null,
      hasUnsupportedParts: false,
      isMalformed: false,
      rawContentJson: null,
    });
  });

  it("keeps empty string parts exactly (no trimming)", () => {
    expect(extractContent({ content_type: "text", parts: [""] }).text).toBe("");
    expect(extractContent({ content_type: "text", parts: [" x ", ""] }).text).toBe(" x \n\n");
  });

  it("replaces image parts with [image] without marking them unsupported", () => {
    const r = extractContent({
      content_type: "multimodal_text",
      parts: [{ content_type: "image_asset_pointer", asset_pointer: "file-service://p" }, "caption"],
    });
    expect(r.text).toBe("[image]\n\ncaption");
    expect(r.hasUnsupportedParts).toBe(false);
    expect(r.rawContentJson).toBeNull();
  });

  it("keeps code text exactly, with its language (A27)", () => {
    const text = "  indented()\n\tline  \n";
    expect(extractContent({ content_type: "code", language: "python", text })).toMatchObject({
      contentType: "code",
      text,
      codeLanguage: "python",
      hasUnsupportedParts: false,
      isMalformed: false,
    });
  });

  it("has a null language when none (or a blank one) is given", () => {
    expect(extractContent({ content_type: "code", text: "x" }).codeLanguage).toBeNull();
    expect(extractContent({ content_type: "code", language: " ", text: "x" }).codeLanguage).toBeNull();
    expect(extractContent({ content_type: "code", language: 3, text: "x" }).codeLanguage).toBeNull();
  });

  it("keeps HTML-like code as literal text", () => {
    const text = "<script>alert(1)</script>";
    expect(extractContent({ content_type: "code", language: "html", text }).text).toBe(text);
  });

  it("keeps execution_output text exactly", () => {
    expect(extractContent({ content_type: "execution_output", text: "out\n42" }).text).toBe(
      "out\n42",
    );
  });
});

describe("extractContent: unsupported content (A28)", () => {
  it("inserts a placeholder and keeps the raw payload for an unknown type without text", () => {
    const content = { content_type: "x_widget", payload: { note: "n" } };
    const r = extractContent(content);
    expect(r.text).toBe("[unsupported content: x_widget]");
    expect(r.hasUnsupportedParts).toBe(true);
    expect(r.isMalformed).toBe(false);
    expect(JSON.parse(r.rawContentJson!)).toEqual(content);
  });

  it("extracts text or string parts of an unknown type but still keeps the payload", () => {
    const withText = { content_type: "tether_quote", title: "t", url: "u", text: "quoted" };
    expect(extractContent(withText)).toMatchObject({ text: "quoted", hasUnsupportedParts: true });
    expect(JSON.parse(extractContent(withText).rawContentJson!)).toEqual(withText);
    expect(extractContent({ content_type: "x_parts", parts: ["p1", "p2"] }).text).toBe("p1\n\np2");
  });

  it("marks object parts inside text as unsupported and keeps the payload", () => {
    const content = { content_type: "text", parts: ["before", { x: 1 }] };
    const r = extractContent(content);
    expect(r.text).toBe("before\n\n[unsupported part]");
    expect(r.hasUnsupportedParts).toBe(true);
    expect(JSON.parse(r.rawContentJson!)).toEqual(content);
  });

  it("marks non-image multimodal parts as attachments and keeps the payload", () => {
    const r = extractContent({
      content_type: "multimodal_text",
      parts: [{ content_type: "audio_transcription", text: "t" }, { no_type: true }],
    });
    expect(r.text).toBe("[attachment: audio_transcription]\n\n[attachment: unknown]");
    expect(r.hasUnsupportedParts).toBe(true);
    expect(r.rawContentJson).not.toBeNull();
  });

  it("never puts an unsafe type name into placeholder text", () => {
    expect(extractContent({ content_type: "<b>x</b>" }).text).toBe("[unsupported content: unknown]");
    expect(displayTypeName("a".repeat(65))).toBe("unknown");
    expect(displayTypeName("tether_browsing_display")).toBe("tether_browsing_display");
  });

  it("stores rawContentJson only when content is not fully represented", () => {
    for (const c of [
      { content_type: "text", parts: ["x"] },
      { content_type: "code", text: "x" },
      { content_type: "execution_output", text: "x" },
      { content_type: "multimodal_text", parts: [{ content_type: "image_asset_pointer" }] },
    ]) {
      expect(extractContent(c).rawContentJson).toBeNull();
    }
  });
});

describe("extractContent: malformed content (A24)", () => {
  it("missing content: malformed, empty, nothing invented", () => {
    for (const c of [undefined, null]) {
      expect(extractContent(c)).toMatchObject({ text: "", isMalformed: true, rawContentJson: null });
    }
  });

  it("a bare string is recovered as text", () => {
    expect(extractContent("plain")).toMatchObject({
      text: "plain",
      isMalformed: true,
      hasUnsupportedParts: false,
    });
  });

  it("numbers and arrays are unreadable; the payload is kept", () => {
    expect(extractContent(7)).toMatchObject({ text: "", isMalformed: true, rawContentJson: "7" });
    expect(extractContent(["a"])).toMatchObject({ isMalformed: true, rawContentJson: '["a"]' });
  });

  it("a missing content_type is malformed; string parts are recovered and the payload kept", () => {
    const r = extractContent({ parts: ["recovered"] });
    expect(r).toMatchObject({ contentType: null, text: "recovered", isMalformed: true });
    expect(r.rawContentJson).not.toBeNull();
  });

  it("text without parts recovers a text field", () => {
    expect(extractContent({ content_type: "text", text: "t" })).toMatchObject({
      text: "t",
      isMalformed: true,
      hasUnsupportedParts: false,
    });
    expect(extractContent({ content_type: "text" })).toMatchObject({
      text: "",
      isMalformed: true,
      hasUnsupportedParts: true,
    });
  });

  it("code without text is malformed but keeps its language", () => {
    expect(extractContent({ content_type: "code", language: "go" })).toMatchObject({
      text: "",
      codeLanguage: "go",
      isMalformed: true,
    });
  });
});
