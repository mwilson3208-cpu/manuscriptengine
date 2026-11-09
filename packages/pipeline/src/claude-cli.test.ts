import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AIError } from "./ai";
import { claudeCliArgs, createClaudeCliClient } from "./claude-cli";
import { runText } from "./run";
import { DEFAULT_SETTINGS } from "./settings";

/** A stand-in `claude` binary: echoes what it received inside the JSON shape the real CLI prints. */
function fakeBinary(mode: "ok" | "error" | "garbage"): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  const path = join(dir, "claude");
  writeFileSync(
    path,
    `#!/usr/bin/env node
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  if (${JSON.stringify(mode)} === "garbage") { process.stderr.write("Not logged in. Run claude to log in."); process.exit(1); }
  const out = {
    type: "result",
    is_error: ${JSON.stringify(mode)} === "error",
    result: ${JSON.stringify(mode)} === "error" ? "Rate limited" : JSON.stringify({ input, args, key: process.env.ANTHROPIC_API_KEY ?? null, maxOut: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS }),
    stop_reason: "end_turn",
    usage: { input_tokens: 3, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0, output_tokens: 7 },
    modelUsage: { "claude-sonnet-5-5": {} },
  };
  process.stdout.write(JSON.stringify(out));
});
`,
  );
  chmodSync(path, 0o755);
  return path;
}

const req = { modelKey: "sonnet", system: "SYSTEM RULES", user: "USER PROMPT", maxTokens: 32000, promptVersion: "chapter@1.0.0" };

describe("Claude CLI client", () => {
  it("builds a tool-less, settings-free headless call", () => {
    const args = claudeCliArgs("S", "claude-sonnet-5-5", "high");
    expect(args).toEqual(expect.arrayContaining(["-p", "--output-format", "json", "--system-prompt", "S", "--model", "claude-sonnet-5-5", "--no-session-persistence", "--strict-mcp-config", "--disable-slash-commands", "--effort", "high"]));
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
  });

  it("sends the user prompt on stdin, resolves the model, strips any API key, and reads usage", async () => {
    process.env.ANTHROPIC_API_KEY = "should-not-pass";
    try {
      const ai = createClaudeCliClient(DEFAULT_SETTINGS, { binary: fakeBinary("ok") });
      const r = await ai.complete(req);
      const echoed = JSON.parse(r.text) as { input: string; args: string[]; key: string | null; maxOut: string };
      expect(echoed.input).toBe("USER PROMPT");
      expect(echoed.args[echoed.args.indexOf("--system-prompt") + 1]).toBe("SYSTEM RULES");
      expect(echoed.args[echoed.args.indexOf("--model") + 1]).toBe("claude-sonnet-5-5");
      expect(echoed.key).toBeNull();
      expect(echoed.maxOut).toBe("32000");
      expect(r.model).toBe("claude-sonnet-5-5");
      expect(r.tokensIn).toBe(1003);
      expect(r.tokensOut).toBe(7);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("turns an error result into a retryable AIError", async () => {
    const ai = createClaudeCliClient(DEFAULT_SETTINGS, { binary: fakeBinary("error") });
    const err = await ai.complete(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AIError);
    expect((err as AIError).retryable).toBe(true);
  });

  it("does not retry when the CLI is not logged in", async () => {
    const ai = createClaudeCliClient(DEFAULT_SETTINGS, { binary: fakeBinary("garbage") });
    const err = await ai.complete(req).catch((e: unknown) => e);
    expect((err as AIError).retryable).toBe(false);
    expect((err as Error).message).toContain("Not logged in");
  });

  it("reports a missing binary clearly", async () => {
    const ai = createClaudeCliClient(DEFAULT_SETTINGS, { binary: join(tmpdir(), "no-such-claude-binary") });
    await expect(ai.complete(req)).rejects.toThrow(/Install Claude Code/);
  });

  it("works through runText like any other client", async () => {
    const ai = createClaudeCliClient(DEFAULT_SETTINGS, { binary: fakeBinary("ok") });
    const r = await runText(ai, "summary", { prior_summary: "x", chapter_index: 1, chapter_title: "t", chapter_markdown: "m", frameworks: "f" }, { backoffMs: 0 });
    expect(r.meta.promptVersion).toBe("summary@1.0.0");
    expect(r.output).toContain("Running summary so far");
  });
});
