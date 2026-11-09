# Decisions

One line each: the decision and the reason. Newest last.

## Phase 0

- Packages are named `@me/shared`, `@me/prompts`, `@me/pipeline`, `@me/export`; dependencies live at the repo root. Simplest workspace that resolves the same way under tsx and Vitest.
- Model keys resolve in `config/settings.default.json`: `sonnet` is `claude-sonnet-5-5`, `opus` is `claude-opus-5-5`. Every template uses `sonnet`; `task_models` moves a task to Opus. SPEC: Sonnet by default, Opus where configured.
- Every AI call streams and reads the final message, so long chapters and edit passes never hit HTTP timeouts.
- The server-side refusal fallback (`fallbacks: "default"`) is on, so a policy decline is retried on a fallback model in the same call. `refusal_fallback: false` turns it off; the model that answered is recorded on every call.
- JSON outputs use the prompt contract plus zod validation and one correction attempt, not the API's structured-output mode. Keeps templates free of vendor-specific syntax (SPEC risk table).
- `BriefOutput` adds `reader_job`, `outcome`, and `examples`. The SOP's Gate 2 requires all three, and the outline and chapters need the examples. Phase 1 needs a home for them in `briefs` (see open questions in STATUS.md).
- `OutlineOutput` adds `frameworks_introduced`, `frameworks_used`, `transition`, and word targets for the introduction and conclusion. SPEC asks for framework placement; the SOP's expanded outline asks for the transition.
- Sanitizer turns numeric dash ranges into "to" (10 to 20), treats ASCII `--` and a spaced hyphen as dashes, straightens curly quotes (Pandoc curls them on export), and keeps the copyright, registered, and trademark signs. Commas or colons inside a number range read wrong.
- The 40 percent cap measures max(words removed, words added) divided by the section's original word count. A 15 percent cut scores 0.15; a full rewrite scores 1.0.
- Guards run in code, not as templates, and act per numbered change. Voice guard: reverts a change that adds a banned term or a sentence longer than the profile's maximum (or the 95th percentile of the samples). Fact guard: reverts a change that drops a number, date, capitalized name, or framework name, else flags it.
- Em dashes are removed by the sanitizer before the guards run, so the voice guard does not need to revert for them.
- Pure cuts are reverted by re-inserting the cut text at a 60-character anchor from the original, shortening the anchor when nearby text also changed.
- The claim ledger is seeded by code: every sentence with a number or a research word becomes a claim marked `Needs source`. The operator's statuses in `claims.json` survive reruns.
- Phase 0 storage is one JSON state file per book directory, written atomically. Versions only append; restore moves the current-version pointer. Maps one to one onto the Phase 1 tables.
- The running summary is stored per chapter position with the chapter version it was built from. A regenerated chapter makes later summaries stale; they are rebuilt in order when next needed.
- Edit passes run pass by pass across the whole book (all developmental, then all line), so each pass sees the previous pass's output everywhere.
- The Companion Course page is a section, edited by the copy and proof passes only.
- When a pass hits the cap in a non-interactive run, the run stops with the proposal saved to `pending/` and waits for `resolve apply|skip`. Same behavior as the `waiting_operator` job status in Phase 1.
- The DOCX reference document is 6 x 9 with mirrored margins (inside 0.625 in, others 0.5 in), Garamond 11 at 1.15 spacing, and a page break before each chapter. Built by `packages/export/tools/make-reference-docx.py` from Pandoc's default; print layout is the PDF renderer's job in Phase 3.
- The Phase 0 DOCX holds the introduction, chapters, conclusion, and Companion Course page. The other fixed pages are Stage 5 work.
- Phase 0 can run on the operator's Claude login: `createClaudeCliClient` calls `claude -p` with no tools, no setting sources, no MCP, and no slash commands, so only the template prompt reaches the model (about 1,400 tokens of overhead per call). `provider: "auto"` uses the API only when ANTHROPIC_API_KEY is set. Operator asked to run on Claude rather than the API. The refusal fallback setting applies to the API provider only.
- Phase 0 Studio (`pnpm studio`): the operator chose a local browser console before the exit test (option 2, Nov 9, 2026). It is an exception to non-negotiable 9, written into CLAUDE.md on `main` at the operator's request; the rule still gates the Phase 1 app. It uses Node's built-in http server and a single static page with no framework, so it adds no dependencies; it binds to 127.0.0.1, rejects non-localhost Host headers, requires JSON on every POST, and calls only `scripts/lib/orchestrator.ts`. Long work runs as an in-process background job the page polls. The 40 percent cap always pauses so the page shows the diff with Apply and Skip.
