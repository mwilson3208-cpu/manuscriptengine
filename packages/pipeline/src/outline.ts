import { OutlineOutput, type BriefOutput, type CallMeta, type VoiceProfile } from "@me/shared";
import type { AIClient } from "./ai";
import { renderBrief, renderVoiceProfile } from "./render";
import { runJson, type RunOptions } from "./run";
import type { PipelineSettings } from "./settings";

export interface OutlineViolation {
  check: "framework_coverage" | "shared_points" | "word_total" | "example_and_action" | "schema";
  detail: string;
}

export interface OutlineInputs {
  brief: BriefOutput;
  voice: VoiceProfile;
  targetWords: number;
  settings: Pick<PipelineSettings, "chapter_min" | "chapter_max" | "similarity_threshold" | "outline_total_tolerance">;
  /** Violations from a previous attempt, fed back to the template. */
  previousViolations?: OutlineViolation[];
}

export async function generateOutline(
  ai: AIClient,
  input: OutlineInputs,
  opts: RunOptions = {},
): Promise<{ outline: OutlineOutput; violations: OutlineViolation[]; meta: CallMeta }> {
  const r = await runJson(
    ai,
    "outline",
    "OutlineOutput",
    {
      brief: renderBrief(input.brief),
      voice_profile: renderVoiceProfile(input.voice),
      target_words: input.targetWords,
      chapter_min: input.settings.chapter_min,
      chapter_max: input.settings.chapter_max,
      violations: input.previousViolations?.map((v) => `- ${v.check}: ${v.detail}`).join("\n"),
    },
    opts,
  );
  return { outline: r.output, violations: validateOutline(r.output, input.brief, input.targetWords, input.settings), meta: r.meta };
}

/**
 * The four checks before approval (SPEC.md Stage 2). Returns every violation;
 * an empty list means the outline may be approved.
 */
export function validateOutline(
  outlineInput: unknown,
  brief: BriefOutput,
  targetWords: number,
  settings: Pick<PipelineSettings, "similarity_threshold" | "outline_total_tolerance">,
): OutlineViolation[] {
  const parsed = OutlineOutput.safeParse(outlineInput);
  if (!parsed.success) return [{ check: "schema", detail: parsed.error.message }];
  const outline = parsed.data;
  const violations: OutlineViolation[] = [];

  // 1. Every brief framework appears in at least one chapter.
  for (const f of brief.frameworks) {
    const name = normalize(f.name);
    const found = outline.chapters.some(
      (c) =>
        [...c.frameworks_introduced, ...c.frameworks_used].some((x) => normalize(x) === name) ||
        normalize([c.title, c.goal, ...c.points].join(" ")).includes(name),
    );
    if (!found) violations.push({ check: "framework_coverage", detail: `Framework "${f.name}" does not appear in any chapter` });
  }

  // 2. No two chapters share more than one key point.
  for (let i = 0; i < outline.chapters.length; i++) {
    for (let j = i + 1; j < outline.chapters.length; j++) {
      const a = outline.chapters[i];
      const b = outline.chapters[j];
      if (!a || !b) continue;
      const shared: string[] = [];
      for (const pa of a.points) {
        for (const pb of b.points) {
          if (similarity(pa, pb) > settings.similarity_threshold) shared.push(`"${pa}" ~ "${pb}"`);
        }
      }
      if (shared.length > 1) {
        violations.push({ check: "shared_points", detail: `Chapters ${i + 1} and ${j + 1} share ${shared.length} key points: ${shared.join("; ")}` });
      }
    }
  }

  // 3. Word targets within tolerance of the total.
  const sum = outline.intro.word_target + outline.conclusion.word_target + outline.chapters.reduce((s, c) => s + c.word_target, 0);
  const off = Math.abs(sum - targetWords) / targetWords;
  if (off > settings.outline_total_tolerance) {
    violations.push({ check: "word_total", detail: `Word targets sum to ${sum}, ${Math.round(off * 100)} percent from the ${targetWords} total` });
  }

  // 4. Every chapter has an example and an action step.
  outline.chapters.forEach((c, i) => {
    if (!c.example.trim() || !c.action_step.trim()) {
      violations.push({ check: "example_and_action", detail: `Chapter ${i + 1} is missing ${!c.example.trim() ? "an example" : "an action step"}` });
    }
  });

  return violations;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Sorensen-Dice similarity over character bigrams of normalized text, 0 to 1. */
export function similarity(a: string, b: string): number {
  const x = normalize(a);
  const y = normalize(b);
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const gx = grams(x);
  const gy = grams(y);
  let overlap = 0;
  for (const [g, n] of gx) overlap += Math.min(n, gy.get(g) ?? 0);
  return (2 * overlap) / (x.length - 1 + (y.length - 1));
}
