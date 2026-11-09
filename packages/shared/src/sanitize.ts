/**
 * Post-generation sanitizer. Every text output from the AI passes through
 * sanitize() before it is stored. See CLAUDE.md "Post-processing".
 *
 * - Em and en dashes become a comma, period, or colon by context
 *   (numeric ranges become "to"; see docs/DECISIONS.md).
 * - Emojis are stripped. Copyright, registered, and trademark signs are kept.
 * - Curly quotes are normalized to straight quotes (Pandoc curls them on export).
 * - Three or more consecutive newlines collapse to one blank line.
 */

export interface SanitizeReport {
  emDashes: number;
  enDashes: number;
  emojis: number;
  quotes: number;
  blankLines: number;
  total: number;
}

export interface SanitizeResult {
  text: string;
  report: SanitizeReport;
}

/** Characters treated as an em dash: em dash, horizontal bar, two- and three-em dashes. */
export const EM_DASH_CHARS = "\u2014\u2015\u2E3A\u2E3B";
/** Characters treated as an en dash: en dash, figure dash. */
export const EN_DASH_CHARS = "\u2013\u2012";

const DASH_CLASS = `[${EM_DASH_CHARS}${EN_DASH_CHARS}]`;
const KEEP_SYMBOLS = new Set(["\u00A9", "\u00AE", "\u2122"]);
const EMOJI_RE = /\p{Extended_Pictographic}/gu;
const EMOJI_PARTS_RE = /[\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}\u{E0020}-\u{E007F}\uFE0F\u200D\u20E3]/gu;

const THEMATIC_BREAK_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEPARATOR_RE = /^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-*:?\s*$/;

export function emptyReport(): SanitizeReport {
  return { emDashes: 0, enDashes: 0, emojis: 0, quotes: 0, blankLines: 0, total: 0 };
}

export function sanitize(input: string): SanitizeResult {
  const report = emptyReport();
  let text = input.replace(/\r\n?/g, "\n");

  // Quotes
  text = text.replace(/[\u201C\u201D\u201E\u201F\u2033]/g, () => {
    report.quotes++;
    return '"';
  });
  text = text.replace(/[\u2018\u2019\u201A\u201B\u2032]/g, () => {
    report.quotes++;
    return "'";
  });

  const lines = text.split("\n").map((line) => {
    let out = stripEmojis(line, report);
    if (!THEMATIC_BREAK_RE.test(out) && !TABLE_SEPARATOR_RE.test(out)) {
      out = replaceDashes(out, report);
    }
    return out.replace(/[ \t]+$/, "");
  });
  text = lines.join("\n");

  text = text.replace(/\n{3,}/g, () => {
    report.blankLines++;
    return "\n\n";
  });

  report.total = report.emDashes + report.enDashes + report.emojis + report.quotes + report.blankLines;
  return { text, report };
}

/** Sanitize every string inside a JSON-like value. Reports are summed. */
export function sanitizeDeep<T>(value: T, report: SanitizeReport = emptyReport()): { value: T; report: SanitizeReport } {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = sanitize(v);
      addReports(report, r.report);
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return { value: walk(value) as T, report };
}

export function addReports(into: SanitizeReport, add: SanitizeReport): SanitizeReport {
  into.emDashes += add.emDashes;
  into.enDashes += add.enDashes;
  into.emojis += add.emojis;
  into.quotes += add.quotes;
  into.blankLines += add.blankLines;
  into.total += add.total;
  return into;
}

function stripEmojis(line: string, report: SanitizeReport): string {
  let removed = 0;
  let out = line.replace(EMOJI_RE, (m) => {
    if (KEEP_SYMBOLS.has(m)) return m;
    removed++;
    return "";
  });
  out = out.replace(EMOJI_PARTS_RE, () => "");
  if (removed > 0) {
    report.emojis += removed;
    out = out.replace(/(\S)[ \t]{2,}(?=\S)/g, "$1 ").replace(/[ \t]+([.,;:!?])/g, "$1");
  }
  return out;
}

function replaceDashes(line: string, report: SanitizeReport): string {
  let out = line;

  // Numeric ranges: 10, en dash, 20 becomes "10 to 20".
  out = out.replace(new RegExp(`(\\d)\\s*(${DASH_CLASS})\\s*(?=\\d)`, "g"), (_m, d: string, dash: string) => {
    countDash(dash, report);
    return `${d} to `;
  });

  // ASCII stand-ins: "--" (not part of a longer run) and a spaced hyphen between words.
  // They are converted to an em dash here and counted with the real dashes below.
  out = out.replace(/(?<=\S)\s?(?<!-)--(?!-)\s?(?=\S)/g, "\u2014");
  out = out.replace(/(?<=\S) - (?=\S)/g, "\u2014");

  const parts = out.split(new RegExp(`(\\s*${DASH_CLASS}\\s*)`));
  if (parts.length === 1) return out;

  let result = parts[0] ?? "";
  for (let i = 1; i < parts.length; i += 2) {
    const dash = (parts[i] ?? "").trim();
    const after = parts[i + 1] ?? "";
    countDash(dash, report);

    const before = result.replace(/\s+$/, "");
    const sentenceEndsInAfter = /[.!?]["')\]]?(\s|$)/.test(after);
    const nextIsDash = i + 2 < parts.length;

    if (before.length === 0) {
      // Dash at the start of the line (for example an attribution): drop it.
      result = after.replace(/^\s+/, "");
      continue;
    }
    if (after.trim().length === 0) {
      result = before;
      continue;
    }
    if (nextIsDash && !sentenceEndsInAfter) {
      // Paired dashes around an aside become commas.
      countDash((parts[i + 2] ?? "").trim(), report);
      const afterClose = parts[i + 3] ?? "";
      const close = /^\s*[.,;:!?)]/.test(afterClose) || afterClose.trim().length === 0 ? "" : ", ";
      result = `${joinPunct(before, ",")} ${after.trim()}${close}${afterClose.replace(/^\s+/, "")}`;
      i += 2;
      continue;
    }
    const firstWord = after.trim().split(/\s+/)[0] ?? "";
    const restOfSentence = after.trim().split(/(?<=[.!?])\s/)[0] ?? "";
    const wordsInRest = restOfSentence.split(/\s+/).filter(Boolean).length;
    if (/^[A-Z]/.test(firstWord) && firstWord !== "I" && !/^I'/.test(firstWord) && wordsInRest > 4) {
      result = `${joinPunct(before, ".")} ${after.trim()}`;
    } else if (wordsInRest <= 4) {
      result = `${joinPunct(before, ":")} ${after.trim()}`;
    } else {
      result = `${joinPunct(before, ",")} ${after.trim()}`;
    }
  }
  return result;
}

function joinPunct(before: string, punct: string): string {
  if (/[.,;:!?]$/.test(before)) return before;
  return before + punct;
}

function countDash(dash: string, report: SanitizeReport): void {
  if (EN_DASH_CHARS.includes(dash)) report.enDashes++;
  else report.emDashes++;
}
