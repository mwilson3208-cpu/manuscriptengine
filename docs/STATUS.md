# Status

Phase 0: prompt pipeline. Code complete; exit test not started. Phase 0 is not complete until the operator confirms it.

## Done this session

- pnpm monorepo, strict TypeScript, Vitest, CI (typecheck plus 90 tests, Pandoc installed in CI).
- `packages/shared`: sanitizer, hard text QA check, word count, zod schemas. `packages/prompts`: versioned loader with slot validation.
- `prompts/`: the eleven 1.0.0 templates, translated from `docs/sop.md` and `docs/publishing-system-v2.md`. Conflicts in `docs/prompt-notes.md`.
- `packages/pipeline`: brief, outline with the four checks, draft with running summary, four edit passes with the 40 percent cap, voice and fact guards, numbered change logs, revert by number, claim ledger, matter.
- `packages/export`: DOCX through Pandoc on a 6 x 9 reference document.
- `scripts/phase0.ts` (runbook in `docs/PHASE0.md`) and `scripts/eval.ts`. Both run on the operator's Claude login through the Claude Code CLI, or on the API when a key is set.

## What the operator should test

1. Follow `docs/PHASE0.md`: log in to Claude Code (no API key needed), write a voice profile and two book inputs from two different briefs.
2. `pnpm phase0 run <input.json>` for each, approving the brief and outline at the gates.
3. Read each DOCX with `report.md` and `change-log.md` beside it. The exit test: would you publish it after your own light pass?
4. Note every template gap. I fix templates, bump versions, and rerun.

One real call has run through the Claude CLI client (pain-queries, Sonnet 5.5, valid JSON). No full book has run yet.

## Open questions

1. Master Voice Prompt and Cristina's voice card: please add them as files (for example `docs/voices/`) so I can build the first two profiles.
2. `reader_job`, `outcome`, `examples` on the brief: in Phase 1, add three columns to `briefs`, or one `extras jsonb`? I recommend three columns.
3. Voice-first drafting (v2): add a transcript cleanup template for Authority Lane books, or keep Phase 0 to AI-drafted Catalog Lane titles? I recommend the latter until the exit test passes.
4. Settle the SPEC conflicts in `docs/prompt-notes.md`, items 6 to 9.

## Next three items

1. Run both manuscripts with the operator and fix template gaps from the reading.
2. Run `pnpm eval` after each template fix and link the output.
3. After the operator confirms the exit test: Phase 1 schema migration and types.
