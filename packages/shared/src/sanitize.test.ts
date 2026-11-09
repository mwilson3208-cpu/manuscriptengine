import { describe, expect, it } from "vitest";
import { sanitize, sanitizeDeep } from "./sanitize";
import { countWords, findForbidden } from "./text";

describe("sanitize: dashes", () => {
  it("turns paired em dashes around an aside into commas", () => {
    const r = sanitize("The plan \u2014 the one you wrote last week \u2014 still works.");
    expect(r.text).toBe("The plan, the one you wrote last week, still works.");
    expect(r.report.emDashes).toBe(2);
  });

  it("uses a colon before a short tail", () => {
    expect(sanitize("One thing matters\u2014trust.").text).toBe("One thing matters: trust.");
  });

  it("uses a period before a new capitalized sentence", () => {
    expect(sanitize("You tried that already \u2014 Most people stop there and never test the second version.").text).toBe(
      "You tried that already. Most people stop there and never test the second version.",
    );
  });

  it("uses a comma before a longer lowercase clause", () => {
    expect(sanitize("Send the note today \u2014 because the window closes when the week ends.").text).toBe(
      "Send the note today, because the window closes when the week ends.",
    );
  });

  it("converts numeric en dash ranges to 'to'", () => {
    const r = sanitize("Plan for 10\u201320 minutes, pages 3 \u2013 7.");
    expect(r.text).toBe("Plan for 10 to 20 minutes, pages 3 to 7.");
    expect(r.report.enDashes).toBe(2);
  });

  it("handles ASCII double hyphens and spaced hyphens", () => {
    const r = sanitize("Keep it short--really short. Call them - not email.");
    expect(r.text).not.toMatch(/--| - /);
    expect(r.report.emDashes).toBe(2);
  });

  it("leaves list markers, hyphenated words, and thematic breaks alone", () => {
    const md = "- first item\n- well-known step\n\n---\n\n| a | b |\n|---|---|";
    expect(sanitize(md).text).toBe(md);
  });

  it("drops a dash at the start or end of a line", () => {
    expect(sanitize("\u2014 Anonymous").text).toBe("Anonymous");
    expect(sanitize("And then \u2014").text).toBe("And then");
  });

  it("never leaves a dash behind", () => {
    const samples = [
      "A \u2014 B \u2014 C \u2014 D.",
      "Wait\u2014what? Yes\u2014no\u2014maybe.",
      "The \u2015 bar and \u2E3A two-em and \u2012 figure.",
    ];
    for (const s of samples) expect(findForbidden(sanitize(s).text)).toEqual([]);
  });
});

describe("sanitize: emojis, quotes, blank lines", () => {
  it("strips emojis but keeps copyright, registered, and trademark signs", () => {
    const r = sanitize("Copyright \u00A9 2026 \u{1F680} Power Reads\u2122 \u{1F44D}\u{1F3FD} done \u2705.");
    expect(r.text).toBe("Copyright \u00A9 2026 Power Reads\u2122 done.");
    expect(r.report.emojis).toBe(3);
  });

  it("normalizes curly quotes", () => {
    const r = sanitize("\u201CIt\u2019s fine,\u201D she said.");
    expect(r.text).toBe("\"It's fine,\" she said.");
    expect(r.report.quotes).toBe(3);
  });

  it("collapses triple blank lines", () => {
    const r = sanitize("One.\n\n\n\nTwo.\n\n\nThree.");
    expect(r.text).toBe("One.\n\nTwo.\n\nThree.");
    expect(r.report.blankLines).toBe(2);
  });

  it("reports zero on clean text", () => {
    const r = sanitize("Clean text, nothing to fix.\n\nSecond paragraph.");
    expect(r.report.total).toBe(0);
  });

  it("sanitizes every string in an object", () => {
    const { value, report } = sanitizeDeep({ a: "x \u2014 y \u2014 z", b: ["\u201Cq\u201D"], n: 3 });
    expect(value).toEqual({ a: "x, y, z", b: ['"q"'], n: 3 });
    expect(report.emDashes).toBe(2);
    expect(report.quotes).toBe(2);
  });
});

describe("findForbidden", () => {
  it("finds dashes, emojis, and banned terms with line numbers", () => {
    const text = "Line one is fine.\nThis is a game-changer \u2014 really.\nGreat \u{1F600}";
    const issues = findForbidden(text, ["game-changer", "em dashes", "emojis"]);
    expect(issues.map((i) => [i.kind, i.line])).toEqual([
      ["em_dash", 2],
      ["banned_term", 2],
      ["emoji", 3],
    ]);
  });

  it("matches banned terms as whole words, case-insensitively", () => {
    expect(findForbidden("Unlock your potential.", ["unlock"]).length).toBe(1);
    expect(findForbidden("The unlocked door.", ["unlock"]).length).toBe(0);
  });
});

describe("countWords", () => {
  it("ignores Markdown syntax", () => {
    expect(countWords("## Heading here\n\n- one item\n- **two** items\n\nIt's 3 words.")).toBe(9);
  });
});
