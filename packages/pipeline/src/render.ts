import type { BriefOutput, OutlineOutput, VoiceProfile } from "@me/shared";

/** Which part of the outline a call is about. */
export type OutlineMark = { kind: "intro" } | { kind: "chapter"; index: number } | { kind: "conclusion" } | null;

export const CURRENT_MARK = ">>> CURRENT CHAPTER <<<";

export function renderVoiceProfile(v: VoiceProfile): string {
  const r = v.rules;
  const lines: string[] = [`Name: ${v.name} (${v.identity_type === "author" ? "real author" : "pen name"})`, `Language: ${v.language}`];
  if (r.master_voice_prompt) lines.push("", "Master voice prompt:", r.master_voice_prompt.trim());
  const rules: string[] = [];
  if (r.perspective) rules.push(`Perspective: ${r.perspective}`);
  if (r.sentence_length) rules.push(`Sentence length: ${r.sentence_length.min} to ${r.sentence_length.max} words`);
  if (r.paragraph_length) rules.push(`Paragraph length: ${r.paragraph_length}`);
  if (r.formality) rules.push(`Formality: ${r.formality}`);
  if (r.humor) rules.push(`Humor: ${r.humor}`);
  if (r.lists_vs_prose) rules.push(`Lists versus prose: ${r.lists_vs_prose}`);
  const sm = r.signature_moves;
  if (sm?.chapter_openers) rules.push(`How chapters open: ${sm.chapter_openers}`);
  if (sm?.action_steps) rules.push(`How action steps are framed: ${sm.action_steps}`);
  if (sm?.examples) rules.push(`How examples are handled: ${sm.examples}`);
  for (const n of r.notes ?? []) rules.push(n);
  if (rules.length) lines.push("", "Voice rules:", ...rules.map((x) => `- ${x}`));
  if (v.preferred_terms.length) lines.push("", `Preferred terms: ${v.preferred_terms.join("; ")}`);
  lines.push("", `Banned terms and constructions: ${["em dashes", "emojis", ...v.banned_terms].join("; ")}`);
  if (v.samples.length) {
    lines.push("", "Sample passages that show the voice:");
    v.samples.forEach((s, i) => lines.push("", `Sample ${i + 1}${s.title ? `: ${s.title}` : ""}`, s.text.trim()));
  }
  return lines.join("\n");
}

export function renderBrief(b: BriefOutput): string {
  return [
    `Title: ${b.title}`,
    `Subtitle: ${b.subtitle}`,
    `Promise: ${b.promise}`,
    `Reader job: ${b.reader_job}`,
    `Outcome by the last page: ${b.outcome}`,
    `Reader profile: ${b.reader_profile}`,
    `Positioning: ${b.positioning}`,
    `Tone and reading level: ${b.tone}`,
    "Frameworks:",
    ...b.frameworks.map((f) => `- ${f.name}: ${f.summary}`),
    "Examples, stories, and references the draft must use:",
    ...b.examples.map((e) => `- ${e}`),
  ].join("\n");
}

export function renderOutline(o: OutlineOutput, mark: OutlineMark = null): string {
  const out: string[] = [];
  const m = (on: boolean) => (on ? ` ${CURRENT_MARK}` : "");
  out.push(`Introduction${m(mark?.kind === "intro")}`, `  Promise: ${o.intro.promise}`, `  Reason to keep reading: ${o.intro.reason_to_keep_reading}`, `  Word target: ${o.intro.word_target}`);
  o.chapters.forEach((c, i) => {
    const current = mark?.kind === "chapter" && mark.index === i + 1;
    out.push(
      "",
      `Chapter ${i + 1}: ${c.title}${m(current)}`,
      `  Goal: ${c.goal}`,
      "  Key points:",
      ...c.points.map((p) => `    - ${p}`),
      `  Example: ${c.example}`,
      `  Action step: ${c.action_step}`,
      `  Word target: ${c.word_target}`,
    );
    if (c.frameworks_introduced.length) out.push(`  Introduces: ${c.frameworks_introduced.join("; ")}`);
    if (c.frameworks_used.length) out.push(`  Uses: ${c.frameworks_used.join("; ")}`);
    if (c.transition) out.push(`  Transition to next chapter: ${c.transition}`);
  });
  out.push(
    "",
    `Conclusion${m(mark?.kind === "conclusion")}`,
    `  Transformation: ${o.conclusion.transformation}`,
    `  Companion Course: ${o.conclusion.companion_course}`,
    `  Word target: ${o.conclusion.word_target}`,
  );
  return out.join("\n");
}

/**
 * The per-book style sheet, locked before the first edit pass
 * (publishing-system-v2.md, "Rules that do not move"). It holds the voice
 * rules and the term list, and every pass reads it first.
 */
export function buildStyleSheet(voice: VoiceProfile, brief: BriefOutput): string {
  const r = voice.rules;
  const lines = [`Style sheet: ${brief.title}`, "", "Voice rules"];
  if (r.perspective) lines.push(`- Perspective: ${r.perspective}`);
  if (r.sentence_length) lines.push(`- Sentence length: ${r.sentence_length.min} to ${r.sentence_length.max} words`);
  if (r.paragraph_length) lines.push(`- Paragraph length: ${r.paragraph_length}`);
  if (r.formality) lines.push(`- Formality: ${r.formality}`);
  if (r.humor) lines.push(`- Humor: ${r.humor}`);
  if (r.lists_vs_prose) lines.push(`- Lists versus prose: ${r.lists_vs_prose}`);
  lines.push(`- Tone and reading level: ${brief.tone}`);
  lines.push("- No em dashes, no en dashes, no emojis.");
  lines.push("", "Term list (exact spelling and capitalization)");
  for (const f of brief.frameworks) lines.push(`- ${f.name} (framework)`);
  for (const t of voice.preferred_terms) lines.push(`- ${t} (preferred)`);
  lines.push("", "Banned terms and constructions");
  lines.push("- em dashes", "- emojis");
  for (const t of voice.banned_terms) lines.push(`- ${t}`);
  return lines.join("\n");
}
