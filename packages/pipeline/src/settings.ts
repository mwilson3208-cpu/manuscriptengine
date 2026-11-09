import type { ModelSettings } from "./ai";

export interface PipelineSettings extends ModelSettings {
  chapter_min: number;
  chapter_max: number;
  /** Chapter word-count tolerance, as a fraction. SPEC: plus or minus 10 percent. */
  word_tolerance: number;
  /** Outline word targets must sum to within this fraction of the total. SPEC: 10 percent. */
  outline_total_tolerance: number;
  /** Edit pass change cap, as a fraction. CLAUDE.md non-negotiable 6: 40 percent. */
  edit_cap: number;
  /** Key-point similarity above which two points count as shared. CLAUDE.md: 0.85. */
  similarity_threshold: number;
  /** Running summary cap in words. SPEC: 1,500. */
  summary_word_cap: number;
}

export const DEFAULT_SETTINGS: PipelineSettings = {
  models: { sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" },
  task_models: {},
  effort: null,
  refusal_fallback: true,
  chapter_min: 8,
  chapter_max: 12,
  word_tolerance: 0.1,
  outline_total_tolerance: 0.1,
  edit_cap: 0.4,
  similarity_threshold: 0.85,
  summary_word_cap: 1500,
};

export function taskModelKey(settings: ModelSettings, task: string): string | undefined {
  return settings.task_models?.[task];
}
