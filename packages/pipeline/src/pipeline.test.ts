import { describe, expect, it } from "vitest";
import { AIError } from "./ai";
import { extractClaims, mergeClaims, renderClaimLedger } from "./claims";
import { changedRatio } from "./diff";
import { buildChapterContext, draftChapter, frameworksIntroducedBefore, openingParagraph, updateSummary, wordFlags } from "./draft";
import { runPass, type PassInput } from "./edit";
import { generateBrief } from "./brief";
import { anchorChanges, extractFacts, revertChange } from "./guards";
import { generateMatter } from "./matter";
import { generateOutline, similarity, validateOutline } from "./outline";
import { buildStyleSheet, CURRENT_MARK, renderOutline } from "./render";
import { runJson, runText } from "./run";
import { DEFAULT_SETTINGS } from "./settings";
import { FakeAI, routeByTask } from "./testing";
import { testBrief, testOutline, testVoice } from "./fixtures";

const fast = { backoffMs: 0 };
const words = (n: number, w = "word") => Array.from({ length: n }, (_, i) => `${w}${i}`).join(" ");

describe("runText and runJson", () => {
  it("sanitizes text output and records the template version and tokens", async () => {
    const ai = new FakeAI(() => "Clean opening — really clean. 🚀");
    const r = await runText(ai, "summary", { prior_summary: "x", chapter_index: 1, chapter_title: "t", chapter_markdown: "m", frameworks: "f" }, fast);
    expect(r.output).toBe("Clean opening: really clean.");
    expect(r.meta.promptVersion).toBe("summary@1.0.0");
    expect(r.meta.sanitize.emDashes).toBe(1);
    expect(r.meta.sanitize.emojis).toBe(1);
    expect(r.meta.tokensIn).toBe(100);
  });

  it("parses fenced JSON and validates it", async () => {
    const ai = new FakeAI(() => "```json\n" + JSON.stringify({ queries: ["a b", "c d", "e f", "g h", "i j"] }) + "\n```");
    const r = await runJson(ai, "pain-queries", "PainQueriesOutput", { phrase: "p", lane: "l", top_titles: "t" }, fast);
    expect(r.output.queries).toHaveLength(5);
  });

  it("feeds a validation error back once, then succeeds", async () => {
    const ai = new FakeAI((_req, call) => (call === 1 ? '{"queries": ["only one"]}' : JSON.stringify({ queries: ["a", "b", "c", "d", "e"] })));
    const r = await runJson(ai, "pain-queries", "PainQueriesOutput", { phrase: "p", lane: "l", top_titles: "t" }, fast);
    expect(r.output.queries).toHaveLength(5);
    expect(ai.requests[1]?.user).toContain("could not be used");
    expect(r.meta.tokensIn).toBe(200);
  });

  it("fails after a second invalid response", async () => {
    const ai = new FakeAI(() => "not json");
    await expect(runJson(ai, "pain-queries", "PainQueriesOutput", { phrase: "p", lane: "l", top_titles: "t" }, fast)).rejects.toThrow(/invalid JSON/);
  });

  it("retries a retryable failure twice, then gives up", async () => {
    const flaky = new FakeAI((_r, call) => (call < 3 ? new AIError("503", true) : "ok text"));
    const r = await runText(flaky, "summary", { prior_summary: "x", chapter_index: 1, chapter_title: "t", chapter_markdown: "m", frameworks: "f" }, fast);
    expect(r.meta.attempts).toBe(3);
    const dead = new FakeAI(() => new AIError("503", true));
    await expect(runText(dead, "summary", { prior_summary: "x", chapter_index: 1, chapter_title: "t", chapter_markdown: "m", frameworks: "f" }, fast)).rejects.toThrow("503");
    expect(dead.requests).toHaveLength(3);
  });

  it("does not retry a non-retryable failure", async () => {
    const ai = new FakeAI(() => new AIError("400", false));
    await expect(runText(ai, "summary", { prior_summary: "x", chapter_index: 1, chapter_title: "t", chapter_markdown: "m", frameworks: "f" }, fast)).rejects.toThrow("400");
    expect(ai.requests).toHaveLength(1);
  });

  it("treats a max_tokens stop as a truncation failure", async () => {
    const ai = new FakeAI(() => ({ text: "cut off", stopReason: "max_tokens" }));
    await expect(runText(ai, "summary", { prior_summary: "x", chapter_index: 1, chapter_title: "t", chapter_markdown: "m", frameworks: "f" }, { ...fast, retries: 0 })).rejects.toThrow(/max_tokens/);
  });
});

describe("brief", () => {
  it("generates and validates a brief, passing operator materials to the template", async () => {
    const ai = new FakeAI(() => JSON.stringify(testBrief));
    const { brief, meta } = await generateBrief(
      ai,
      {
        book: { working_title: "Outreach", seed_description: "weekly outreach", lane: "BZ", language: "en", target_words: 12000, author_name: "Pen Name" },
        voice: testVoice,
        materials: { examples: ["Dana's first Friday Five"], reader_language: ["hate networking"], competitor_notes: "", notes: "" },
      },
      fast,
    );
    expect(brief.frameworks).toHaveLength(3);
    expect(meta.promptVersion).toBe("brief@1.0.0");
    expect(ai.requests[0]?.user).toContain("Dana's first Friday Five");
    expect(ai.requests[0]?.user).not.toContain("Market evidence");
  });
});

describe("outline", () => {
  const settings = DEFAULT_SETTINGS;

  it("passes a valid outline", () => {
    expect(validateOutline(testOutline, testBrief, 11000, settings)).toEqual([]);
  });

  it("flags a framework that appears in no chapter", () => {
    const o = structuredClone(testOutline);
    o.chapters[2]!.frameworks_introduced = [];
    o.chapters[2]!.title = "Keep Records";
    o.chapters[2]!.points = ["What to record", "Monthly review", "When to stop"];
    const v = validateOutline(o, testBrief, 11000, settings);
    expect(v.map((x) => x.check)).toEqual(["framework_coverage"]);
    expect(v[0]?.detail).toContain("Ask Ledger");
  });

  it("flags two chapters that share more than one key point", () => {
    const o = structuredClone(testOutline);
    o.chapters[1]!.points = ["Why five is enough", "Who goes on the first list", "Moving up one rung a week"];
    expect(validateOutline(o, testBrief, 11000, settings).map((x) => x.check)).toEqual(["shared_points"]);
  });

  it("allows one shared point", () => {
    const o = structuredClone(testOutline);
    o.chapters[1]!.points = ["Why five is enough", "Signals a contact is ready", "Moving up one rung a week"];
    expect(validateOutline(o, testBrief, 11000, settings)).toEqual([]);
  });

  it("flags word targets more than 10 percent off the total", () => {
    expect(validateOutline(testOutline, testBrief, 20000, settings).map((x) => x.check)).toEqual(["word_total"]);
    expect(validateOutline(testOutline, testBrief, 12000, settings)).toEqual([]);
  });

  it("flags a chapter without an action step and a malformed outline", () => {
    const o = structuredClone(testOutline);
    o.chapters[0]!.action_step = " ";
    expect(validateOutline(o, testBrief, 11000, settings).map((x) => x.check)).toEqual(["example_and_action"]);
    expect(validateOutline({ chapters: [] }, testBrief, 11000, settings)[0]?.check).toBe("schema");
  });

  it("generates an outline, returns violations, and feeds previous violations back", async () => {
    const ai = new FakeAI(() => JSON.stringify(testOutline));
    const r = await generateOutline(ai, { brief: testBrief, voice: testVoice, targetWords: 20000, settings, previousViolations: [{ check: "word_total", detail: "too short" }] }, fast);
    expect(r.violations.map((v) => v.check)).toEqual(["word_total"]);
    expect(ai.requests[0]?.user).toContain("word_total: too short");
    expect(ai.requests[0]?.system).toContain("Between 8 and 12 chapters");
  });

  it("scores similarity", () => {
    expect(similarity("Who goes on the first list", "who goes on the first list!")).toBe(1);
    expect(similarity("The four rungs", "Reading the ledger monthly")).toBeLessThan(0.5);
  });
});

describe("draft", () => {
  it("builds chapter context with the current chapter marked and earlier frameworks listed", () => {
    expect(frameworksIntroducedBefore(testOutline, 3)).toEqual(["The Friday Five", "Warmth Ladder"]);
    const ctx = buildChapterContext({ brief: testBrief, outline: testOutline, voice: testVoice, position: 2, priorSummary: "Ch1 summary", previousOpening: "Dana stared." });
    expect(ctx.slots.outline).toContain(`Chapter 2: Climb the Ladder ${CURRENT_MARK}`);
    expect(String(ctx.slots.outline).match(new RegExp(CURRENT_MARK, "g"))).toHaveLength(1);
    expect(ctx.slots.frameworks_introduced).toBe("- The Friday Five");
    expect(ctx.wordTarget).toBe(3000);
    const first = buildChapterContext({ brief: testBrief, outline: testOutline, voice: testVoice, position: 1, priorSummary: "" });
    expect(first.slots.prior_summary).toContain("first chapter");
    expect(first.slots.frameworks_introduced).toBe("None yet.");
  });

  it("drafts a chapter, strips a stray heading, sanitizes, and flags word count outside tolerance", async () => {
    const ai = new FakeAI(() => `## Start With Five\n\nYou sit at your desk — the inbox is empty and the week is gone. ${words(100)}`);
    const ctx = buildChapterContext({ brief: testBrief, outline: testOutline, voice: testVoice, position: 1, priorSummary: "" });
    const r = await draftChapter(ai, ctx, DEFAULT_SETTINGS, undefined, fast);
    expect(r.content.startsWith("You sit at your desk, the inbox")).toBe(true);
    expect(r.content).not.toContain("—");
    expect(r.flags[0]?.type).toBe("word_count");
    expect(ai.requests[0]?.user).toContain("You are writing chapter 1.");
    expect(ai.requests[0]?.user).not.toContain("Operator direction");
  });

  it("includes the regeneration note", async () => {
    const ai = new FakeAI(() => words(3000));
    const ctx = buildChapterContext({ brief: testBrief, outline: testOutline, voice: testVoice, position: 1, priorSummary: "" });
    const r = await draftChapter(ai, ctx, DEFAULT_SETTINGS, "shorter opening", fast);
    expect(ai.requests[0]?.user).toContain("shorter opening");
    expect(r.flags).toEqual([]);
  });

  it("updates the running summary", async () => {
    const ai = new FakeAI(() => "Chapter 1: Start With Five. Points...");
    const r = await updateSummary(ai, { priorSummary: "", position: 1, title: "Start With Five", content: "body", brief: testBrief }, fast);
    expect(r.summary).toContain("Chapter 1");
    expect(ai.requests[0]?.user).toContain("- The Friday Five");
  });

  it("word flags and opening paragraphs", () => {
    expect(wordFlags(2700, 3000, 0.1)).toEqual([]);
    expect(wordFlags(2600, 3000, 0.1)[0]?.note).toContain("-13 percent");
    expect(openingParagraph("## Head\n\nFirst para.\n\nSecond.")).toBe("First para.");
  });
});

const chapterText = [
  "You sit at your desk on Friday with five names on a card. The Friday Five starts here.",
  "Dana sent her first message to a former colleague named Priya. It took her 12 minutes.",
  "Honestly, the thing is that you basically just need to start, and that is really all there is to it.",
  "Write five names on a card before you close this book.",
].join("\n\n");

function passInput(overrides: Partial<PassInput> = {}): PassInput {
  return {
    pass: "line",
    intensity: "standard",
    section: { key: "ch01", label: "Chapter 1: Start With Five", mark: { kind: "chapter", index: 1 } },
    content: chapterText,
    brief: testBrief,
    outline: testOutline,
    voice: testVoice,
    styleSheet: buildStyleSheet(testVoice, testBrief),
    settings: DEFAULT_SETTINGS,
    ...overrides,
  };
}

const edit = (revised: string, changes: unknown[] = [], flags: unknown[] = []) => JSON.stringify({ revised_markdown: revised, changes, flags });

describe("edit passes", () => {
  const filler = "Honestly, the thing is that you basically just need to start, and that is really all there is to it.";

  it("applies a small edit and numbers its changes", async () => {
    const revised = chapterText.replace(filler, "Start.");
    const ai = new FakeAI(() => edit(revised, [{ type: "filler", location: "paragraph 3", before: filler, after: "Start.", reason: "filler" }], [{ type: "example", location: "p2", note: "thin" }]));
    const r = await runPass(ai, passInput(), fast);
    expect(r.status).toBe("applied");
    expect(r.changes[0]?.n).toBe(1);
    expect(r.changes[0]?.located).toBe(true);
    expect(r.ratio).toBeGreaterThan(0.2);
    expect(r.ratio).toBeLessThan(0.4);
    expect(r.summary).toContain("line: 1 change (filler 1)");
    expect(r.flags.map((f) => f.type)).toEqual(["example"]);
    expect(r.meta.promptVersion).toBe("edit-line@1.0.0");
  });

  it("returns cap_exceeded above 40 percent and still carries the revision", async () => {
    const revised = "A completely different chapter about other things entirely, with none of the original words kept, five names Friday Dana Priya 12.";
    const ai = new FakeAI(() => edit(revised));
    const r = await runPass(ai, passInput(), fast);
    expect(r.status).toBe("cap_exceeded");
    expect(r.ratio).toBeGreaterThan(0.4);
    expect(r.revised.length).toBeGreaterThan(0);
  });

  it("returns no_change when the section comes back unchanged", async () => {
    const ai = new FakeAI(() => edit(chapterText));
    expect((await runPass(ai, passInput(), fast)).status).toBe("no_change");
  });

  it("voice guard reverts a change that introduces a banned term", async () => {
    const before = "Write five names on a card before you close this book.";
    const after = "This game-changer step: write five names on a card.";
    const ai = new FakeAI(() => edit(chapterText.replace(before, after), [{ type: "shorten", location: "p4", before, after, reason: "tighter" }]));
    const r = await runPass(ai, passInput(), fast);
    expect(r.guardReverts).toEqual([{ guard: "voice", n: 1, reason: "introduced banned term: game-changer" }]);
    expect(r.revised).toContain(before);
    expect(r.status).toBe("no_change");
  });

  it("voice guard reverts a change that writes a sentence longer than the author does", async () => {
    const before = "Write five names on a card before you close this book.";
    const after = `Write five names on a card before you close this book and then ${words(20, "and")}.`;
    const ai = new FakeAI(() => edit(chapterText.replace(before, after), [{ type: "transition", location: "p4", before, after, reason: "" }]));
    const r = await runPass(ai, passInput(), fast);
    expect(r.guardReverts[0]?.guard).toBe("voice");
    expect(r.revised).toBe(chapterText);
  });

  it("fact guard reverts a cut that removed a number and a name", async () => {
    const before = "Dana sent her first message to a former colleague named Priya. It took her 12 minutes.";
    const ai = new FakeAI(() => edit(chapterText.replace(`${before}\n\n`, ""), [{ type: "cut", location: "p2", before: `${before}\n\n`, after: "", reason: "cut" }]));
    const r = await runPass(ai, passInput({ pass: "dev", bookSummary: "summary" }), fast);
    expect(r.guardReverts.map((g) => g.guard)).toContain("fact");
    expect(r.revised).toContain("Priya");
    expect(r.revised).toContain("12 minutes");
  });

  it("fact guard flags a missing fact it cannot trace to a change", async () => {
    const ai = new FakeAI(() => edit(chapterText.replace("Priya", "a friend")));
    const r = await runPass(ai, passInput({ pass: "copy", claimLedger: "C1 [Needs source]: x" }), fast);
    expect(r.flags.some((f) => f.type === "fact" && f.note.includes("Priya"))).toBe(true);
  });

  it("flags changes whose quoted text is not in the section", async () => {
    const ai = new FakeAI(() => edit(chapterText, [{ type: "typo", location: "", before: "text that is not there", after: "x", reason: "" }]));
    const r = await runPass(ai, passInput({ pass: "proof" }), fast);
    expect(r.flags.some((f) => f.type === "change_log")).toBe(true);
  });

  it("sends pass-specific slots to the right template", async () => {
    const ai = new FakeAI(routeByTask({ "edit-dev": () => edit(chapterText), "edit-copy": () => edit(chapterText) }));
    await runPass(ai, passInput({ pass: "dev", bookSummary: "BOOK SUMMARY", driftNote: "Promise changed" }), fast);
    await runPass(ai, passInput({ pass: "copy", claimLedger: "C1 [Verified]: 12 minutes" }), fast);
    expect(ai.requests[0]?.user).toContain("BOOK SUMMARY");
    expect(ai.requests[0]?.user).toContain("Promise changed");
    expect(ai.requests[1]?.user).toContain("C1 [Verified]: 12 minutes");
    expect(ai.requests[0]?.user).toContain("Style sheet");
  });
});

describe("revert and ratio", () => {
  it("reverts a replacement and a pure cut by anchor", () => {
    const original = "One. Two three. Four.";
    const [rep, cut] = anchorChanges(original, [
      { n: 1, type: "x", location: "", before: "Two three.", after: "Two.", reason: "" },
      { n: 2, type: "cut", location: "", before: " Four.", after: "", reason: "" },
    ]);
    expect(revertChange("One. Two. Four.", rep!)).toBe(original);
    expect(revertChange("One. Two three.", cut!)).toBe(original);
    expect(revertChange("Nothing matches", rep!)).toBeNull();
  });

  it("measures changed words", () => {
    expect(changedRatio("a b c d e f g h i j", "a b c d e f g h i j").changedRatio).toBe(0);
    expect(changedRatio("a b c d e f g h i j", "a b c d e f g h").changedRatio).toBeCloseTo(0.2);
    expect(changedRatio("a b c d", "w x y z").changedRatio).toBe(1);
  });

  it("extracts facts", () => {
    const f = extractFacts("On March 3 she paid $1,200 to Acme Corp, up 15%. Then she left.", ["Ask Ledger"]);
    expect([...f]).toEqual(expect.arrayContaining(["3", "$1,200", "15%", "March", "Acme Corp"]));
    expect(f.has("Then")).toBe(false);
  });
});

describe("claims", () => {
  it("extracts sentences with numbers and references, and keeps operator decisions on merge", () => {
    const c = extractClaims("ch01", "A study found 40 percent of people never ask. You can ask today. Sales rose 3x.");
    expect(c.map((x) => x.text)).toEqual(["A study found 40 percent of people never ask.", "Sales rose 3x."]);
    const merged = mergeClaims([{ ...c[0]!, status: "Verified", source: "Pew 2024" }], c);
    expect(merged[0]?.status).toBe("Verified");
    expect(merged[1]?.status).toBe("Needs source");
    expect(renderClaimLedger(merged)).toContain("C1 [Verified] (source: Pew 2024)");
  });
});

describe("matter and rendering", () => {
  it("generates matter with word targets and the course URL", async () => {
    const ai = new FakeAI(() => JSON.stringify({ introduction_markdown: "Intro.", conclusion_markdown: "End.", companion_course_markdown: "Course." }));
    const r = await generateMatter(ai, { brief: testBrief, outline: testOutline, voice: testVoice, bookSummary: "s", companionCourseUrl: "https://example.com/c" }, fast);
    expect(r.matter.introduction_markdown).toBe("Intro.");
    expect(ai.requests[0]?.system).toContain("About 1000 words");
    expect(ai.requests[0]?.user).toContain("https://example.com/c");
  });

  it("renders the style sheet with frameworks and banned terms", () => {
    const s = buildStyleSheet(testVoice, testBrief);
    expect(s).toContain("- The Friday Five (framework)");
    expect(s).toContain("- game-changer");
    expect(renderOutline(testOutline, { kind: "conclusion" })).toContain(`Conclusion ${CURRENT_MARK}`);
  });
});
