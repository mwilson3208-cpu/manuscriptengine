import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, FakeAI, routeByTask } from "@me/pipeline";
import { runEval } from "./eval";

describe("eval harness", () => {
  it("runs the fixed book through chapter and developmental templates and writes the output", async () => {
    const ai = new FakeAI(
      routeByTask({
        chapter: (req) => `You sit down on Friday. Chapter ${/You are writing chapter (\d+)/.exec(req.user)?.[1]} body.`,
        summary: () => "Summary of chapter 1.",
        "edit-dev": (req) => {
          const text = /\nSection: [^\n]*\n\n([\s\S]*?)\n\nRun the /.exec(req.user)?.[1] ?? "";
          return JSON.stringify({ revised_markdown: text, changes: [], flags: [{ type: "missing", location: "end", note: "No action step" }] });
        },
      }),
    );
    const out = mkdtempSync(join(tmpdir(), "eval-"));
    const r = await runEval(ai, DEFAULT_SETTINGS, out, 2, "unit");
    expect(r.calls.map((c) => c.step)).toEqual(["chapter 1", "dev pass 1", "summary 1", "chapter 2", "dev pass 2"]);
    for (const f of ["chapter-01.md", "chapter-02.md", "chapter-01-dev.md", "README.md", "calls.json"]) expect(existsSync(join(r.dir, f))).toBe(true);
    const readme = readFileSync(join(r.dir, "README.md"), "utf8");
    expect(readme).toContain("[missing] end: No action step");
    expect(readme).toContain("chapter@1.0.0");
    expect(ai.requests[3]?.user).toContain("Summary of chapter 1.");
  });
});
