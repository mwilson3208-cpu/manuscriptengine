import {
  sanitize,
  type BriefOutput,
  type CallMeta,
  type EditFlag,
  type EditPass,
  type GuardRevert,
  type Intensity,
  type NumberedChange,
  type OutlineOutput,
  type VoiceProfile,
} from "@me/shared";
import type { AIClient } from "./ai";
import { changedRatio, wordDiff, type DiffHunk } from "./diff";
import { anchorChanges, factGuard, voiceGuard, type AnchoredChange } from "./guards";
import { renderBrief, renderOutline, renderVoiceProfile, type OutlineMark } from "./render";
import { runJson, type RunOptions } from "./run";
import type { PipelineSettings } from "./settings";

export const PASS_TASK: Record<EditPass, string> = {
  dev: "edit-dev",
  line: "edit-line",
  copy: "edit-copy",
  proof: "edit-proof",
};

export interface PassSection {
  key: string;
  label: string;
  mark: OutlineMark;
}

export interface PassInput {
  pass: EditPass;
  intensity: Intensity;
  section: PassSection;
  content: string;
  brief: BriefOutput;
  outline: OutlineOutput;
  voice: VoiceProfile;
  styleSheet: string;
  /** Developmental pass: summary of the whole book, for repetition between chapters. */
  bookSummary?: string;
  /** Copy pass: the claim ledger rendered as text. */
  claimLedger?: string;
  /** Developmental pass: what changed in the brief after approval (needs_drift_check). */
  driftNote?: string;
  settings: Pick<PipelineSettings, "edit_cap">;
}

export type PassStatus = "applied" | "no_change" | "cap_exceeded";

export interface PassResult {
  status: PassStatus;
  /** The revised section after guards and sanitize. Present for every status so the operator can still apply it. */
  revised: string;
  changes: AnchoredChange[];
  flags: EditFlag[];
  guardReverts: GuardRevert[];
  ratio: number;
  diff: DiffHunk[];
  summary: string;
  meta: CallMeta;
}

/**
 * Run one edit pass on one section. Writes nothing: the caller stores a new
 * version and change log when status is "applied", and asks the operator when
 * status is "cap_exceeded" (CLAUDE.md non-negotiable 6).
 */
export async function runPass(ai: AIClient, input: PassInput, opts: RunOptions = {}): Promise<PassResult> {
  const slots: Record<string, string | undefined> = {
    style_sheet: input.styleSheet,
    brief: renderBrief(input.brief),
    outline: renderOutline(input.outline, input.section.mark),
    voice_profile: renderVoiceProfile(input.voice),
    section_label: input.section.label,
    chapter_markdown: input.content,
    intensity: input.intensity,
  };
  if (input.pass === "dev") {
    slots.book_summary = input.bookSummary?.trim() || "(not available)";
    slots.drift_note = input.driftNote;
  }
  if (input.pass === "copy") slots.claim_ledger = input.claimLedger?.trim() || "(empty: no claims recorded, so every claim is unverified)";

  const r = await runJson(ai, PASS_TASK[input.pass], "EditOutput", slots, opts);
  const numbered: NumberedChange[] = r.output.changes.map((c, i) => ({ ...c, n: i + 1 }));
  const anchored = anchorChanges(input.content, numbered);
  const flags: EditFlag[] = [...r.output.flags];
  const unlocated = anchored.filter((c) => !c.located);
  if (unlocated.length) {
    flags.push({ type: "change_log", location: "", note: `Changes ${unlocated.map((c) => c.n).join(", ")} quote text that is not in the section; they cannot be reverted by number` });
  }

  let revised = r.output.revised_markdown.trim();
  const voice = voiceGuard(revised, anchored, input.voice);
  revised = voice.text;
  const fact = factGuard(input.content, revised, anchored, input.brief.frameworks.map((f) => f.name));
  revised = sanitize(fact.text).text.trim();
  flags.push(...voice.flags, ...fact.flags);
  const guardReverts = [...voice.reverts, ...fact.reverts];

  const stats = changedRatio(input.content, revised);
  const status: PassStatus = revised === input.content.trim() ? "no_change" : stats.changedRatio > input.settings.edit_cap ? "cap_exceeded" : "applied";
  return {
    status,
    revised,
    changes: anchored,
    flags,
    guardReverts,
    ratio: stats.changedRatio,
    diff: wordDiff(input.content, revised),
    summary: summarize(input.pass, anchored, flags, guardReverts, stats.changedRatio),
    meta: r.meta,
  };
}

function summarize(pass: EditPass, changes: NumberedChange[], flags: EditFlag[], reverts: GuardRevert[], ratio: number): string {
  const byType = new Map<string, number>();
  for (const c of changes) byType.set(c.type, (byType.get(c.type) ?? 0) + 1);
  const types = [...byType.entries()].map(([t, n]) => `${t} ${n}`).join(", ");
  const parts = [`${pass}: ${changes.length} change${changes.length === 1 ? "" : "s"}${types ? ` (${types})` : ""}`, `${flags.length} flag${flags.length === 1 ? "" : "s"}`, `${Math.round(ratio * 100)} percent of words changed`];
  if (reverts.length) parts.push(`${reverts.length} reverted by guards`);
  return parts.join("; ");
}
