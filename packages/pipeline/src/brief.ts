import type { BookInput, BriefOutput, CallMeta, VoiceProfile } from "@me/shared";
import type { AIClient } from "./ai";
import { renderVoiceProfile } from "./render";
import { runJson, type RunOptions } from "./run";

export interface BriefInputs {
  book: Pick<BookInput, "working_title" | "seed_description" | "lane" | "language" | "target_words" | "author_name" | "title_id">;
  voice: VoiceProfile;
  materials: BookInput["materials"];
  /** Stage 0 evidence when the book was started from a candidate. */
  candidateEvidence?: string;
}

export async function generateBrief(ai: AIClient, input: BriefInputs, opts: RunOptions = {}): Promise<{ brief: BriefOutput; meta: CallMeta }> {
  const b = input.book;
  const book = [
    `Working title: ${b.working_title}`,
    b.title_id ? `Title ID: ${b.title_id}` : "",
    `Seed description: ${b.seed_description || "(none)"}`,
    `Lane: ${b.lane}`,
    `Language: ${b.language}`,
    `Target words: ${b.target_words}`,
    `Author name on the cover: ${b.author_name}`,
  ]
    .filter(Boolean)
    .join("\n");
  const m = input.materials;
  const materials = [
    "Examples and stories from the operator:",
    ...(m.examples.length ? m.examples.map((e) => `- ${e}`) : ["- (none supplied)"]),
    "Reader language (phrases real readers use):",
    ...(m.reader_language.length ? m.reader_language.map((e) => `- ${e}`) : ["- (none supplied)"]),
    `Competitor notes: ${m.competitor_notes || "(none supplied)"}`,
    `Other notes: ${m.notes || "(none)"}`,
  ].join("\n");

  const r = await runJson(ai, "brief", "BriefOutput", { book, voice_profile: renderVoiceProfile(input.voice), materials, candidate_evidence: input.candidateEvidence }, opts);
  return { brief: r.output, meta: r.meta };
}
