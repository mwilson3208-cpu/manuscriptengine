import { EM_DASH_CHARS, EN_DASH_CHARS } from "./sanitize";

export type TextIssueKind = "em_dash" | "en_dash" | "emoji" | "banned_term";

export interface TextIssue {
  kind: TextIssueKind;
  match: string;
  line: number;
  excerpt: string;
}

const KEEP_SYMBOLS = new Set(["©", "®", "™"]);
/** Banned-list entries that name a construction enforced by its own check, not a word. */
const CONSTRUCTION_ENTRIES = /^(em[ -]?dash(es)?|emojis?|en[ -]?dash(es)?)$/i;

/**
 * Hard QA check on final text: em dashes, en dashes, emojis, and banned terms.
 * This is the third enforcement layer after the template rules and sanitize().
 */
export function findForbidden(text: string, bannedTerms: readonly string[] = []): TextIssue[] {
  const issues: TextIssue[] = [];
  const lines = text.split("\n");
  const terms = bannedTerms.map((t) => t.trim()).filter((t) => t.length > 0 && !CONSTRUCTION_ENTRIES.test(t));
  const termRes = terms.map((t) => ({ term: t, re: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(t)}(?![\\p{L}\\p{N}])`, "giu") }));

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    for (const ch of line) {
      if (EM_DASH_CHARS.includes(ch)) issues.push({ kind: "em_dash", match: ch, line: lineNo, excerpt: excerpt(line) });
      else if (EN_DASH_CHARS.includes(ch)) issues.push({ kind: "en_dash", match: ch, line: lineNo, excerpt: excerpt(line) });
    }
    if (!/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      for (const m of line.matchAll(/(?<!-)--(?!-)/g)) {
        issues.push({ kind: "em_dash", match: m[0], line: lineNo, excerpt: excerpt(line) });
      }
    }
    for (const m of line.matchAll(/\p{Extended_Pictographic}/gu)) {
      if (!KEEP_SYMBOLS.has(m[0])) issues.push({ kind: "emoji", match: m[0], line: lineNo, excerpt: excerpt(line) });
    }
    for (const { term, re } of termRes) {
      re.lastIndex = 0;
      for (const m of line.matchAll(re)) {
        issues.push({ kind: "banned_term", match: `${term} (${m[0]})`, line: lineNo, excerpt: excerpt(line) });
      }
    }
  });
  return issues;
}

/** Word count over Markdown, ignoring syntax markers. */
export function countWords(markdown: string): number {
  const stripped = markdown
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*([-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_`]/g, " ");
  return stripped.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function excerpt(line: string): string {
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}
