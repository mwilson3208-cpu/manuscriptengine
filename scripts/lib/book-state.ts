import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Claim, DiffHunk } from "@me/pipeline";
import type {
  BookInput,
  BriefOutput,
  ChangeLogEntry,
  EditPass,
  OutlineOutput,
  SanitizeReport,
  SectionKind,
  VersionFlag,
  VersionSource,
  VoiceProfile,
} from "@me/shared";

/**
 * Phase 0 stand-in for the database: one JSON file per book plus readable
 * copies of everything. Nothing is ever overwritten: versions only append, and
 * restoring moves the current-version pointer. The tables in CLAUDE.md map
 * one to one onto these collections in Phase 1.
 */

export interface Version {
  id: string;
  n: number;
  content: string;
  source: VersionSource;
  note: string;
  wordCount: number;
  promptVersion: string | null;
  model: string | null;
  flags: VersionFlag[];
  createdAt: string;
}

export interface SectionState {
  key: string;
  kind: SectionKind | "page";
  /** 0 for the introduction, 1..n for chapters, n+1 for the conclusion, n+2 for the course page. */
  position: number;
  title: string;
  wordTarget: number;
  currentVersionId: string | null;
  pinned: boolean;
  final: boolean;
  versions: Version[];
}

export interface StoredChangeLog extends ChangeLogEntry {
  diff: DiffHunk[];
}

export interface AIUseEntry {
  date: string;
  tool: string;
  task: string;
  pass: string | null;
  section: string | null;
  use: "generated" | "assisted";
  promptVersion: string;
  tokensIn: number;
  tokensOut: number;
  sanitize: SanitizeReport;
}

export interface PassUnit {
  pass: EditPass;
  sectionKey: string;
  status: "done" | "no_change" | "skipped" | "skipped_final";
  logId: string | null;
  at: string;
}

export interface PendingCap {
  pass: EditPass;
  sectionKey: string;
  ratio: number;
  summary: string;
  revised: string;
  /** The full change log that would be written on Apply. */
  log: Omit<StoredChangeLog, "toVersionId">;
}

export interface Gate<T> {
  data: T;
  status: "draft" | "approved";
  lockedAt: string | null;
  promptVersion: string | null;
  /** Snapshot at approval, used to detect later edits (drift). */
  approvedSnapshot: T | null;
}

export interface BookState {
  schema: 1;
  slug: string;
  createdAt: string;
  input: Omit<BookInput, "voice_profile" | "brief">;
  voice: VoiceProfile;
  brief: Gate<BriefOutput> | null;
  outline: (Gate<OutlineOutput> & { violations: string[] }) | null;
  sections: SectionState[];
  runningSummary: string;
  /** Running summary after each chapter position, with the chapter version it was built from. */
  summaries: { position: number; text: string; versionId: string }[];
  needsDriftCheck: boolean;
  driftNote: string;
  claims: Claim[];
  styleSheet: { text: string; lockedAt: string } | null;
  passUnits: PassUnit[];
  changeLogs: StoredChangeLog[];
  pending: PendingCap | null;
  aiLog: AIUseEntry[];
}

export const now = () => new Date().toISOString();
export const newId = () => randomUUID();

export class BookStore {
  constructor(readonly dir: string) {}

  get statePath(): string {
    return join(this.dir, "state.json");
  }

  exists(): boolean {
    return existsSync(this.statePath);
  }

  load(): BookState {
    return JSON.parse(readFileSync(this.statePath, "utf8")) as BookState;
  }

  /** Atomic write so an interrupted run never leaves a half-written state file. */
  save(state: BookState): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, this.statePath);
  }

  write(rel: string, content: string): string {
    const p = join(this.dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    return p;
  }

  read(rel: string): string | null {
    const p = join(this.dir, rel);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  }

  path(rel: string): string {
    return join(this.dir, rel);
  }
}

export function section(state: BookState, key: string): SectionState {
  const s = state.sections.find((x) => x.key === key);
  if (!s) throw new Error(`No section "${key}". Sections: ${state.sections.map((x) => x.key).join(", ")}`);
  return s;
}

export function currentVersion(s: SectionState): Version | null {
  return s.versions.find((v) => v.id === s.currentVersionId) ?? null;
}

/** Append a version and point the section at it. Never edits an existing version. */
export function addVersion(store: BookStore, s: SectionState, v: Omit<Version, "id" | "n" | "createdAt">): Version {
  const version: Version = { ...v, id: newId(), n: s.versions.length + 1, createdAt: now() };
  s.versions.push(version);
  s.currentVersionId = version.id;
  store.write(`versions/${s.key}/${String(version.n).padStart(3, "0")}-${version.source}.md`, version.content);
  store.write(`sections/${s.key}.md`, version.content);
  return version;
}

export function chapterKey(position: number): string {
  return `ch${String(position).padStart(2, "0")}`;
}
