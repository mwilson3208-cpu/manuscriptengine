import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { AIError, resolveModel, type AIClient, type ModelSettings } from "./ai";

/**
 * AI client that runs each call through the Claude Code CLI in headless mode
 * (`claude -p`), so the pipeline runs on the operator's Claude login with no
 * API key. Each call is a fresh, tool-less session with no project settings,
 * skills, or MCP servers loaded, so only the template's system and user prompt
 * reach the model.
 */
export interface ClaudeCliOptions {
  /** Path to the claude binary. Default: "claude" on PATH. */
  binary?: string;
  /** Per-call timeout in ms. Default 20 minutes. */
  timeoutMs?: number;
}

interface CliResult {
  type?: string;
  is_error?: boolean;
  result?: string;
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
  modelUsage?: Record<string, unknown>;
}

export function claudeCliArgs(system: string, model: string, effort?: string | null): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--system-prompt",
    system,
    "--model",
    model,
    "--tools",
    "",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--disable-slash-commands",
    ...(effort ? ["--effort", effort] : []),
  ];
}

export function createClaudeCliClient(settings: ModelSettings, opts: ClaudeCliOptions = {}): AIClient {
  const binary = opts.binary ?? process.env.CLAUDE_CLI_PATH ?? "claude";
  const timeoutMs = opts.timeoutMs ?? 20 * 60 * 1000;
  return {
    async complete(req) {
      const model = resolveModel(settings, req.modelKey);
      // Never let an API key in the environment silently switch the CLI to API billing.
      const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(req.maxTokens) };
      delete env.ANTHROPIC_API_KEY;
      const { stdout, stderr, code, timedOut } = await run(binary, claudeCliArgs(req.system, model, settings.effort), req.user, env, timeoutMs);
      if (timedOut) throw new AIError(`Claude CLI timed out after ${Math.round(timeoutMs / 1000)}s`, true);
      let parsed: CliResult;
      try {
        parsed = JSON.parse(stdout.trim().split("\n").filter(Boolean).pop() ?? "") as CliResult;
      } catch {
        const detail = (stderr || stdout).trim().slice(0, 400);
        const notLoggedIn = /log ?in|auth|credential/i.test(detail);
        throw new AIError(`Claude CLI failed (exit ${code}): ${detail || "no output"}`, !notLoggedIn);
      }
      if (parsed.is_error || code !== 0) {
        const detail = (parsed.result ?? stderr).trim().slice(0, 400);
        throw new AIError(`Claude CLI returned an error: ${detail}`, !/log ?in|auth|credential/i.test(detail));
      }
      const u = parsed.usage ?? {};
      return {
        text: (parsed.result ?? "").trim(),
        model: Object.keys(parsed.modelUsage ?? {})[0] ?? model,
        tokensIn: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
        tokensOut: u.output_tokens ?? 0,
        stopReason: parsed.stop_reason ?? null,
      };
    },
  };
}

function run(binary: string, args: string[], input: string, env: NodeJS.ProcessEnv, timeoutMs: number) {
  return new Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }>((resolve, reject) => {
    const p = spawn(binary, args, { cwd: tmpdir(), env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill("SIGTERM");
    }, timeoutMs);
    p.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    p.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(new AIError(`Could not start the Claude CLI (${binary}): ${e.message}. Install Claude Code and run "claude" once to log in.`, false));
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
    p.stdin.end(input);
  });
}
