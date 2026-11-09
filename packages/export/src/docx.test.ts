import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildManuscriptMarkdown, demoteHeadings, renderDocx, runPandoc } from "./docx";

const hasPandoc = (() => {
  try {
    execFileSync(process.env.PANDOC_PATH || "pandoc", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const input = {
  title: 'The "Weekly" Outreach System',
  subtitle: "A routine for introverts",
  author: "Pen Name",
  language: "en",
  sections: [
    { kind: "intro" as const, title: "Introduction", markdown: "You have tried events." },
    { kind: "chapter" as const, title: "Start With Five", markdown: "Body.\n\n# Stray heading\n\n## Sub" },
    { kind: "chapter" as const, title: "Climb the Ladder", markdown: "Body two." },
    { kind: "conclusion" as const, title: "Conclusion", markdown: "Keep going." },
  ],
};

describe("manuscript markdown", () => {
  it("writes a title block and numbered level 1 chapter headings", () => {
    const md = buildManuscriptMarkdown(input);
    expect(md.startsWith('---\ntitle: "The \\"Weekly\\" Outreach System"\nsubtitle: "A routine for introverts"')).toBe(true);
    expect(md).toContain("# Introduction\n");
    expect(md).toContain("# Chapter 1: Start With Five\n");
    expect(md).toContain("# Chapter 2: Climb the Ladder\n");
    expect(md).toContain("## Stray heading");
    expect(md.match(/^# /gm)).toHaveLength(4);
  });

  it("demotes section headings", () => {
    expect(demoteHeadings("# A\n## B\ntext #not")).toBe("## A\n### B\ntext #not");
  });
});

describe.skipIf(!hasPandoc)("renderDocx", () => {
  it("produces a DOCX with curly quotes and no dashes from straight punctuation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "docx-test-"));
    const out = join(dir, "book.docx");
    const md = buildManuscriptMarkdown(input);
    await renderDocx(md, out);
    expect(statSync(out).size).toBeGreaterThan(5000);
    const { stdout } = await runPandoc(["--from", "docx", "--to", "plain", out]);
    expect(stdout).toContain("Chapter 1: Start With Five");
    expect(stdout).not.toMatch(/[\u2013\u2014]/);
    expect(readFileSync(out).subarray(0, 2).toString()).toBe("PK");
  });
});
