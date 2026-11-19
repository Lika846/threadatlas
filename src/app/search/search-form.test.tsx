import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The Server Action is not called during a render; stub its module.
vi.mock("./actions", () => ({ searchAction: async () => ({ kind: "error", code: "INTERNAL_ERROR" }) }));
const { SearchForm } = await import("./search-form");

describe("SearchForm, server-rendered (M2.3)", () => {
  const html = renderToStaticMarkup(<SearchForm />);

  it("is a labelled search landmark with a search input that browsers do not remember", () => {
    expect(html).toMatch(/<form role="search" aria-label="Search conversations"/);
    expect(html).toMatch(/<label for="search-query"[^>]*>Search conversations<\/label>/);
    const input = html.match(/<input id="search-query"[^>]*>/)?.[0] ?? "";
    for (const attr of ['type="search"', 'autoComplete="off"', 'spellCheck="false"', 'name="q"', 'aria-describedby="search-help"']) {
      expect(input).toContain(attr);
    }
  });

  it("cannot put the query in a URL: no GET submission, no length cut-off", () => {
    expect(html).toContain('method="post"');
    expect(html).not.toMatch(/method="get"/i);
    expect(html).not.toMatch(/<form[^>]*action=/);
    expect(html).not.toMatch(/maxLength|maxlength/);
  });

  it("keeps the submit button disabled until the page is interactive", () => {
    expect(html).toMatch(/<button type="submit" disabled=""[^>]*>Search<\/button>/);
  });

  it("starts with an empty polite status region and no results", () => {
    expect(html).toMatch(/<div role="status" aria-live="polite" class="sr-only"><\/div>/);
    expect(html).not.toContain("search-results-heading");
    expect(html).not.toContain('role="alert"');
  });
});
