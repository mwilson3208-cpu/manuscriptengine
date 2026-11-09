import { z } from "zod";

/* ------------------------------------------------------------------ */
/* AI output contracts. Template front matter names these by key.      */
/* ------------------------------------------------------------------ */

export const Framework = z.object({
  name: z.string().min(1),
  summary: z.string().min(1),
});
export type Framework = z.infer<typeof Framework>;

export const BriefOutput = z.object({
  title: z.string().min(1),
  subtitle: z.string().min(1),
  promise: z.string().min(1),
  reader_profile: z.string().min(1),
  positioning: z.string().min(1),
  frameworks: z.array(Framework).min(3).max(5),
  tone: z.string().min(1),
  // Fields required by the SOP Stage 2 spec and Gate 2. See docs/DECISIONS.md.
  reader_job: z.string().min(1),
  outcome: z.string().min(1),
  examples: z.array(z.string().min(1)).min(1),
});
export type BriefOutput = z.infer<typeof BriefOutput>;

export const OutlineChapter = z.object({
  title: z.string().min(1),
  goal: z.string().min(1),
  points: z.array(z.string().min(1)).min(3).max(5),
  example: z.string().min(1),
  action_step: z.string().min(1),
  word_target: z.number().int().positive(),
  frameworks_introduced: z.array(z.string()).default([]),
  frameworks_used: z.array(z.string()).default([]),
  transition: z.string().default(""),
});
export type OutlineChapter = z.infer<typeof OutlineChapter>;

export const OutlineOutput = z.object({
  intro: z.object({
    promise: z.string().min(1),
    reason_to_keep_reading: z.string().min(1),
    word_target: z.number().int().positive(),
  }),
  chapters: z.array(OutlineChapter).min(1),
  conclusion: z.object({
    transformation: z.string().min(1),
    companion_course: z.string().min(1),
    word_target: z.number().int().positive(),
  }),
});
export type OutlineOutput = z.infer<typeof OutlineOutput>;

export const EditChange = z.object({
  type: z.string().min(1),
  location: z.string().default(""),
  before: z.string(),
  after: z.string(),
  reason: z.string().default(""),
});
export type EditChange = z.infer<typeof EditChange>;

export const EditFlag = z.object({
  type: z.string().min(1),
  location: z.string().default(""),
  note: z.string().min(1),
});
export type EditFlag = z.infer<typeof EditFlag>;

export const EditOutput = z.object({
  revised_markdown: z.string().min(1),
  changes: z.array(EditChange).default([]),
  flags: z.array(EditFlag).default([]),
});
export type EditOutput = z.infer<typeof EditOutput>;

export const PainQueriesOutput = z.object({
  queries: z.array(z.string().min(1)).min(5).max(8),
});
export type PainQueriesOutput = z.infer<typeof PainQueriesOutput>;

export const MetadataOutput = z.object({
  description_html: z.string().min(1).max(3999),
  keywords: z.array(z.string().min(1).max(49)).length(7),
  categories: z.array(z.string().min(1)).length(2),
  back_cover: z.string().min(1),
  price_print: z.number().positive(),
  price_ebook: z.number().positive(),
});
export type MetadataOutput = z.infer<typeof MetadataOutput>;

export const MatterOutput = z.object({
  introduction_markdown: z.string().min(1),
  conclusion_markdown: z.string().min(1),
  companion_course_markdown: z.string().min(1),
});
export type MatterOutput = z.infer<typeof MatterOutput>;

export const schemas = {
  BriefOutput,
  OutlineOutput,
  EditOutput,
  PainQueriesOutput,
  MetadataOutput,
  MatterOutput,
} as const;
export type SchemaName = keyof typeof schemas;

export function isSchemaName(name: string): name is SchemaName {
  return Object.prototype.hasOwnProperty.call(schemas, name);
}

/* ------------------------------------------------------------------ */
/* Operator inputs.                                                    */
/* ------------------------------------------------------------------ */

export const VoiceRules = z
  .object({
    perspective: z.string().optional(),
    sentence_length: z.object({ min: z.number().int().positive(), max: z.number().int().positive() }).optional(),
    paragraph_length: z.string().optional(),
    formality: z.string().optional(),
    humor: z.string().optional(),
    lists_vs_prose: z.string().optional(),
    signature_moves: z
      .object({
        chapter_openers: z.string().optional(),
        action_steps: z.string().optional(),
        examples: z.string().optional(),
      })
      .partial()
      .optional(),
    master_voice_prompt: z.string().optional(),
    notes: z.array(z.string()).optional(),
  })
  .passthrough();
export type VoiceRules = z.infer<typeof VoiceRules>;

export const VoiceProfile = z.object({
  name: z.string().min(1),
  identity_type: z.enum(["author", "pen_name"]),
  bio_short: z.string().default(""),
  bio_long: z.string().default(""),
  rules: VoiceRules.default({}),
  preferred_terms: z.array(z.string()).default([]),
  banned_terms: z.array(z.string()).default([]),
  samples: z.array(z.object({ title: z.string().default(""), text: z.string().min(1) })).default([]),
  language: z.string().default("en"),
});
export type VoiceProfile = z.infer<typeof VoiceProfile>;

export const Intensity = z.enum(["light", "standard", "deep"]);
export type Intensity = z.infer<typeof Intensity>;

export const DraftingSource = z.enum(["ai_drafted", "voice_first"]);
export type DraftingSource = z.infer<typeof DraftingSource>;

/** The Phase 0 book input file. */
export const BookInput = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
  title_id: z.string().optional(),
  working_title: z.string().min(1),
  seed_description: z.string().default(""),
  lane: z.string().min(1),
  language: z.string().default("en"),
  author_name: z.string().min(1),
  imprint: z.string().default("Power Reads Publishing"),
  target_words: z.number().int().positive().default(25000),
  drafting_source: DraftingSource.default("ai_drafted"),
  intensity: Intensity.default("standard"),
  companion_course_url: z.string().default(""),
  voice_profile: z.union([z.string(), VoiceProfile]),
  /** A finished brief. When present the brief template is skipped and this brief is treated as approved. */
  brief: BriefOutput.optional(),
  /** Operator material the brief must carry: real examples, stories, reader language. */
  materials: z
    .object({
      examples: z.array(z.string()).default([]),
      reader_language: z.array(z.string()).default([]),
      competitor_notes: z.string().default(""),
      notes: z.string().default(""),
    })
    .default({ examples: [], reader_language: [], competitor_notes: "", notes: "" }),
});
export type BookInput = z.infer<typeof BookInput>;
