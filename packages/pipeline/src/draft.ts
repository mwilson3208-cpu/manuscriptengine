import { countWords, type BriefOutput, type CallMeta, type OutlineOutput, type VersionFlag, type VoiceProfile } from "@me/shared";
import type { AIClient } from "./ai";
import { renderBrief, renderOutline, renderVoiceProfile } from "./render";
import { runText, type RunOptions } from "./run";
import type { PipelineSettings } from "./settings";
import type { Slots } from "@me/prompts";

export interface ChapterContextInput {
  brief: BriefOutput;
  outline: OutlineOutput;
  voice: VoiceProfile;
  /** 1-based chapter position. */
  position: number;
  /** Running summary of chapters 1 to position minus 1. Empty for chapter 1. */
  priorSummary: string;
  /** Opening paragraph of the previous chapter's current version, so openers vary. */
  previousOpening?: string;
}

export interface ChapterContext {
  position: number;
  title: string;
  wordTarget: number;
  slots: Slots;
}

/** Frameworks introduced in chapters before `position`, per the outline. */
export function frameworksIntroducedBefore(outline: OutlineOutput, position: number): string[] {
  const names: string[] = [];
  outline.chapters.slice(0, Math.max(0, position - 1)).forEach((c) => {
    for (const f of c.frameworks_introduced) if (!names.includes(f)) names.push(f);
  });
  return names;
}

/** Assemble everything a chapter call needs (SPEC.md Stage 3, context sent with every chapter call). */
export function buildChapterContext(input: ChapterContextInput): ChapterContext {
  const chapter = input.outline.chapters[input.position - 1];
  if (!chapter) throw new Error(`Outline has no chapter ${input.position}`);
  const introduced = frameworksIntroducedBefore(input.outline, input.position);
  return {
    position: input.position,
    title: chapter.title,
    wordTarget: chapter.word_target,
    slots: {
      brief: renderBrief(input.brief),
      outline: renderOutline(input.outline, { kind: "chapter", index: input.position }),
      chapter_index: input.position,
      voice_profile: renderVoiceProfile(input.voice),
      prior_summary: input.priorSummary.trim() || "This is the first chapter. No chapters come before it.",
      word_target: chapter.word_target,
      frameworks_introduced: introduced.length ? introduced.map((f) => `- ${f}`).join("\n") : "None yet.",
      reading_level: input.brief.tone,
      previous_opening: input.previousOpening,
    },
  };
}

export interface DraftResult {
  content: string;
  wordCount: number;
  flags: VersionFlag[];
  meta: CallMeta;
}

/** Draft a chapter, or regenerate it when `note` is set. Word count outside tolerance flags, never rejects. */
export async function draftChapter(
  ai: AIClient,
  ctx: ChapterContext,
  settings: Pick<PipelineSettings, "word_tolerance">,
  note?: string,
  opts: RunOptions = {},
): Promise<DraftResult> {
  const r = await runText(ai, "chapter", { ...ctx.slots, note }, opts);
  const content = stripLeadingHeading(r.output, ctx.title);
  const wordCount = countWords(content);
  return { content, wordCount, flags: wordFlags(wordCount, ctx.wordTarget, settings.word_tolerance), meta: r.meta };
}

export function wordFlags(wordCount: number, target: number, tolerance: number): VersionFlag[] {
  const off = (wordCount - target) / target;
  if (Math.abs(off) <= tolerance) return [];
  return [
    {
      type: "word_count",
      note: `${wordCount} words against a target of ${target} (${off > 0 ? "+" : ""}${Math.round(off * 100)} percent, tolerance ${Math.round(tolerance * 100)} percent)`,
    },
  ];
}

export async function updateSummary(
  ai: AIClient,
  input: { priorSummary: string; position: number; title: string; content: string; brief: BriefOutput },
  opts: RunOptions = {},
): Promise<{ summary: string; meta: CallMeta }> {
  const r = await runText(
    ai,
    "summary",
    {
      prior_summary: input.priorSummary.trim() || "(empty, this is the first chapter)",
      chapter_index: input.position,
      chapter_title: input.title,
      chapter_markdown: input.content,
      frameworks: input.brief.frameworks.map((f) => `- ${f.name}`).join("\n"),
    },
    opts,
  );
  return { summary: r.output, meta: r.meta };
}

/** First paragraph of a chapter body. */
export function openingParagraph(markdown: string): string {
  return (
    markdown
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .find((p) => p.length > 0 && !p.startsWith("#")) ?? ""
  );
}

/** The chapter template returns body only; drop a stray first-line heading if the model adds one. */
export function stripLeadingHeading(markdown: string, title: string): string {
  const lines = markdown.split("\n");
  const first = lines[0]?.trim() ?? "";
  const bare = first.replace(/^#{1,6}\s*/, "").replace(/[*_]/g, "").trim().toLowerCase();
  if (bare === title.toLowerCase() || /^chapter\s+\d+\b/.test(bare) || (first.startsWith("#") && bare.includes(title.toLowerCase()))) {
    return lines.slice(1).join("\n").trim();
  }
  return markdown.trim();
}
