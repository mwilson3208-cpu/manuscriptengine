import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildManuscriptMarkdown, renderDocx, type ManuscriptSection } from "@me/export";
import {
  buildChapterContext,
  buildStyleSheet,
  draftChapter,
  extractClaims,
  generateBrief,
  generateMatter,
  generateOutline,
  mergeClaims,
  openingParagraph,
  renderClaimLedger,
  revertChange,
  runPass,
  taskModelKey,
  updateSummary,
  validateOutline,
  wordFlags,
  PASS_TASK,
  type AIClient,
  type Claim,
  type PassResult,
  type PipelineSettings,
  type RunOptions,
} from "@me/pipeline";
import {
  BookInput,
  BriefOutput,
  countWords,
  EDIT_PASSES,
  emptyReport,
  findForbidden,
  OutlineOutput,
  sanitize,
  VoiceProfile,
  type CallMeta,
  type EditPass,
  type TextIssue,
} from "@me/shared";
import {
  addVersion,
  BookStore,
  chapterKey,
  currentVersion,
  newId,
  now,
  section,
  type BookState,
  type SectionState,
  type StoredChangeLog,
} from "./book-state";

export type CapDecision = "apply" | "skip" | "stop";

export interface Operator {
  log(message: string): void;
  capDecision(info: { pass: EditPass; sectionKey: string; title: string; ratio: number; summary: string }): Promise<CapDecision>;
}

export interface RunConfig {
  ai: AIClient;
  settings: PipelineSettings;
  operator: Operator;
  /** Approve the brief and outline automatically when they have no violations. */
  autoApprove?: boolean;
  passes?: EditPass[];
  /** Base retry backoff in ms. Tests set 0. */
  backoffMs?: number;
}

export type RunStage = "brief_review" | "outline_review" | "waiting_operator" | "qa_failed" | "done";

export interface RunOutcome {
  stage: RunStage;
  message: string;
  docxPath?: string;
}

/* ------------------------------------------------------------------ */
/* Creating a book                                                     */
/* ------------------------------------------------------------------ */

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Read a book input file, resolve its voice profile, and create the book directory. */
export function initBook(inputPath: string, outRoot: string): BookStore {
  const raw = JSON.parse(readFileSync(inputPath, "utf8")) as unknown;
  const input = BookInput.parse(raw);
  const voice =
    typeof input.voice_profile === "string"
      ? VoiceProfile.parse(JSON.parse(readFileSync(resolve(dirname(inputPath), input.voice_profile), "utf8")))
      : input.voice_profile;
  const slug = input.slug ?? slugify(input.working_title);
  const store = new BookStore(join(outRoot, slug));
  if (store.exists()) return store;

  const { voice_profile: _v, brief, ...rest } = input;
  const state: BookState = {
    schema: 1,
    slug,
    createdAt: now(),
    input: rest,
    voice,
    brief: brief ? { data: brief, status: "approved", lockedAt: now(), promptVersion: null, approvedSnapshot: brief } : null,
    outline: null,
    sections: [],
    runningSummary: "",
    needsDriftCheck: false,
    driftNote: "",
    claims: [],
    styleSheet: null,
    passUnits: [],
    changeLogs: [],
    pending: null,
    aiLog: [],
    summaries: [],
  };
  store.save(state);
  store.write("input.json", JSON.stringify(raw, null, 2));
  if (brief) store.write("brief.json", JSON.stringify(brief, null, 2));
  return store;
}

/* ------------------------------------------------------------------ */
/* Running                                                             */
/* ------------------------------------------------------------------ */

/** Run every stage that is not yet done, stopping at each operator gate. Safe to rerun. */
export async function runBook(store: BookStore, cfg: RunConfig): Promise<RunOutcome> {
  const state = store.load();
  const log = cfg.operator.log;

  if (state.pending) {
    return { stage: "waiting_operator", message: pendingMessage(state) };
  }

  // Stage 1: brief
  if (!state.brief) {
    log("Generating brief");
    const { brief, meta } = await generateBrief(cfg.ai, { book: state.input, voice: state.voice, materials: state.input.materials }, opts(cfg, "brief"));
    record(state, meta, "brief", null, null, "assisted");
    state.brief = { data: brief, status: "draft", lockedAt: null, promptVersion: meta.promptVersion, approvedSnapshot: null };
    store.write("brief.json", JSON.stringify(brief, null, 2));
    store.save(state);
  }
  if (state.brief.status === "draft") {
    if (!cfg.autoApprove) return { stage: "brief_review", message: `Review ${store.path("brief.json")}, edit it if needed, then run: pnpm phase0 approve ${store.dir} brief` };
    approveIn(store, state, "brief", cfg.settings, false);
  }

  // Stage 2: outline
  if (!state.outline) {
    const brief = state.brief.data;
    let attempt = await generateOutline(cfg.ai, { brief, voice: state.voice, targetWords: state.input.target_words, settings: cfg.settings }, opts(cfg, "outline"));
    record(state, attempt.meta, "outline", null, null, "assisted");
    if (attempt.violations.length) {
      log(`Outline has ${attempt.violations.length} violation(s); regenerating once with them noted`);
      attempt = await generateOutline(
        cfg.ai,
        { brief, voice: state.voice, targetWords: state.input.target_words, settings: cfg.settings, previousViolations: attempt.violations },
        opts(cfg, "outline"),
      );
      record(state, attempt.meta, "outline", null, null, "assisted");
    }
    state.outline = {
      data: attempt.outline,
      status: "draft",
      lockedAt: null,
      promptVersion: attempt.meta.promptVersion,
      approvedSnapshot: null,
      violations: attempt.violations.map((v) => `${v.check}: ${v.detail}`),
    };
    store.write("outline.json", JSON.stringify(attempt.outline, null, 2));
    store.write("outline-violations.txt", state.outline.violations.join("\n") || "No violations.");
    store.save(state);
  }
  if (state.outline.status === "draft") {
    if (!cfg.autoApprove || state.outline.violations.length) {
      const v = state.outline.violations;
      return {
        stage: "outline_review",
        message: `${v.length ? `Outline has ${v.length} violation(s):\n  ${v.join("\n  ")}\n` : ""}Review ${store.path("outline.json")}, edit it if needed, then run: pnpm phase0 approve ${store.dir} outline`,
      };
    }
    approveIn(store, state, "outline", cfg.settings, false);
  }

  // Stage 3: draft chapters in order
  const brief = state.brief.data;
  const outline = state.outline.data;
  const chapters = state.sections.filter((s) => s.kind === "chapter").sort((a, b) => a.position - b.position);
  for (const ch of chapters) {
    if (ch.versions.length > 0) continue;
    await ensureSummaries(store, state, cfg, ch.position - 1);
    const prev = chapters.find((c) => c.position === ch.position - 1);
    const prevVersion = prev ? currentVersion(prev) : null;
    log(`Drafting chapter ${ch.position}: ${ch.title}`);
    const ctx = buildChapterContext({
      brief,
      outline,
      voice: state.voice,
      position: ch.position,
      priorSummary: summaryAt(state, ch.position - 1),
      ...(prevVersion ? { previousOpening: openingParagraph(prevVersion.content) } : {}),
    });
    const r = await draftChapter(cfg.ai, ctx, cfg.settings, undefined, opts(cfg, "chapter"));
    record(state, r.meta, "chapter", null, ch.key, aiDraftUse(state));
    addVersion(store, ch, { content: r.content, source: "draft", note: "", wordCount: r.wordCount, promptVersion: r.meta.promptVersion, model: r.meta.model, flags: r.flags });
    if (r.meta.sanitize.total > 0) log(`  sanitizer replaced ${r.meta.sanitize.total} item(s) (em ${r.meta.sanitize.emDashes}, en ${r.meta.sanitize.enDashes}, emoji ${r.meta.sanitize.emojis})`);
    store.save(state);
    await ensureSummaries(store, state, cfg, ch.position);
  }

  // Introduction, conclusion, Companion Course page
  const intro = section(state, "intro");
  const conclusion = section(state, "conclusion");
  const course = section(state, "course");
  if (!intro.versions.length || !conclusion.versions.length || !course.versions.length) {
    await ensureSummaries(store, state, cfg, chapters.length);
    log("Writing introduction, conclusion, and Companion Course page");
    const { matter, meta } = await generateMatter(
      cfg.ai,
      { brief, outline, voice: state.voice, bookSummary: summaryAt(state, chapters.length), companionCourseUrl: state.input.companion_course_url },
      opts(cfg, "matter"),
    );
    record(state, meta, "matter", null, "intro+conclusion+course", aiDraftUse(state));
    const add = (s: SectionState, content: string) => {
      if (s.versions.length) return;
      const wc = countWords(content);
      addVersion(store, s, { content, source: "draft", note: "", wordCount: wc, promptVersion: meta.promptVersion, model: meta.model, flags: s.kind === "page" ? [] : wordFlags(wc, s.wordTarget, cfg.settings.word_tolerance) });
    };
    add(intro, matter.introduction_markdown);
    add(conclusion, matter.conclusion_markdown);
    add(course, matter.companion_course_markdown);
    store.save(state);
  }

  // Claim ledger and style sheet, both before the first edit pass
  refreshClaims(store, state);
  if (!state.styleSheet) {
    const text = store.read("style-sheet.md") ?? buildStyleSheet(state.voice, brief);
    state.styleSheet = { text, lockedAt: now() };
    store.write("style-sheet.md", text);
    store.save(state);
    log("Style sheet locked");
  }

  // Stage 4: edit passes in fixed order
  const passes = EDIT_PASSES.filter((p) => (cfg.passes ?? [...EDIT_PASSES]).includes(p));
  for (const pass of passes) {
    if (pass === "copy") refreshClaims(store, state);
    for (const s of orderedSections(state)) {
      if (state.passUnits.some((u) => u.pass === pass && u.sectionKey === s.key)) continue;
      if (s.kind === "page" && (pass === "dev" || pass === "line")) continue;
      if (s.pinned || s.final) {
        state.passUnits.push({ pass, sectionKey: s.key, status: "skipped_final", logId: null, at: now() });
        store.save(state);
        continue;
      }
      const v = currentVersion(s);
      if (!v) throw new Error(`Section ${s.key} has no version`);
      log(`${pass} pass: ${label(s)}`);
      const result = await runPass(
        cfg.ai,
        {
          pass,
          intensity: state.input.intensity,
          section: { key: s.key, label: label(s), mark: mark(s) },
          content: v.content,
          brief,
          outline,
          voice: state.voice,
          styleSheet: state.styleSheet.text,
          bookSummary: summaryAt(state, chapters.length),
          claimLedger: renderClaimLedger(state.claims, s.key),
          ...(state.needsDriftCheck ? { driftNote: state.driftNote } : {}),
          settings: cfg.settings,
        },
        opts(cfg, PASS_TASK[pass]),
      );
      record(state, result.meta, PASS_TASK[pass], pass, s.key, "assisted");
      const logEntry = buildLog(pass, s, v.id, result);

      if (result.status === "cap_exceeded") {
        const decision = await cfg.operator.capDecision({ pass, sectionKey: s.key, title: label(s), ratio: result.ratio, summary: result.summary });
        if (decision === "stop") {
          state.pending = { pass, sectionKey: s.key, ratio: result.ratio, summary: result.summary, revised: result.revised, log: logEntry };
          store.write(`pending/${pass}-${s.key}.md`, result.revised);
          store.save(state);
          return { stage: "waiting_operator", message: pendingMessage(state) };
        }
        applyOrSkip(store, state, s, logEntry, result.revised, decision, true);
      } else if (result.status === "applied") {
        applyOrSkip(store, state, s, logEntry, result.revised, "apply", false);
      } else {
        state.changeLogs.push({ ...logEntry, toVersionId: v.id });
        state.passUnits.push({ pass, sectionKey: s.key, status: "no_change", logId: logEntry.id, at: now() });
      }
      store.save(state);
    }
    if (pass === "dev" && state.needsDriftCheck) {
      state.needsDriftCheck = false;
      store.save(state);
    }
  }

  return buildOutputs(store, cfg.operator);
}

function applyOrSkip(store: BookStore, state: BookState, s: SectionState, logEntry: Omit<StoredChangeLog, "toVersionId">, revised: string, decision: "apply" | "skip", overCap: boolean): void {
  const pass = logEntry.pass;
  if (decision === "skip") {
    state.changeLogs.push({ ...logEntry, summary: `${logEntry.summary}; skipped by operator over the 40 percent cap`, toVersionId: logEntry.fromVersionId });
    state.passUnits.push({ pass, sectionKey: s.key, status: "skipped", logId: logEntry.id, at: now() });
    return;
  }
  const v = addVersion(store, s, {
    content: revised,
    source: pass,
    note: overCap ? `${logEntry.summary}; applied by operator over the 40 percent cap` : logEntry.summary,
    wordCount: countWords(revised),
    promptVersion: logEntry.promptVersion,
    model: logEntry.model,
    flags: logEntry.flags.map((f) => ({ type: f.type, note: `${f.location ? `${f.location}: ` : ""}${f.note}` })),
  });
  state.changeLogs.push({ ...logEntry, toVersionId: v.id });
  state.passUnits.push({ pass, sectionKey: s.key, status: "done", logId: logEntry.id, at: now() });
}

function buildLog(pass: EditPass, s: SectionState, fromVersionId: string, r: PassResult): Omit<StoredChangeLog, "toVersionId"> {
  return {
    id: `${pass}-${s.key}-${newId().slice(0, 8)}`,
    pass,
    sectionKey: s.key,
    summary: r.summary,
    changedRatio: r.ratio,
    changes: r.changes,
    flags: r.flags,
    guardReverts: r.guardReverts,
    fromVersionId,
    promptVersion: r.meta.promptVersion,
    model: r.meta.model,
    createdAt: now(),
    diff: r.diff,
  };
}

/* ------------------------------------------------------------------ */
/* Operator commands                                                   */
/* ------------------------------------------------------------------ */

export function approve(store: BookStore, which: "brief" | "outline", settings: PipelineSettings, force = false): string {
  const state = store.load();
  return approveIn(store, state, which, settings, force);
}

function approveIn(store: BookStore, state: BookState, which: "brief" | "outline", settings: PipelineSettings, force: boolean): string {
  if (which === "brief") {
    const fromFile = store.read("brief.json");
    const data = BriefOutput.parse(fromFile ? JSON.parse(fromFile) : state.brief?.data);
    if (!state.brief) throw new Error("No brief yet. Run the book first.");
    const snapshot = state.brief.approvedSnapshot;
    if (state.brief.status === "approved" && snapshot && JSON.stringify(snapshot) !== JSON.stringify(data)) {
      state.needsDriftCheck = true;
      state.driftNote = briefDiff(snapshot, data);
    }
    const { value } = sanitizeBrief(data);
    state.brief = { ...state.brief, data: value, status: "approved", lockedAt: now(), approvedSnapshot: value };
    store.write("brief.json", JSON.stringify(value, null, 2));
    store.save(state);
    return state.needsDriftCheck ? "Brief re-approved. The developmental pass will check every chapter for drift." : "Brief approved and locked.";
  }

  if (!state.outline || !state.brief) throw new Error("No outline yet. Run the book first.");
  if (state.sections.some((s) => s.versions.length > 0)) {
    throw new Error("Drafting has started; the outline cannot be re-approved. Regenerate chapters individually, or start a new book directory.");
  }
  const fromFile = store.read("outline.json");
  const data = OutlineOutput.parse(fromFile ? JSON.parse(fromFile) : state.outline.data);
  const violations = validateOutline(data, state.brief.data, state.input.target_words, settings);
  state.outline.violations = violations.map((v) => `${v.check}: ${v.detail}`);
  store.write("outline-violations.txt", state.outline.violations.join("\n") || "No violations.");
  if (violations.length && !force) {
    store.save(state);
    throw new Error(`Outline has ${violations.length} violation(s); fix outline.json or approve with --force:\n  ${state.outline.violations.join("\n  ")}`);
  }
  state.outline = { ...state.outline, data, status: "approved", lockedAt: now(), approvedSnapshot: data };
  state.sections = createSections(data);
  store.save(state);
  return `Outline approved and locked. ${data.chapters.length} chapters created.`;
}

function sanitizeBrief(b: BriefOutput) {
  const s = (x: string) => sanitize(x).text;
  return {
    value: {
      ...b,
      title: s(b.title),
      subtitle: s(b.subtitle),
      promise: s(b.promise),
      reader_profile: s(b.reader_profile),
      positioning: s(b.positioning),
      tone: s(b.tone),
      reader_job: s(b.reader_job),
      outcome: s(b.outcome),
      frameworks: b.frameworks.map((f) => ({ name: s(f.name), summary: s(f.summary) })),
      examples: b.examples.map(s),
    },
  };
}

function briefDiff(a: BriefOutput, b: BriefOutput): string {
  const lines: string[] = [];
  for (const k of Object.keys(b) as (keyof BriefOutput)[]) {
    const x = JSON.stringify(a[k]);
    const y = JSON.stringify(b[k]);
    if (x !== y) lines.push(`${k} changed from ${x} to ${y}`);
  }
  return lines.join("\n");
}

function createSections(o: OutlineOutput): SectionState[] {
  // A function, not a shared object, so every section gets its own versions array.
  const base = () => ({ currentVersionId: null, pinned: false, final: false, versions: [] });
  return [
    { ...base(), key: "intro", kind: "intro", position: 0, title: "Introduction", wordTarget: o.intro.word_target },
    ...o.chapters.map((c, i) => ({ ...base(), key: chapterKey(i + 1), kind: "chapter" as const, position: i + 1, title: c.title, wordTarget: c.word_target })),
    { ...base(), key: "conclusion", kind: "conclusion", position: o.chapters.length + 1, title: "Conclusion", wordTarget: o.conclusion.word_target },
    { ...base(), key: "course", kind: "page", position: o.chapters.length + 2, title: "Companion Course", wordTarget: 0 },
  ];
}

export async function resolvePending(store: BookStore, decision: "apply" | "skip"): Promise<string> {
  const state = store.load();
  const p = state.pending;
  if (!p) return "Nothing is waiting.";
  const s = section(state, p.sectionKey);
  applyOrSkip(store, state, s, p.log, p.revised, decision, true);
  state.pending = null;
  store.save(state);
  return `${decision === "apply" ? "Applied" : "Skipped"} the ${p.pass} pass on ${p.sectionKey}. Run the book again to continue.`;
}

export async function regenChapter(store: BookStore, cfg: RunConfig, position: number, note: string): Promise<string> {
  const state = store.load();
  if (!state.brief || !state.outline) throw new Error("Brief and outline must be approved first.");
  const ch = section(state, chapterKey(position));
  await ensureSummaries(store, state, cfg, position - 1);
  const prev = state.sections.find((s) => s.kind === "chapter" && s.position === position - 1);
  const prevVersion = prev ? currentVersion(prev) : null;
  const ctx = buildChapterContext({
    brief: state.brief.data,
    outline: state.outline.data,
    voice: state.voice,
    position,
    priorSummary: summaryAt(state, position - 1),
    ...(prevVersion ? { previousOpening: openingParagraph(prevVersion.content) } : {}),
  });
  const r = await draftChapter(cfg.ai, ctx, cfg.settings, note, opts(cfg, "chapter"));
  record(state, r.meta, "chapter", null, ch.key, aiDraftUse(state));
  const v = addVersion(store, ch, { content: r.content, source: "regen", note, wordCount: r.wordCount, promptVersion: r.meta.promptVersion, model: r.meta.model, flags: r.flags });
  store.save(state);
  return `Chapter ${position} regenerated as version ${v.n} (${r.wordCount} words). Edit passes already run on this chapter are not rerun automatically.`;
}

export function manualEdit(store: BookStore, key: string, content: string, note: string): string {
  const state = store.load();
  const s = section(state, key);
  const clean = sanitize(content).text.trim();
  const v = addVersion(store, s, { content: clean, source: "manual", note, wordCount: countWords(clean), promptVersion: null, model: null, flags: [] });
  store.save(state);
  return `Saved ${key} version ${v.n} (manual).`;
}

/** Roll back by moving the current-version pointer. No version is changed or removed. */
export function restoreVersion(store: BookStore, key: string, n: number): string {
  const state = store.load();
  const s = section(state, key);
  const v = s.versions.find((x) => x.n === n);
  if (!v) throw new Error(`${key} has no version ${n}. Versions: ${s.versions.map((x) => `${x.n} (${x.source})`).join(", ")}`);
  s.currentVersionId = v.id;
  store.write(`sections/${s.key}.md`, v.content);
  store.save(state);
  return `${key} restored to version ${n} (${v.source}).`;
}

/** Revert one numbered change from a change log, as a new manual version. */
export function revertLoggedChange(store: BookStore, logId: string, n: number): string {
  const state = store.load();
  const entry = state.changeLogs.find((l) => l.id === logId);
  if (!entry) throw new Error(`No change log "${logId}"`);
  const change = entry.changes.find((c) => c.n === n) as (typeof entry.changes)[number] & { prefix?: string; suffix?: string };
  if (!change) throw new Error(`Change log ${logId} has no change ${n}`);
  const s = section(state, entry.sectionKey);
  const v = currentVersion(s);
  if (!v) throw new Error(`${s.key} has no version`);
  const out = revertChange(v.content, { before: change.before, after: change.after, prefix: change.prefix ?? "", suffix: change.suffix ?? "" });
  if (out === null) throw new Error(`Change ${n} could not be located in the current text of ${s.key}; edit by hand with the manual command`);
  const nv = addVersion(store, s, { content: out, source: "manual", note: `Reverted change ${n} of ${logId}`, wordCount: countWords(out), promptVersion: null, model: null, flags: [] });
  store.save(state);
  return `Reverted change ${n}; ${s.key} is now version ${nv.n}.`;
}

export function setFlag(store: BookStore, key: string, flag: "pinned" | "final", value: boolean): string {
  const state = store.load();
  section(state, key)[flag] = value;
  store.save(state);
  return `${key} ${flag} = ${value}`;
}

/* ------------------------------------------------------------------ */
/* Outputs and QA                                                      */
/* ------------------------------------------------------------------ */

export async function buildOutputs(store: BookStore, operator: Operator): Promise<RunOutcome> {
  const state = store.load();
  if (!state.brief) throw new Error("No brief");
  const ordered = orderedSections(state);
  const sections: ManuscriptSection[] = ordered.map((s) => ({ kind: s.kind, title: s.title, markdown: currentVersion(s)?.content ?? "" }));
  const author = state.input.author_name;
  const md = buildManuscriptMarkdown({ title: state.brief.data.title, subtitle: state.brief.data.subtitle, author, language: state.input.language, sections });
  store.write("manuscript.md", md);
  store.write("change-log.md", renderChangeLog(state));
  store.write("ai-use-log.json", JSON.stringify(state.aiLog, null, 2));
  store.write("claims.json", JSON.stringify(state.claims, null, 2));

  const issues = findForbidden(md, state.voice.banned_terms);
  store.write("report.md", renderReport(state, issues));
  if (issues.length) {
    store.write("qa.json", JSON.stringify(issues, null, 2));
    return { stage: "qa_failed", message: `QA hard failure: ${issues.length} forbidden item(s) in the final text. See ${store.path("qa.json")}. No DOCX written.` };
  }
  const docxPath = store.path(`${state.slug}.docx`);
  await renderDocx(md, docxPath);
  operator.log(`Wrote ${docxPath}`);
  return { stage: "done", message: `Manuscript complete. Read ${docxPath}, with ${store.path("report.md")} and ${store.path("change-log.md")} beside it.`, docxPath };
}

function renderChangeLog(state: BookState): string {
  const out: string[] = [`# Change log: ${state.brief?.data.title ?? state.slug}`, ""];
  out.push("Revert any change by number: pnpm phase0 revert <book dir> <log id> <change number>", "");
  for (const pass of EDIT_PASSES) {
    const logs = state.changeLogs.filter((l) => l.pass === pass);
    if (!logs.length) continue;
    out.push(`## ${passName(pass)} pass`, "");
    for (const l of logs) {
      const s = state.sections.find((x) => x.key === l.sectionKey);
      out.push(`### ${s ? label(s) : l.sectionKey}`, "", `Log id: ${l.id}`, `Summary: ${l.summary}`, "");
      if (l.guardReverts.length) {
        out.push("Reverted by guards:", ...l.guardReverts.map((g) => `- Change ${g.n} (${g.guard} guard): ${g.reason}`), "");
      }
      if (l.flags.length) out.push("Flags for the operator:", ...l.flags.map((f) => `- [${f.type}]${f.location ? ` ${f.location}:` : ""} ${f.note}`), "");
      for (const c of l.changes) {
        out.push(`${c.n}. ${c.type}${c.location ? `, ${c.location}` : ""}${c.reason ? `: ${c.reason}` : ""}`);
        out.push(`   Before: ${oneLine(c.before) || "(nothing)"}`);
        out.push(`   After: ${oneLine(c.after) || "(cut)"}`);
      }
      out.push("");
    }
  }
  return out.join("\n");
}

function renderReport(state: BookState, issues: TextIssue[]): string {
  const brief = state.brief?.data;
  const out: string[] = [`# Phase 0 report: ${brief?.title ?? state.slug}`, ""];
  if (brief) out.push(`Subtitle: ${brief.subtitle}`, `Author: ${state.input.author_name}`, `Lane: ${state.input.lane}`, "");

  const generated = state.aiLog.some((e) => e.use === "generated");
  out.push("## AI disclosure", "");
  out.push(
    generated
      ? "Drafting path: AI-drafted from the approved brief and outline. Under the KDP definition this prose is AI-generated, however heavily it was edited, and must be disclosed as AI-generated (publishing-system-v2.md, compliance rules)."
      : "Drafting path: voice-first. AI edited the author's material only. Confirm the trace rule before answering the disclosure question as AI-assisted.",
    "Answer the KDP disclosure question from ai-use-log.json, not from memory.",
    "",
  );

  out.push("## Word counts", "", "| Section | Words | Target |", "| --- | --- | --- |");
  let total = 0;
  for (const s of orderedSections(state)) {
    const v = currentVersion(s);
    total += v?.wordCount ?? 0;
    out.push(`| ${label(s)} | ${v?.wordCount ?? 0} | ${s.wordTarget || ""} |`);
  }
  out.push(`| Total | ${total} | ${state.input.target_words} |`, "");

  out.push("## QA (hard checks on final text)", "");
  out.push(issues.length ? `${issues.length} failure(s):` : "Passed: zero em dashes, zero en dashes, zero emojis, zero banned terms.");
  for (const i of issues.slice(0, 50)) out.push(`- line ${i.line}: ${i.kind} ${i.match}: ${i.excerpt}`);
  out.push("");

  const openFlags = state.changeLogs.flatMap((l) => l.flags.map((f) => ({ ...f, section: l.sectionKey, pass: l.pass })));
  out.push("## Open flags from the edit passes", "");
  if (!openFlags.length) out.push("None.");
  const byType = new Map<string, number>();
  for (const f of openFlags) byType.set(f.type, (byType.get(f.type) ?? 0) + 1);
  if (openFlags.length) out.push(`By type: ${[...byType.entries()].map(([t, n]) => `${t} ${n}`).join(", ")}`, "");
  for (const f of openFlags) out.push(`- ${f.section}, ${f.pass} pass, [${f.type}] ${f.location ? `${f.location}: ` : ""}${f.note}`);
  out.push("");

  const draftFlags = state.sections.flatMap((s) => s.versions.filter((v) => v.source === "draft" || v.source === "regen").flatMap((v) => v.flags.map((f) => `- ${s.key} version ${v.n}: ${f.note}`)));
  if (draftFlags.length) out.push("## Draft flags", "", ...draftFlags, "");

  const needs = state.claims.filter((c) => c.status !== "Verified");
  out.push("## Claims that need a source", "", needs.length ? `${needs.length} of ${state.claims.length} claims are not verified. Mark them in claims.json (Verified, Needs source, or Cut).` : "All claims verified.", "");
  for (const c of needs) out.push(`- ${c.id} (${c.sectionKey}): ${c.text}`);
  out.push("");

  const reverts = state.changeLogs.flatMap((l) => l.guardReverts.map((g) => `- ${l.sectionKey}, ${l.pass} pass, change ${g.n}: ${g.guard} guard, ${g.reason}`));
  out.push("## Guard reverts", "", ...(reverts.length ? reverts : ["None."]), "");

  const capped = state.passUnits.filter((u) => u.status === "skipped");
  const overCap = state.sections.flatMap((s) => s.versions.filter((v) => v.note.includes("over the 40 percent cap")).map((v) => `- ${s.key} version ${v.n}: ${v.note}`));
  out.push("## 40 percent cap decisions", "", ...(capped.length || overCap.length ? [...capped.map((u) => `- ${u.sectionKey}, ${u.pass} pass: skipped`), ...overCap] : ["None."]), "");

  const tokensIn = state.aiLog.reduce((s, e) => s + e.tokensIn, 0);
  const tokensOut = state.aiLog.reduce((s, e) => s + e.tokensOut, 0);
  const san = state.aiLog.reduce((acc, e) => {
    acc.emDashes += e.sanitize.emDashes;
    acc.enDashes += e.sanitize.enDashes;
    acc.emojis += e.sanitize.emojis;
    return acc;
  }, emptyReport());
  out.push("## Usage", "", `AI calls: ${state.aiLog.length}. Tokens in: ${tokensIn}. Tokens out: ${tokensOut}.`);
  out.push(`Sanitizer replacements across all calls: ${san.emDashes} em dashes, ${san.enDashes} en dashes, ${san.emojis} emojis. Nonzero counts mean a template is drifting.`, "");
  const versions = [...new Set(state.aiLog.map((e) => e.promptVersion))].sort();
  out.push(`Template versions used: ${versions.join(", ")}`, "");
  return out.join("\n");
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function opts(cfg: RunConfig, task: string): RunOptions {
  const modelKey = taskModelKey(cfg.settings, task);
  return { ...(modelKey ? { modelKey } : {}), ...(cfg.backoffMs !== undefined ? { backoffMs: cfg.backoffMs } : {}) };
}

function record(state: BookState, meta: CallMeta, task: string, pass: EditPass | null, sectionKey: string | null, use: "generated" | "assisted"): void {
  state.aiLog.push({ date: now(), tool: meta.model, task, pass, section: sectionKey, use, promptVersion: meta.promptVersion, tokensIn: meta.tokensIn, tokensOut: meta.tokensOut, sanitize: meta.sanitize });
}

function aiDraftUse(state: BookState): "generated" | "assisted" {
  return state.input.drafting_source === "voice_first" ? "assisted" : "generated";
}

function orderedSections(state: BookState): SectionState[] {
  return [...state.sections].sort((a, b) => a.position - b.position);
}

function label(s: SectionState): string {
  return s.kind === "chapter" ? `Chapter ${s.position}: ${s.title}` : s.title;
}

function mark(s: SectionState) {
  if (s.kind === "chapter") return { kind: "chapter" as const, index: s.position };
  if (s.kind === "intro") return { kind: "intro" as const };
  if (s.kind === "conclusion") return { kind: "conclusion" as const };
  return null;
}

function passName(p: EditPass): string {
  return { dev: "Developmental", line: "Line", copy: "Copy", proof: "Proof" }[p];
}

function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, " / ").trim();
}

function pendingMessage(state: BookState): string {
  const p = state.pending;
  if (!p) return "";
  return `The ${p.pass} pass on ${p.sectionKey} would change ${Math.round(p.ratio * 100)} percent of the text (cap 40). ${p.summary}\nChoose Apply or Skip in the Studio, or read pending/${p.pass}-${p.sectionKey}.md and run: pnpm phase0 resolve <book dir> apply|skip`;
}

function summaryAt(state: BookState, position: number): string {
  if (position <= 0) return "";
  return state.summaries.find((s) => s.position === position)?.text ?? "";
}

/**
 * Running summary after each chapter, kept per position. A summary is stale
 * when its chapter's current version changed or an earlier summary was
 * recomputed; stale summaries are rebuilt in order.
 */
async function ensureSummaries(store: BookStore, state: BookState, cfg: RunConfig, upTo: number): Promise<void> {
  const brief = state.brief?.data;
  if (!brief) return;
  let rebuilt = false;
  for (let p = 1; p <= upTo; p++) {
    const ch = state.sections.find((s) => s.kind === "chapter" && s.position === p);
    const v = ch ? currentVersion(ch) : null;
    if (!ch || !v) break;
    const existing = state.summaries.find((s) => s.position === p);
    if (existing && existing.versionId === v.id && !rebuilt) continue;
    const r = await updateSummary(cfg.ai, { priorSummary: summaryAt(state, p - 1), position: p, title: ch.title, content: v.content, brief }, opts(cfg, "summary"));
    record(state, r.meta, "summary", null, ch.key, "assisted");
    state.summaries = [...state.summaries.filter((s) => s.position !== p), { position: p, text: r.summary, versionId: v.id }].sort((a, b) => a.position - b.position);
    state.runningSummary = r.summary;
    rebuilt = true;
    store.write("running-summary.txt", r.summary);
    store.save(state);
  }
}

/** Seed or refresh the claim ledger from current text, keeping operator decisions from claims.json. */
function refreshClaims(store: BookStore, state: BookState): void {
  const fileClaims = store.read("claims.json");
  const decided: Claim[] = fileClaims ? (JSON.parse(fileClaims) as Claim[]) : state.claims;
  const fresh = orderedSections(state).flatMap((s) => {
    const v = currentVersion(s);
    return v ? extractClaims(s.key, v.content) : [];
  });
  state.claims = mergeClaims(decided, fresh);
  store.write("claims.json", JSON.stringify(state.claims, null, 2));
  store.save(state);
}

export function statusText(store: BookStore): string {
  const state = store.load();
  const lines = [`Book: ${state.brief?.data.title ?? state.input.working_title} (${store.dir})`];
  lines.push(`Brief: ${state.brief?.status ?? "not generated"}`, `Outline: ${state.outline?.status ?? "not generated"}`);
  for (const s of orderedSections(state)) {
    const v = currentVersion(s);
    const done = state.passUnits.filter((u) => u.sectionKey === s.key).map((u) => `${u.pass}:${u.status}`);
    lines.push(`  ${s.key.padEnd(10)} v${v?.n ?? 0} ${v?.source ?? "-"} ${v?.wordCount ?? 0}w${s.pinned ? " pinned" : ""}${s.final ? " final" : ""} ${done.join(" ")}`);
  }
  if (state.pending) lines.push(`Waiting: ${pendingMessage(state)}`);
  return lines.join("\n");
}

export function isBookDir(p: string): boolean {
  return existsSync(join(p, "state.json"));
}
