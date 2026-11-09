/**
 * Phase 0 Studio: a local browser console for the Phase 0 pipeline.
 *
 *   pnpm studio [--port 4310] [--out out]
 *
 * Runs only on this machine (bound to 127.0.0.1). Every action calls the same
 * scripts/lib/orchestrator.ts functions as the phase0 CLI, so the CLI and the
 * Studio can be used on the same book interchangeably. Replaced by the Phase 1 app.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createClient, loadSettings, REPO_ROOT } from "./lib/settings";
import { createStudioHandler } from "./studio/api";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "4310" },
    out: { type: "string", default: resolve(REPO_ROOT, "out") },
  },
});

const settings = loadSettings();
const { ai, label } = createClient(settings);

const exampleInput = JSON.parse(readFileSync(join(REPO_ROOT, "examples/book-input.example.json"), "utf8")) as Record<string, unknown>;
delete exampleInput.voice_profile;

const handler = createStudioHandler({
  outRoot: resolve(values.out),
  providerLabel: label,
  makeConfig: (log) => ({ ai, settings, operator: { log, capDecision: async () => "stop" } }),
  examples: {
    input: JSON.stringify(exampleInput, null, 2),
    voice: readFileSync(join(REPO_ROOT, "examples/voices/voice.example.json"), "utf8"),
  },
});

const port = Number(values.port);
createServer(handler).listen(port, "127.0.0.1", () => {
  console.log(`Manuscript Studio running at http://localhost:${port}`);
  console.log(`AI: ${label}. Books are stored in ${resolve(values.out)}.`);
  console.log("Press Ctrl+C to stop. A running job stops with it; run the book again to continue where it left off.");
});
