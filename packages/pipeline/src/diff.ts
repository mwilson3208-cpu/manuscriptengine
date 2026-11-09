import { diffWords } from "diff";

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'-]*/gu;

function words(s: string): number {
  return s.match(WORD_RE)?.length ?? 0;
}

export interface WordDiffStats {
  originalWords: number;
  removedWords: number;
  addedWords: number;
  /** max(removed, added) / original words. 0 when nothing changed, 1 or more for a full rewrite. */
  changedRatio: number;
}

/**
 * Word-level change ratio used by the 40 percent cap (CLAUDE.md non-negotiable 6).
 * A 15 percent cut scores 0.15; replacing every word scores 1.0. See docs/DECISIONS.md.
 */
export function changedRatio(before: string, after: string): WordDiffStats {
  const originalWords = words(before);
  let removedWords = 0;
  let addedWords = 0;
  for (const part of diffWords(before, after)) {
    if (part.added) addedWords += words(part.value);
    else if (part.removed) removedWords += words(part.value);
  }
  const changed = Math.max(removedWords, addedWords);
  return { originalWords, removedWords, addedWords, changedRatio: originalWords === 0 ? (changed > 0 ? 1 : 0) : changed / originalWords };
}

export interface DiffHunk {
  op: "add" | "del" | "eq";
  text: string;
}

/** Compact word-level diff for change logs: unchanged runs are trimmed to a little context. */
export function wordDiff(before: string, after: string, context = 8): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  for (const part of diffWords(before, after)) {
    if (part.added) hunks.push({ op: "add", text: part.value });
    else if (part.removed) hunks.push({ op: "del", text: part.value });
    else {
      const ws = part.value.split(/(\s+)/);
      const tokens = ws.filter((t) => t.trim().length > 0);
      if (tokens.length <= context * 2) hunks.push({ op: "eq", text: part.value });
      else {
        const head = tokens.slice(0, context).join(" ");
        const tail = tokens.slice(-context).join(" ");
        hunks.push({ op: "eq", text: `${hunks.length ? `${head} ` : ""}[...] ${tail} ` });
      }
    }
  }
  return hunks;
}
