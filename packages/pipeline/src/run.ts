import { loadTemplate, renderTemplate, type RenderedPrompt, type Slots } from "@me/prompts";
import { emptyReport, sanitize, sanitizeDeep, schemas, type CallMeta, type SchemaName } from "@me/shared";
import type { z } from "zod";
import { AIError, type AIClient } from "./ai";

export interface RunOptions {
  /** Pin a template version. Defaults to the latest. */
  version?: string;
  /** Override the template's model key (from settings.task_models). */
  modelKey?: string;
  /** Retries after the first attempt for retryable failures. CLAUDE.md: retry twice with backoff. */
  retries?: number;
  /** Base backoff in ms; doubled per retry. Tests set 0. */
  backoffMs?: number;
  promptsDir?: string;
}

export interface RunResult<T> {
  output: T;
  raw: string;
  meta: CallMeta;
}

type SchemaOutput<S extends SchemaName> = z.infer<(typeof schemas)[S]>;

/** Render a template, call the model, sanitize, and validate. Text outputs. */
export async function runText(ai: AIClient, task: string, slots: Slots, opts: RunOptions = {}): Promise<RunResult<string>> {
  const prompt = render(task, slots, opts);
  if (prompt.output === "json") throw new AIError(`${prompt.promptVersion} returns json; use runJson`, false);
  const { response, attempts, latencyMs } = await callWithRetry(ai, prompt, opts);
  const s = sanitize(stripFence(response.text));
  if (s.text.trim().length === 0) throw new AIError(`${prompt.promptVersion} returned empty text`, true);
  return {
    output: s.text.trim(),
    raw: response.text,
    meta: { promptVersion: prompt.promptVersion, model: response.model, tokensIn: response.tokensIn, tokensOut: response.tokensOut, latencyMs, sanitize: s.report, attempts },
  };
}

/** Render a template, call the model, parse and validate JSON against the template's schema, then sanitize every string. */
export async function runJson<S extends SchemaName>(
  ai: AIClient,
  task: string,
  schema: S,
  slots: Slots,
  opts: RunOptions = {},
): Promise<RunResult<SchemaOutput<S>>> {
  const prompt = render(task, slots, opts);
  if (prompt.output !== "json" || prompt.schema !== schema) {
    throw new AIError(`${prompt.promptVersion} declares ${prompt.output}/${prompt.schema ?? "none"}, caller expected json/${schema}`, false);
  }
  const zschema = schemas[schema];
  let tokensIn = 0;
  let tokensOut = 0;
  let attempts = 0;
  let latencyMs = 0;
  let lastError = "";
  let current = prompt;
  // One extra attempt that feeds the validation error back to the model.
  for (let validationTry = 0; validationTry < 2; validationTry++) {
    const r = await callWithRetry(ai, current, opts);
    tokensIn += r.response.tokensIn;
    tokensOut += r.response.tokensOut;
    attempts += r.attempts;
    latencyMs += r.latencyMs;
    const parsed = parseJson(r.response.text);
    const result = parsed.ok ? zschema.safeParse(parsed.value) : null;
    if (result?.success) {
      const { value, report } = sanitizeDeep(result.data as SchemaOutput<S>, emptyReport());
      return {
        output: value,
        raw: r.response.text,
        meta: { promptVersion: prompt.promptVersion, model: r.response.model, tokensIn, tokensOut, latencyMs, sanitize: report, attempts },
      };
    }
    lastError = parsed.ok ? (result?.error.message ?? "invalid") : parsed.error;
    current = {
      ...prompt,
      user: `${prompt.user}\n\nYour previous response could not be used. Problem: ${lastError}\nReturn only the JSON object that matches the output contract.`,
    };
  }
  throw new AIError(`${prompt.promptVersion} returned invalid JSON after a correction attempt: ${lastError}`, false);
}

export function render(task: string, slots: Slots, opts: RunOptions = {}): RenderedPrompt {
  const t = loadTemplate(task, opts.version, opts.promptsDir);
  const rendered = renderTemplate(t, slots);
  return opts.modelKey ? { ...rendered, model: opts.modelKey } : rendered;
}

async function callWithRetry(ai: AIClient, prompt: RenderedPrompt, opts: RunOptions) {
  const retries = opts.retries ?? 2;
  const backoff = opts.backoffMs ?? 2000;
  let attempt = 0;
  for (;;) {
    attempt++;
    const started = Date.now();
    try {
      const response = await ai.complete({ modelKey: prompt.model, system: prompt.system, user: prompt.user, maxTokens: prompt.maxTokens, promptVersion: prompt.promptVersion });
      if (response.stopReason === "max_tokens") {
        throw new AIError(`${prompt.promptVersion} hit max_tokens (${prompt.maxTokens}); output truncated`, true);
      }
      return { response, attempts: attempt, latencyMs: Date.now() - started };
    } catch (err) {
      const retryable = err instanceof AIError ? err.retryable : true;
      if (!retryable || attempt > retries) throw err;
      if (backoff > 0) await new Promise((r) => setTimeout(r, backoff * 2 ** (attempt - 1)));
    }
  }
}

export function stripFence(text: string): string {
  const m = /^\s*```[a-zA-Z]*\n([\s\S]*?)\n```\s*$/.exec(text);
  return m ? (m[1] ?? "") : text;
}

export function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const body = stripFence(text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, error: "no JSON object found in the response" };
  try {
    return { ok: true, value: JSON.parse(body.slice(start, end + 1)) };
  } catch (e) {
    return { ok: false, error: `JSON parse error: ${(e as Error).message}` };
  }
}
