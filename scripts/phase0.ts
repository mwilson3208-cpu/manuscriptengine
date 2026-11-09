/**
 * Phase 0 pipeline CLI. Runs the same packages/pipeline functions the worker
 * will run in Phase 1, with a book directory on disk in place of the database.
 *
 *   pnpm phase0 run <input.json | book dir> [--out out] [--yes] [--on-cap ask|apply|skip|stop] [--passes dev,line,copy,proof]
 *   pnpm phase0 approve <book dir> brief|outline [--force]
 *   pnpm phase0 resolve <book dir> apply|skip
 *   pnpm phase0 regen <book dir> <chapter number> --note "direction"
 *   pnpm phase0 manual <book dir> <section key> <file.md> [--note "why"]
 *   pnpm phase0 restore <book dir> <section key> <version number>
 *   pnpm phase0 revert <book dir> <log id> <change number>
 *   pnpm phase0 pin|unpin|final|unfinal <book dir> <section key>
 *   pnpm phase0 docx <book dir>
 *   pnpm phase0 status <book dir>
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { createAnthropicClient } from "@me/pipeline";
import { EDIT_PASSES, type EditPass } from "@me/shared";
import { BookStore } from "./lib/book-state";
import {
  approve,
  buildOutputs,
  initBook,
  isBookDir,
  manualEdit,
  regenChapter,
  resolvePending,
  restoreVersion,
  revertLoggedChange,
  runBook,
  setFlag,
  statusText,
  type CapDecision,
  type Operator,
  type RunConfig,
} from "./lib/orchestrator";
import { loadSettings, REPO_ROOT } from "./lib/settings";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string", default: resolve(REPO_ROOT, "out") },
    yes: { type: "boolean", default: false },
    "on-cap": { type: "string" },
    passes: { type: "string" },
    note: { type: "string", default: "" },
    force: { type: "boolean", default: false },
  },
});

const [command, target, ...rest] = positionals;

function usage(): never {
  const doc = readFileSync(new URL(import.meta.url), "utf8").split("*/")[0] ?? "";
  console.error(doc.replace(/^\/\*\*|^ \* ?/gm, "").trim());
  process.exit(2);
}

function makeOperator(onCap: string | undefined): Operator {
  const mode = onCap ?? (process.stdin.isTTY ? "ask" : "stop");
  return {
    log: (m) => console.log(m),
    async capDecision(info) {
      const line = `The ${info.pass} pass on ${info.title} would change ${Math.round(info.ratio * 100)} percent of the text, over the 40 percent cap.\n  ${info.summary}`;
      if (mode === "apply" || mode === "skip" || mode === "stop") {
        console.log(`${line}\n  --on-cap=${mode}`);
        return mode as CapDecision;
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        for (;;) {
          const a = (await rl.question(`${line}\n  Apply, Skip, or Stop and review later? [a/s/x] `)).trim().toLowerCase();
          if (a === "a" || a === "apply") return "apply";
          if (a === "s" || a === "skip") return "skip";
          if (a === "x" || a === "stop") return "stop";
        }
      } finally {
        rl.close();
      }
    },
  };
}

function runConfig(): RunConfig {
  const settings = loadSettings();
  const passes = values.passes ? (values.passes.split(",").map((p) => p.trim()) as EditPass[]) : [...EDIT_PASSES];
  for (const p of passes) if (!EDIT_PASSES.includes(p)) throw new Error(`Unknown pass "${p}". Use ${EDIT_PASSES.join(", ")}`);
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set. Copy .env.example to .env and run with: node --env-file=.env, or export the key.");
  return { ai: createAnthropicClient(settings), settings, operator: makeOperator(values["on-cap"]), autoApprove: values.yes, passes };
}

function store(): BookStore {
  if (!target) usage();
  const dir = resolve(target);
  if (!isBookDir(dir)) throw new Error(`${dir} is not a book directory (no state.json). Start one with: pnpm phase0 run <input.json>`);
  return new BookStore(dir);
}

async function main(): Promise<void> {
  switch (command) {
    case "run": {
      if (!target) usage();
      const path = resolve(target);
      const s = isBookDir(path) ? new BookStore(path) : initBook(path, resolve(values.out));
      const outcome = await runBook(s, runConfig());
      console.log(`\n[${outcome.stage}] ${outcome.message}`);
      if (outcome.stage === "qa_failed") process.exitCode = 1;
      return;
    }
    case "approve": {
      const which = rest[0];
      if (which !== "brief" && which !== "outline") usage();
      console.log(approve(store(), which, loadSettings(), values.force));
      return;
    }
    case "resolve": {
      const d = rest[0];
      if (d !== "apply" && d !== "skip") usage();
      console.log(await resolvePending(store(), d));
      return;
    }
    case "regen": {
      const n = Number(rest[0]);
      if (!Number.isInteger(n) || n < 1) usage();
      console.log(await regenChapter(store(), runConfig(), n, values.note));
      return;
    }
    case "manual": {
      const [key, file] = rest;
      if (!key || !file) usage();
      console.log(manualEdit(store(), key, readFileSync(resolve(file), "utf8"), values.note || "manual edit"));
      return;
    }
    case "restore": {
      const [key, n] = rest;
      if (!key || !n) usage();
      console.log(restoreVersion(store(), key, Number(n)));
      return;
    }
    case "revert": {
      const [logId, n] = rest;
      if (!logId || !n) usage();
      console.log(revertLoggedChange(store(), logId, Number(n)));
      return;
    }
    case "pin":
    case "unpin":
    case "final":
    case "unfinal": {
      const key = rest[0];
      if (!key) usage();
      const flag = command.endsWith("pin") ? "pinned" : "final";
      console.log(setFlag(store(), key, flag, !command.startsWith("un")));
      return;
    }
    case "docx": {
      const outcome = await buildOutputs(store(), makeOperator("stop"));
      console.log(`[${outcome.stage}] ${outcome.message}`);
      if (outcome.stage === "qa_failed") process.exitCode = 1;
      return;
    }
    case "status":
      console.log(statusText(store()));
      return;
    default:
      usage();
  }
}

main().catch((err: unknown) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
