import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createAnthropicClient, createClaudeCliClient, DEFAULT_SETTINGS, type AIClient, type PipelineSettings } from "@me/pipeline";

export const REPO_ROOT = resolve(import.meta.dirname, "../..");

/**
 * Phase 0 settings: config/settings.default.json, then config/settings.local.json
 * (not committed), then MODEL_SONNET / MODEL_OPUS from the environment. In Phase 1
 * the same keys move to the settings table.
 */
export function loadSettings(root = REPO_ROOT): PipelineSettings {
  const read = (p: string): Partial<PipelineSettings> => (existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Partial<PipelineSettings>) : {});
  const base = read(join(root, "config/settings.default.json"));
  const local = read(join(root, "config/settings.local.json"));
  const merged: PipelineSettings = {
    ...DEFAULT_SETTINGS,
    ...base,
    ...local,
    models: { ...DEFAULT_SETTINGS.models, ...base.models, ...local.models },
    task_models: { ...base.task_models, ...local.task_models },
  };
  if (process.env.MODEL_SONNET) merged.models.sonnet = process.env.MODEL_SONNET;
  if (process.env.MODEL_OPUS) merged.models.opus = process.env.MODEL_OPUS;
  return merged;
}

/**
 * The AI client for a run. "api" needs ANTHROPIC_API_KEY. "claude-cli" runs
 * through the operator's Claude Code login with no key. "auto" (the default)
 * uses the API when a key is set and the Claude CLI otherwise.
 */
export function createClient(settings: PipelineSettings): { ai: AIClient; label: string } {
  const provider = settings.provider ?? "auto";
  const useApi = provider === "api" || (provider === "auto" && Boolean(process.env.ANTHROPIC_API_KEY));
  if (useApi) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('provider is "api" but ANTHROPIC_API_KEY is not set');
    return { ai: createAnthropicClient(settings), label: "Anthropic API" };
  }
  return { ai: createClaudeCliClient(settings), label: "Claude Code CLI (your Claude login)" };
}
