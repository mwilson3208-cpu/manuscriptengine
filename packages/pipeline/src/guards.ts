import { escapeRe, type EditFlag, type GuardRevert, type NumberedChange, type VoiceProfile } from "@me/shared";

/**
 * The two guards that run after every edit pass
 * (publishing-system-v2.md, "Two guards after every pass").
 *
 * Voice guard: reverts edits that flatten the author: sentences longer than the
 * author writes, and vocabulary the profile bans (the operator lists hedging and
 * generic coaching phrases there). Em dashes are removed by sanitize() before
 * the guard runs, so they can never survive a pass.
 *
 * Fact guard: confirms every number, name, date, and framework name in the
 * original survived. A change that dropped one is reverted; when the change
 * cannot be located for revert, a flag goes to the operator.
 */

export interface AnchoredChange extends NumberedChange {
  /** Text before the change in the original section, used to revert pure cuts. */
  prefix: string;
  /** Text after the change in the original section. */
  suffix: string;
  /** False when `before` was not found in the original section. */
  located: boolean;
}

export function anchorChanges(original: string, changes: NumberedChange[], width = 60): AnchoredChange[] {
  return changes.map((c) => {
    const at = c.before ? original.indexOf(c.before) : -1;
    if (at < 0) return { ...c, prefix: "", suffix: "", located: false };
    return {
      ...c,
      prefix: original.slice(Math.max(0, at - width), at),
      suffix: original.slice(at + c.before.length, at + c.before.length + width),
      located: true,
    };
  });
}

/** Undo one change in `text`. Returns null when the change cannot be located. */
export function revertChange(text: string, change: Pick<AnchoredChange, "before" | "after" | "prefix" | "suffix">): string | null {
  if (change.after) {
    const at = locate(text, change.after, change.prefix);
    if (at < 0) return null;
    return text.slice(0, at) + change.before + text.slice(at + change.after.length);
  }
  // A pure cut: re-insert `before` at its anchor, trying shorter anchors when nearby text also changed.
  for (const n of [60, 40, 24, 12]) {
    const prefix = change.prefix.slice(-n);
    if (prefix) {
      const at = text.indexOf(prefix);
      if (at >= 0 && text.indexOf(prefix, at + 1) < 0) {
        const pos = at + prefix.length;
        return text.slice(0, pos) + change.before + text.slice(pos);
      }
    }
    const suffix = change.suffix.slice(0, n);
    if (suffix) {
      const at = text.indexOf(suffix);
      if (at >= 0 && text.indexOf(suffix, at + 1) < 0) return text.slice(0, at) + change.before + text.slice(at);
    }
  }
  return null;
}

/** Index of `needle` in `text`; when it occurs more than once, prefer the occurrence that follows `prefix`. */
function locate(text: string, needle: string, prefix: string): number {
  const first = text.indexOf(needle);
  if (first < 0 || text.indexOf(needle, first + 1) < 0) return first;
  for (const k of [24, 12, 6]) {
    const p = prefix.slice(-k);
    if (!p) continue;
    for (let at = first; at >= 0; at = text.indexOf(needle, at + 1)) {
      if (text.slice(Math.max(0, at - p.length), at) === p) return at;
    }
  }
  return first;
}

export function splitSentences(text: string): string[] {
  return text
    .replace(/^#{1,6}\s.*$/gm, "")
    .split(/(?<=[.!?]["')\]]?)\s+|\n\s*\n/)
    .map((s) => s.trim())
    .filter((s) => /\p{L}/u.test(s));
}

function sentenceWords(s: string): number {
  return s.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu)?.length ?? 0;
}

function longestSentence(text: string): number {
  return Math.max(0, ...splitSentences(text).map(sentenceWords));
}

/** Longest sentence the author writes: the profile's max, else the 95th percentile of the sample passages. */
export function authorMaxSentence(voice: VoiceProfile): number | null {
  if (voice.rules.sentence_length?.max) return voice.rules.sentence_length.max;
  const lengths = voice.samples.flatMap((s) => splitSentences(s.text).map(sentenceWords)).sort((a, b) => a - b);
  if (lengths.length < 10) return null;
  return lengths[Math.min(lengths.length - 1, Math.floor(lengths.length * 0.95))] ?? null;
}

function bannedIn(text: string, banned: string[]): string[] {
  return banned.filter((t) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(t)}(?![\\p{L}\\p{N}])`, "iu").test(text));
}

export interface GuardResult {
  text: string;
  reverts: GuardRevert[];
  flags: EditFlag[];
}

export function voiceGuard(text: string, changes: AnchoredChange[], voice: VoiceProfile): GuardResult {
  const maxSentence = authorMaxSentence(voice);
  const banned = voice.banned_terms.filter((t) => t.trim() && !/^(em[ -]?dash(es)?|emojis?|en[ -]?dash(es)?)$/i.test(t.trim()));
  const reverts: GuardRevert[] = [];
  const flags: EditFlag[] = [];
  let out = text;
  for (const c of changes) {
    if (!c.after) continue;
    const reasons: string[] = [];
    const introduced = bannedIn(c.after, banned).filter((t) => !bannedIn(c.before, [t]).length);
    if (introduced.length) reasons.push(`introduced banned term: ${introduced.join(", ")}`);
    if (maxSentence !== null) {
      const longest = longestSentence(c.after);
      if (longest > maxSentence && longest > longestSentence(c.before)) reasons.push(`sentence of ${longest} words is longer than the author writes (${maxSentence})`);
    }
    if (!reasons.length) continue;
    const reverted = revertChange(out, c);
    if (reverted !== null) {
      out = reverted;
      reverts.push({ guard: "voice", n: c.n, reason: reasons.join("; ") });
    } else {
      flags.push({ type: "voice", location: c.location, note: `Change ${c.n} could not be reverted automatically: ${reasons.join("; ")}` });
    }
  }
  return { text: out, reverts, flags };
}

/** Numbers, dates, and capitalized names inside a text. */
export function extractFacts(text: string, extraNames: string[] = []): Set<string> {
  const facts = new Set<string>();
  const body = text.replace(/^#{1,6}\s.*$/gm, "");
  for (const m of body.matchAll(/\$?\d[\d,]*(?:\.\d+)?%?/g)) facts.add(m[0].replace(/[.,]$/, ""));
  for (const m of body.matchAll(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/g)) facts.add(m[0]);
  // Capitalized words that do not start a sentence or a line.
  for (const m of body.matchAll(/(?<=[\p{L}\p{N},;:)] )\p{Lu}[\p{L}'-]+(?: \p{Lu}[\p{L}'-]+)*/gu)) {
    if (m[0] !== "I" && !/^I'/.test(m[0])) facts.add(m[0]);
  }
  for (const n of extraNames) if (n && body.includes(n)) facts.add(n);
  return facts;
}

export function factGuard(original: string, text: string, changes: AnchoredChange[], frameworkNames: string[]): GuardResult {
  const reverts: GuardRevert[] = [];
  const flags: EditFlag[] = [];
  let out = text;
  const before = extractFacts(original, frameworkNames);
  const missing = () => [...before].filter((f) => !out.includes(f));
  const done = new Set<number>();
  for (const fact of missing()) {
    if (out.includes(fact)) continue; // restored by an earlier revert
    const culprit = changes.find((c) => !done.has(c.n) && c.before.includes(fact) && !c.after.includes(fact));
    const reverted = culprit ? revertChange(out, culprit) : null;
    if (culprit && reverted !== null) {
      out = reverted;
      done.add(culprit.n);
      reverts.push({ guard: "fact", n: culprit.n, reason: `removed "${fact}"` });
    } else {
      flags.push({ type: "fact", location: culprit?.location ?? "", note: `"${fact}" was in the section before this pass and is missing after it` });
    }
  }
  return { text: out, reverts, flags };
}
