import type { BriefOutput, CallMeta, MatterOutput, OutlineOutput, VoiceProfile } from "@me/shared";
import type { AIClient } from "./ai";
import { renderBrief, renderOutline, renderVoiceProfile } from "./render";
import { runJson, type RunOptions } from "./run";

export interface MatterInputs {
  brief: BriefOutput;
  outline: OutlineOutput;
  voice: VoiceProfile;
  bookSummary: string;
  companionCourseUrl?: string;
}

/** Introduction, conclusion, and Companion Course page (the `matter` template). */
export async function generateMatter(ai: AIClient, input: MatterInputs, opts: RunOptions = {}): Promise<{ matter: MatterOutput; meta: CallMeta }> {
  const r = await runJson(
    ai,
    "matter",
    "MatterOutput",
    {
      brief: renderBrief(input.brief),
      outline: renderOutline(input.outline),
      book_summary: input.bookSummary,
      voice_profile: renderVoiceProfile(input.voice),
      intro_word_target: input.outline.intro.word_target,
      conclusion_word_target: input.outline.conclusion.word_target,
      companion_course_url: input.companionCourseUrl,
    },
    opts,
  );
  return { matter: r.output, meta: r.meta };
}
