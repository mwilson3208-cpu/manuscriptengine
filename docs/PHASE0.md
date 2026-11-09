# Running Phase 0

Phase 0 is the prompt pipeline as a command-line tool. It takes one book input file and produces a brief, an outline, every chapter, four edit passes with change logs, and a DOCX. It runs the same `packages/pipeline` functions the app will run, so what you approve here is what the app will produce.

## One-time setup

1. Install Node 22, pnpm 10, and Pandoc 3 (`brew install pandoc` on a Mac).
2. In the repo: `pnpm install`.
3. Install Claude Code and run `claude` once to log in with your Claude account. Phase 0 runs every AI call through `claude -p` on that login, so no API key is needed. Each call is a fresh session with no tools, no project files, and no plugins, so the model sees only the template's prompt.
4. Optional, API instead: copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY`. When a key is set, calls go to the API instead. Force either with `"provider": "claude-cli"` or `"provider": "api"` in `config/settings.local.json`.
5. Optional: change models in `config/settings.local.json` (not committed), for example `{"task_models": {"brief": "opus", "edit-dev": "opus"}}` to run the brief and developmental pass on Opus.

## Make the inputs

1. Voice profile: copy `examples/voices/voice.example.json` and fill every REPLACE. Paste the Master Voice Prompt or lane voice card into `rules.master_voice_prompt`, add three to five samples of 200 to 400 words, and list the hedging and coaching phrases you never use in `banned_terms`. The voice guard reverts any edit that adds a banned term.
2. Book input: copy `examples/book-input.example.json`. Put your real examples, stories, and reader phrases under `materials`. The brief uses them first and marks anything it had to propose with `PROPOSED:` so you can replace it.
3. If you already have a finished brief, add it as `"brief": {...}` in the input file with the fields in `eval/fixtures/brief.json`. The brief step is then skipped and your brief is treated as approved.

## Run a book

```bash
pnpm phase0 run my-book.json
```

The run stops at each gate and tells you the next command.

1. Brief. Read `out/<book>/brief.json`, edit it directly if needed, then `pnpm phase0 approve out/<book> brief`.
2. Outline. Read `out/<book>/outline.json` and `outline-violations.txt`, edit if needed, then `pnpm phase0 approve out/<book> outline`. Approval is refused while any of the four checks fail; `--force` overrides.
3. Run again: `pnpm phase0 run out/<book>`. It drafts every chapter in order, writes the introduction, conclusion, and Companion Course page, locks the style sheet, seeds `claims.json`, and runs the developmental, line, copy, and proof passes.
4. If a pass would change more than 40 percent of a section, it asks Apply, Skip, or Stop. Stop saves the proposed text to `pending/` so you can read it, then `pnpm phase0 resolve out/<book> apply` (or `skip`) and run again.

`--yes` approves the brief and outline automatically when they have no violations. Every step is safe to rerun: finished work is never redone.

## What to read

- `<book>.docx`: the manuscript, 6 x 9, Garamond 11.
- `report.md`: AI disclosure answer, word counts, QA result, every open flag from the passes, claims that need a source, guard reverts, cap decisions, token use.
- `change-log.md`: every change by pass and section, numbered, with before and after.
- `claims.json`: mark each claim `Verified`, `Needs source`, or `Cut`. The copy pass flags every claim that is not Verified.
- `versions/`: every version of every section, never overwritten.

## Fix things

```bash
pnpm phase0 regen out/<book> 3 --note "shorter opening, add a second example"
```

```bash
pnpm phase0 revert out/<book> <log id> <change number>
```

```bash
pnpm phase0 restore out/<book> ch03 1
```

```bash
pnpm phase0 manual out/<book> ch03 my-edit.md --note "tightened the close"
```

```bash
pnpm phase0 final out/<book> ch03
```

```bash
pnpm phase0 docx out/<book>
```

```bash
pnpm phase0 status out/<book>
```

The log id is printed in `change-log.md`. `final` (or `pin`) makes later passes skip a section. `docx` rebuilds the manuscript after manual changes; it refuses to write the DOCX if the final text has an em dash, en dash, emoji, or banned term.

## Template changes

After any change under `prompts/`, run `pnpm eval` and read `eval/<date>/README.md`, the two chapters, and the developmental pass output. Link the folder in the pull request.
