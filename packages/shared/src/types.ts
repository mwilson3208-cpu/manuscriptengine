import type { EditChange, EditFlag } from "./schemas";
import type { SanitizeReport } from "./sanitize";

/** Mirrors the version_source enum in the database schema. */
export type VersionSource = "draft" | "regen" | "manual" | "dev" | "line" | "copy" | "proof";

export const EDIT_PASSES = ["dev", "line", "copy", "proof"] as const;
export type EditPass = (typeof EDIT_PASSES)[number];

export type SectionKind = "intro" | "chapter" | "conclusion";

export interface TokenUsage {
  tokensIn: number;
  tokensOut: number;
}

/** What every AI-backed step reports back to its caller, for jobs_meta and the AI-use log. */
export interface CallMeta {
  promptVersion: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  sanitize: SanitizeReport;
  attempts: number;
}

export interface VersionFlag {
  type: string;
  note: string;
}

export interface NumberedChange extends EditChange {
  /** 1-based number, stable within one change log, used for revert by number. */
  n: number;
}

export interface GuardRevert {
  guard: "voice" | "fact";
  n: number;
  reason: string;
}

export interface ChangeLogEntry {
  id: string;
  pass: EditPass;
  sectionKey: string;
  summary: string;
  changedRatio: number;
  changes: NumberedChange[];
  flags: EditFlag[];
  guardReverts: GuardRevert[];
  fromVersionId: string;
  toVersionId: string;
  promptVersion: string;
  model: string;
  createdAt: string;
}
