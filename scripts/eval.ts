/**
 * Template evaluation harness (CLAUDE.md, "Evaluation harness").
 *
 * Runs the fixed test book in eval/fixtures through the chapter template for
 * chapters 1 and 2 and the developmental pass on both, then writes everything
 * to eval/<date>/ so the operator can read the first two chapters and the
 * developmental log before a template change ships. Run after any template
 * change and link the output folder in the pull request.
 *
 *   pnpm eval [--chapters 2] [--label note]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  buildChapterContext,
  buildStyleSheet,
  draftChapter,
  openingParagraph,
  runPass,
  taskModelKey,
  updateSummary,
  validateOutline,
  type AIClient,
  type PipelineSettings,
} from "@me/pipeline";
import { BriefOutput, findForbidden, OutlineOutput, VoiceProfile, type CallMeta } from "@me/shared";
import { createClient, loadSettings, REPO_ROOT } from "./lib/settings";

const { values } = parseArgs({ options: { chapters: { type: "string", default: "2" }, label: { type: "string", default: "" } } });

export interface EvalResult {
  dir: string;
  calls: { step: string; meta: CallMeta }[];
}

export async function runEval(ai: AIClient, settings: PipelineSettings, outRoot: string, chapterCount = 2, label = ""): Promise<EvalResult> {
  const fx = (f: string) => JSON.parse(readFileSync(join(REPO_ROOT, "eval/fixtures", f), "utf8")) as unknown;
  const brief = BriefOutput.parse(fx("brief.json"));
  const outline = OutlineOutput.parse(fx("outline.json"));
  const voice = VoiceProfile.parse(fx("voice.json"));
  const target = outline.intro.word_target + outline.conclusion.word_target + outline.chapters.reduce((s, c) => s + c.word_target, 0);
  const violations = validateOutline(outline, brief, target, settings);
  if (violations.length) throw new Error(`Eval fixture outline is invalid: ${violations.map((v) => v.detail).join("; ")}`);

  const stamp = new Date().toISOString().replace(/[:]/g, "-").replace(/\..+$/, "");
  const dir = join(outRoot, `${stamp}${label ? `-${label.replace(/[^a-z0-9-]+/gi, "-")}` : ""}`);
  mkdirSync(dir, { recursive: true });
  const calls: EvalResult["calls"] = [];
  const opt = (task: string) => {
    const k = taskModelKey(settings, task);
    return k ? { modelKey: k } : {};
  };

  const styleSheet = buildStyleSheet(voice, brief);
  let summary = "";
  let previous = "";
  const report: string[] = [`# Eval run ${stamp}${label ? ` (${label})` : ""}`, ""];

  for (let p = 1; p <= chapterCount; p++) {
    const ctx = buildChapterContext({ brief, outline, voice, position: p, priorSummary: summary, ...(previous ? { previousOpening: openingParagraph(previous) } : {}) });
    const draft = await draftChapter(ai, ctx, settings, undefined, opt("chapter"));
    calls.push({ step: `chapter ${p}`, meta: draft.meta });
    writeFileSync(join(dir, `chapter-${String(p).padStart(2, "0")}.md`), `# Chapter ${p}: ${ctx.title}\n\n${draft.content}\n`);

    const dev = await runPass(
      ai,
      {
        pass: "dev",
        intensity: "standard",
        section: { key: `ch${p}`, label: `Chapter ${p}: ${ctx.title}`, mark: { kind: "chapter", index: p } },
        content: draft.content,
        brief,
        outline,
        voice,
        styleSheet,
        bookSummary: summary || "(first chapter)",
        settings,
      },
      opt("edit-dev"),
    );
    calls.push({ step: `dev pass ${p}`, meta: dev.meta });
    writeFileSync(join(dir, `chapter-${String(p).padStart(2, "0")}-dev.md`), `# Chapter ${p}: ${ctx.title} (after developmental pass, status ${dev.status})\n\n${dev.revised}\n`);

    const issues = findForbidden(draft.content, voice.banned_terms);
    report.push(
      `## Chapter ${p}: ${ctx.title}`,
      "",
      `Draft: ${draft.wordCount} words against ${ctx.wordTarget}. ${draft.flags.map((f) => f.note).join(" ") || "Within tolerance."}`,
      `Sanitizer replacements in the draft: ${draft.meta.sanitize.total} (em ${draft.meta.sanitize.emDashes}, en ${draft.meta.sanitize.enDashes}, emoji ${draft.meta.sanitize.emojis}).`,
      `Forbidden items after sanitize: ${issues.length ? issues.map((i) => `${i.kind} ${i.match}`).join(", ") : "none"}.`,
      "",
      `Developmental pass: ${dev.summary}. Status: ${dev.status}.`,
      "",
      "Flags:",
      ...(dev.flags.length ? dev.flags.map((f) => `- [${f.type}]${f.location ? ` ${f.location}:` : ""} ${f.note}`) : ["- none"]),
      "",
      "Changes:",
      ...(dev.changes.length ? dev.changes.map((c) => `${c.n}. ${c.type}${c.location ? `, ${c.location}` : ""}: ${c.reason}\n   Before: ${c.before.replace(/\n+/g, " / ")}\n   After: ${c.after.replace(/\n+/g, " / ") || "(cut)"}`) : ["- none"]),
      ...(dev.guardReverts.length ? ["", "Guard reverts:", ...dev.guardReverts.map((g) => `- change ${g.n}: ${g.guard}, ${g.reason}`)] : []),
      "",
    );

    if (p < chapterCount) {
      const s = await updateSummary(ai, { priorSummary: summary, position: p, title: ctx.title, content: draft.content, brief }, opt("summary"));
      calls.push({ step: `summary ${p}`, meta: s.meta });
      summary = s.summary;
    }
    previous = draft.content;
  }

  const tokensIn = calls.reduce((s, c) => s + c.meta.tokensIn, 0);
  const tokensOut = calls.reduce((s, c) => s + c.meta.tokensOut, 0);
  report.push("## Calls", "", "| Step | Template | Model | Tokens in | Tokens out | Seconds |", "| --- | --- | --- | --- | --- | --- |");
  for (const c of calls) report.push(`| ${c.step} | ${c.meta.promptVersion} | ${c.meta.model} | ${c.meta.tokensIn} | ${c.meta.tokensOut} | ${(c.meta.latencyMs / 1000).toFixed(1)} |`);
  report.push(`| Total | | | ${tokensIn} | ${tokensOut} | |`, "");
  writeFileSync(join(dir, "README.md"), report.join("\n"));
  writeFileSync(join(dir, "calls.json"), JSON.stringify(calls, null, 2));
  return { dir, calls };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const settings = loadSettings();
  const { ai, label } = createClient(settings);
  console.log(`AI: ${label}`);
  runEval(ai, settings, join(REPO_ROOT, "eval"), Number(values.chapters), values.label)
    .then((r) => console.log(`Eval written to ${r.dir}`))
    .catch((e: unknown) => {
      console.error(`Error: ${(e as Error).message}`);
      process.exit(1);
    });
}
