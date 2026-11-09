import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { isSchemaName, type SchemaName } from "@me/shared";

/** Repo-root prompts/ directory, resolved from this file. */
export const DEFAULT_PROMPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../prompts");

const FrontMatter = z.object({
  task: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  model: z.string().min(1),
  slots: z.array(z.string()).default([]),
  optional_slots: z.array(z.string()).default([]),
  output: z.enum(["markdown", "json", "text"]),
  schema: z.string().optional(),
  max_tokens: z.number().int().positive().default(32000),
});

export interface Template {
  id: string;
  task: string;
  version: string;
  model: string;
  slots: string[];
  optionalSlots: string[];
  output: "markdown" | "json" | "text";
  schema?: SchemaName;
  maxTokens: number;
  system: string;
  user: string;
  path: string;
}

export interface RenderedPrompt {
  promptVersion: string;
  task: string;
  model: string;
  output: Template["output"];
  schema?: SchemaName;
  maxTokens: number;
  system: string;
  user: string;
}

export type SlotValue = string | number | boolean | object | null | undefined;
export type Slots = Record<string, SlotValue>;

export class TemplateError extends Error {
  override name = "TemplateError";
}

const PLACEHOLDER_RE = /\{\{\s*([#/]?)([a-z_][a-z0-9_]*)\s*\}\}/g;

export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function listTasks(dir = DEFAULT_PROMPTS_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .map((d) => d.name)
    .sort();
}

export function listVersions(task: string, dir = DEFAULT_PROMPTS_DIR): string[] {
  const taskDir = join(dir, task);
  if (!existsSync(taskDir)) throw new TemplateError(`No templates for task "${task}" in ${dir}`);
  return readdirSync(taskDir)
    .filter((f) => /^\d+\.\d+\.\d+\.md$/.test(f))
    .map((f) => f.slice(0, -3))
    .sort(compareSemver);
}

/** Load a template. Without a version, the highest semantic version is used. */
export function loadTemplate(task: string, version?: string, dir = DEFAULT_PROMPTS_DIR): Template {
  const versions = listVersions(task, dir);
  const v = version ?? versions[versions.length - 1];
  if (!v || !versions.includes(v)) {
    throw new TemplateError(`Template ${task}@${version ?? "latest"} not found. Available: ${versions.join(", ") || "none"}`);
  }
  const path = join(dir, task, `${v}.md`);
  return parseTemplate(readFileSync(path, "utf8"), path);
}

export function parseTemplate(source: string, path = "<inline>"): Template {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source.replace(/\r\n?/g, "\n"));
  if (!m) throw new TemplateError(`${path}: missing YAML front matter`);
  const fmParse = FrontMatter.safeParse(parseYaml(m[1] ?? ""));
  if (!fmParse.success) throw new TemplateError(`${path}: invalid front matter: ${fmParse.error.message}`);
  const fm = fmParse.data;

  if (fm.output === "json") {
    if (!fm.schema) throw new TemplateError(`${path}: json output requires a schema name`);
    if (!isSchemaName(fm.schema)) throw new TemplateError(`${path}: unknown schema "${fm.schema}"`);
  }

  const body = m[2] ?? "";
  const sys = /^# System[ \t]*\n([\s\S]*?)(?=^# User[ \t]*$)/m.exec(body);
  const usr = /^# User[ \t]*\n([\s\S]*)$/m.exec(body);
  if (!sys || !usr) throw new TemplateError(`${path}: body needs "# System" and "# User" sections, in that order`);

  const declared = new Set([...fm.slots, ...fm.optional_slots]);
  const system = (sys[1] ?? "").trim();
  const user = (usr[1] ?? "").trim();
  for (const text of [system, user]) {
    for (const p of text.matchAll(PLACEHOLDER_RE)) {
      const name = p[2] ?? "";
      if (!declared.has(name)) throw new TemplateError(`${path}: placeholder "${name}" is not declared in slots`);
    }
    checkBlocks(text, path);
  }
  for (const s of fm.slots) {
    if (!`${system}\n${user}`.includes(`{{${s}}}`)) throw new TemplateError(`${path}: required slot "${s}" is never used`);
  }

  return {
    id: `${fm.task}@${fm.version}`,
    task: fm.task,
    version: fm.version,
    model: fm.model,
    slots: fm.slots,
    optionalSlots: fm.optional_slots,
    output: fm.output,
    ...(fm.schema && isSchemaName(fm.schema) ? { schema: fm.schema } : {}),
    maxTokens: fm.max_tokens,
    system,
    user,
    path,
  };
}

/** Fill slots. Every required slot must be present and non-empty. */
export function renderTemplate(t: Template, slots: Slots): RenderedPrompt {
  const missing = t.slots.filter((s) => isEmpty(slots[s]));
  if (missing.length > 0) throw new TemplateError(`${t.id}: missing required slots: ${missing.join(", ")}`);
  const known = new Set([...t.slots, ...t.optionalSlots]);
  const unknown = Object.keys(slots).filter((k) => !known.has(k));
  if (unknown.length > 0) throw new TemplateError(`${t.id}: unknown slots: ${unknown.join(", ")}`);

  return {
    promptVersion: t.id,
    task: t.task,
    model: t.model,
    output: t.output,
    ...(t.schema ? { schema: t.schema } : {}),
    maxTokens: t.maxTokens,
    system: fill(t.system, slots),
    user: fill(t.user, slots),
  };
}

function fill(text: string, slots: Slots): string {
  // Conditional blocks: {{#name}} ... {{/name}} render only when the slot has a value.
  let out = text.replace(/\{\{#([a-z_][a-z0-9_]*)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, name: string, inner: string) =>
    isEmpty(slots[name]) ? "" : inner,
  );
  out = out.replace(/\{\{([a-z_][a-z0-9_]*)\}\}/g, (_m, name: string) => stringify(slots[name]));
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

function stringify(v: SlotValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v, null, 2);
}

function isEmpty(v: SlotValue): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === "string") return v.trim().length === 0;
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

function checkBlocks(text: string, path: string): void {
  const stack: string[] = [];
  for (const p of text.matchAll(PLACEHOLDER_RE)) {
    const kind = p[1];
    const name = p[2] ?? "";
    if (kind === "#") stack.push(name);
    else if (kind === "/") {
      const open = stack.pop();
      if (open !== name) throw new TemplateError(`${path}: block {{/${name}}} does not close {{#${open ?? ""}}}`);
    }
  }
  if (stack.length > 0) throw new TemplateError(`${path}: unclosed block {{#${stack.join(", ")}}}`);
}
