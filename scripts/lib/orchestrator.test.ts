import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, FILLER, fakeModel, hasPandoc, testBrief, testOutline, testVoice } from "./fake-book";
import { currentVersion, section } from "./book-state";
import {
  approve,
  initBook,
  regenChapter,
  resolvePending,
  restoreVersion,
  revertLoggedChange,
  runBook,
  type CapDecision,
  type Operator,
  type RunConfig,
} from "./orchestrator";

function setup(opts: { banned?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "phase0-"));
  const inputPath = join(dir, "input.json");
  writeFileSync(
    inputPath,
    JSON.stringify({
      working_title: "Weekly Outreach",
      lane: "BZ",
      author_name: "Pen Name",
      target_words: 11000,
      voice_profile: testVoice,
      materials: { examples: ["Dana's first Friday Five"] },
    }),
  );
  const store = initBook(inputPath, join(dir, "out"));
  const decisions: CapDecision[] = [];
  const operator: Operator = {
    log: (m) => { if (process.env.DBG) console.log(m); },
    capDecision: async () => decisions.shift() ?? "stop",
  };
  const cfg: RunConfig = { ai: fakeModel(opts), settings: DEFAULT_SETTINGS, operator, backoffMs: 0 };
  return { store, cfg, decisions };
}

describe("phase0 orchestrator", () => {
  it.skipIf(!hasPandoc)("carries a book from brief to DOCX with gates, the cap pause, and rollback", async () => {
    const { store, cfg } = setup();

    // Brief gate
    let out = await runBook(store, cfg);
    expect(out.stage).toBe("brief_review");
    expect(existsSync(store.path("brief.json"))).toBe(true);
    approve(store, "brief", DEFAULT_SETTINGS);

    // Outline gate
    out = await runBook(store, cfg);
    expect(out.stage).toBe("outline_review");
    expect(approve(store, "outline", DEFAULT_SETTINGS)).toContain("3 chapters created");

    // Draft, matter, then the developmental pass on chapter 2 exceeds the cap and stops
    out = await runBook(store, cfg);
    expect(out.stage).toBe("waiting_operator");
    expect(out.message).toContain("dev pass on ch02");
    let state = store.load();
    expect(state.sections.map((s) => s.key)).toEqual(["intro", "ch01", "ch02", "ch03", "conclusion", "course"]);
    expect(state.summaries.map((s) => s.text)).toEqual(["Summary through chapter 1.", "Summary through chapter 2.", "Summary through chapter 3."]);
    expect(currentVersion(section(state, "ch02"))?.source).toBe("draft");
    expect(state.styleSheet?.text).toContain("The Friday Five (framework)");
    expect(state.claims.length).toBeGreaterThan(0);

    // A rerun while waiting changes nothing
    expect((await runBook(store, cfg)).stage).toBe("waiting_operator");

    // Skip the over-cap edit, then finish
    expect(await resolvePending(store, "skip")).toContain("Skipped");
    out = await runBook(store, cfg);
    expect(out.stage).toBe("done");
    expect(out.docxPath && existsSync(out.docxPath)).toBe(true);

    state = store.load();
    const ch1 = section(state, "ch01");
    expect(ch1.versions.map((v) => v.source)).toEqual(["draft", "line"]);
    expect(currentVersion(ch1)?.content).not.toContain(FILLER);
    expect(section(state, "ch02").versions.map((v) => v.source)).toEqual(["draft", "line"]);
    expect(state.passUnits.find((u) => u.pass === "dev" && u.sectionKey === "ch02")?.status).toBe("skipped");
    expect(state.passUnits.filter((u) => u.sectionKey === "course").map((u) => u.pass)).toEqual(["copy", "proof"]);

    // Every AI call recorded with its template version; drafting is logged as generated
    expect(state.aiLog.find((e) => e.task === "chapter")?.use).toBe("generated");
    expect(state.aiLog.find((e) => e.task === "edit-line")?.promptVersion).toBe("edit-line@1.0.0");

    // Reports
    const report = readFileSync(store.path("report.md"), "utf8");
    expect(report).toContain("must be disclosed as AI-generated");
    expect(report).toContain("Passed: zero em dashes");
    expect(report).toContain("[example] paragraph 2: Example is thin");
    expect(readFileSync(store.path("change-log.md"), "utf8")).toContain("1. filler, paragraph 3: filler");

    // Revert the line pass change by number, then restore the draft, then restore the latest again
    const lineLog = state.changeLogs.find((l) => l.pass === "line" && l.sectionKey === "ch01");
    expect(lineLog).toBeDefined();
    expect(revertLoggedChange(store, lineLog!.id, 1)).toContain("version 3");
    expect(currentVersion(section(store.load(), "ch01"))?.content).toContain(FILLER);
    restoreVersion(store, "ch01", 1);
    expect(currentVersion(section(store.load(), "ch01"))?.source).toBe("draft");
    restoreVersion(store, "ch01", 3);
    expect(section(store.load(), "ch01").versions).toHaveLength(3);

    // Regenerate with a note: a new version, nothing overwritten
    expect(await regenChapter(store, cfg, 2, "shorter opening")).toContain("version 3");
    const ch2 = section(store.load(), "ch02");
    expect(ch2.versions.map((v) => v.source)).toEqual(["draft", "line", "regen"]);
    expect(ch2.versions[2]?.note).toBe("shorter opening");
  });

  it.skipIf(!hasPandoc)("applies an over-cap edit when the operator chooses Apply", async () => {
    const { store, cfg, decisions } = setup();
    cfg.autoApprove = true;
    cfg.passes = ["dev"];
    decisions.push("apply");
    const out = await runBook(store, cfg);
    const state = store.load();
    const ch2 = section(state, "ch02");
    expect(ch2.versions.map((v) => v.source)).toEqual(["draft", "dev"]);
    expect(ch2.versions[1]?.note).toContain("applied by operator over the 40 percent cap");
    expect(out.stage).toBe("done");
  });

  it("blocks the DOCX when the final text has a banned term", async () => {
    const { store, cfg, decisions } = setup({ banned: true });
    cfg.autoApprove = true;
    decisions.push("skip");
    const out = await runBook(store, cfg);
    expect(out.stage).toBe("qa_failed");
    const qa = JSON.parse(readFileSync(store.path("qa.json"), "utf8")) as { kind: string }[];
    expect(qa.map((i) => i.kind)).toContain("banned_term");
    expect(existsSync(store.path(`${store.load().slug}.docx`))).toBe(false);
  });

  it("refuses to approve an outline with violations unless forced", async () => {
    const { store, cfg } = setup();
    cfg.autoApprove = true;
    // Break the outline on disk before approval.
    await runBook(store, { ...cfg, autoApprove: false });
    approve(store, "brief", DEFAULT_SETTINGS);
    await runBook(store, { ...cfg, autoApprove: false });
    const bad = { ...testOutline, chapters: testOutline.chapters.map((c) => ({ ...c, word_target: 100 })) };
    writeFileSync(store.path("outline.json"), JSON.stringify(bad));
    expect(() => approve(store, "outline", DEFAULT_SETTINGS)).toThrow(/word_total/);
    expect(approve(store, "outline", DEFAULT_SETTINGS, true)).toContain("approved");
  });

  it("flags drift when an approved brief is edited and re-approved", async () => {
    const { store, cfg } = setup();
    await runBook(store, cfg);
    approve(store, "brief", DEFAULT_SETTINGS);
    writeFileSync(store.path("brief.json"), JSON.stringify({ ...testBrief, promise: "A different promise." }));
    expect(approve(store, "brief", DEFAULT_SETTINGS)).toContain("drift");
    const state = store.load();
    expect(state.needsDriftCheck).toBe(true);
    expect(state.driftNote).toContain("promise changed");
  });
});
