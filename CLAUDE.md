# Manuscript Engine: Claude Code Master Build Prompt

Nov 8, 2026 · @Michael Wilson

## How to use this prompt

Export this doc as Markdown and save it as `CLAUDE.md` in the root of a new empty repository named `manuscript-engine`. Export the product specification doc as Markdown and save it beside it as `SPEC.md`. Open Claude Code in that folder and type: `Read CLAUDE.md and SPEC.md, then start Phase 0.`

Everything below this line is written to Claude Code, not to you. Edit any rule you disagree with before the first run; after that, change rules through the file, not through chat, so the agreement stays in one place.

## Role and mission

You are the lead engineer building Manuscript Engine, a single-user web application that takes a nonfiction book from topic research to upload-ready Amazon KDP files. The operator is Michael Wilson, founder of Power Reads Publishing, who publishes a high-volume nonfiction catalog and will be the only user. He is technical enough to run deployments and read code but is not writing it. You are.

The product has eight stages. Stage 0 scans Amazon and Google Trends to find high-demand, low-competition topics that match active pain-point searches. Stages 1 through 7 carry an approved topic through brief, outline, chapter drafting, four automatic edit passes, front and back matter, export to 6 x 9 print PDF and EPUB, and QA. `SPEC.md` is the full product specification and is the authority on behavior. This file is the authority on how you work.

Your mission is a working application the operator can use to publish real books, delivered in phases, each phase ending with something he can test on a real manuscript. Quality of the manuscript output matters more than feature count. A beautiful UI that produces a flat manuscript is a failure. A plain UI that produces a book he would publish is a success.

## Non-negotiables

These rules override convenience, speed, and your own preferences. If a task cannot be done within them, stop and ask.

1. Nothing is ever overwritten. Every chapter generation, regeneration, manual edit, and edit pass creates a new row in `versions`. Rollback to any version must always work.
2. No vendor key reaches the browser. All calls to Claude, SerpApi, Keepa, and Amazon run in the worker or in server-only API routes. Keys live in environment variables and the encrypted `settings` table, never in client bundles or the repo.
3. No scraping from the operator's publishing network. Amazon results come only through SerpApi. Never add direct Amazon page fetching, headless browsing of Amazon, or any workaround if SerpApi fails. Fail the job and report it.
4. The output text never contains em dashes or emojis. Enforce this in prompt templates, in a post-generation sanitizer, and in a hard QA check. All three.
5. Edit passes never rewrite an example, story, or framework name. They flag; the operator decides.
6. No edit pass may change more than 40 percent of a chapter's text without stopping and asking.
7. Long work runs in the worker as a job with progress, never in a request handler. Any operation over 10 seconds is a job.
8. Prompt templates live in the repo under `prompts/` with semantic versions. Every generation records the template version used. Templates are never built from strings scattered in code.
9. Phase 0 is a gate. Do not scaffold the UI until two manuscripts from the Phase 0 pipeline have been read and approved by the operator.
10. Ask before adding a dependency, a vendor, a table, or a stage that is not in `SPEC.md`.
11. TypeScript strict mode everywhere. No `any` without a comment explaining why.
12. Every API route and every job type has at least one test that runs in CI.

## Tech stack and repository structure

A pnpm monorepo with two deployable apps and shared packages.

| Component | Choice | Notes |
| --- | --- | --- |
| Web app | Next.js 15 App Router, TypeScript, Tailwind, shadcn/ui | Deployed to Vercel; server components by default, client components only for interactivity |
| Worker | Node 22, TypeScript, Dockerfile with Pandoc, Chromium (Playwright), Java runtime for EPUBCheck | Deployed to Railway; one container, one process, polling the jobs table |
| Database | Supabase Postgres with RLS | Migrations in `supabase/migrations/`, applied with the Supabase CLI |
| Storage | Supabase Storage, bucket `exports` | Private bucket; signed URLs for download |
| Auth | Supabase Auth, email and password, one allowed user | Allowlist the operator's email in an env var; reject all other signups |
| Jobs | `pg-boss` on the Supabase database | No Redis, no extra vendor |
| AI | `@anthropic-ai/sdk` | Model names are settings, not constants |
| Market data | SerpApi (Amazon search engine and Google Trends engines), Keepa REST API, Amazon completion endpoint | All in `packages/market` |
| Print | HTML plus CSS paged media rendered by Playwright Chromium; Pandoc to LaTeX as the alternative to test in Phase 3 | Both behind one `render-pdf` interface |
| EPUB | Pandoc, then EPUBCheck | In `packages/export` |
| Testing | Vitest for units, Playwright for a smoke test of the UI | CI on GitHub Actions |

**Repository layout**

```
manuscript-engine/
  CLAUDE.md
  SPEC.md
  apps/
    web/                 Next.js app
    worker/              job runner and scheduler
  packages/
    db/                  Supabase client, typed queries, generated types
    prompts/             prompt templates, versioned, with loader and slot filler
    pipeline/            brief, outline, draft, edit passes, summary (pure functions over the AI client)
    market/              autocomplete, SerpApi, Keepa, pain translation, scoring
    export/              manuscript assembly, PDF, EPUB, metadata, QA checks
    shared/              types, constants, sanitizers, zod schemas
  prompts/               the template files themselves (markdown with front matter)
  supabase/
    migrations/
    seed.sql
  scripts/
    phase0.ts            CLI pipeline used before the UI exists
  .github/workflows/ci.yml
```

Environment variables are documented in `.env.example` with a one-line purpose each. The app and the worker read the same variable names.

## Database schema

Create this as the first migration. Every table gets `created_at timestamptz default now()` and RLS that allows only the operator's `auth.uid()`. Generate TypeScript types from the schema into `packages/db` after every migration.

```sql
create type book_stage as enum ('brief','outline','draft','edit','matter','export','done');
create type version_source as enum ('draft','regen','manual','dev','line','copy','proof');
create type candidate_status as enum ('new','watchlist','started','dismissed');
create type job_status as enum ('queued','running','done','failed','cancelled');

create table voice_profiles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  identity_type text not null check (identity_type in ('author','pen_name')),
  bio_short text, bio_long text,
  rules jsonb not null default '{}',
  preferred_terms text[] default '{}',
  banned_terms text[] default '{}',
  samples jsonb not null default '[]',
  language text not null default 'en',
  created_at timestamptz default now()
);

create table author_identities (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  voice_profile_id uuid references voice_profiles(id),
  also_by jsonb not null default '[]',
  review_link_pattern text,
  created_at timestamptz default now()
);

create table books (
  id uuid primary key default gen_random_uuid(),
  title text not null, subtitle text,
  lane text not null, language text not null default 'en',
  author_identity_id uuid references author_identities(id),
  voice_profile_id uuid references voice_profiles(id),
  stage book_stage not null default 'brief',
  target_words int not null default 25000,
  trim text not null default '6x9',
  ebook boolean not null default true,
  candidate_id uuid,
  created_at timestamptz default now()
);

create table briefs (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references books(id) on delete cascade,
  promise text, reader_profile text, positioning text,
  frameworks jsonb not null default '[]',
  tone text, status text not null default 'draft',
  locked_at timestamptz, prompt_version text,
  created_at timestamptz default now()
);

create table outlines (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references books(id) on delete cascade,
  chapters jsonb not null default '[]',
  status text not null default 'draft',
  locked_at timestamptz, prompt_version text,
  created_at timestamptz default now()
);

create table chapters (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references books(id) on delete cascade,
  position int not null, title text not null,
  current_version_id uuid, pinned boolean not null default false,
  unique (book_id, position)
);

create table versions (
  id uuid primary key default gen_random_uuid(),
  chapter_id uuid not null references chapters(id) on delete cascade,
  content text not null,
  source version_source not null,
  note text, word_count int not null,
  prompt_version text, model text,
  created_at timestamptz default now()
);

create table change_logs (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references books(id) on delete cascade,
  chapter_id uuid references chapters(id) on delete cascade,
  pass version_source not null,
  summary text not null, diff jsonb not null default '{}',
  from_version_id uuid, to_version_id uuid,
  created_at timestamptz default now()
);

create table scans (
  id uuid primary key default gen_random_uuid(),
  lane text not null, status job_status not null default 'queued',
  source_counts jsonb not null default '{}',
  started_at timestamptz, completed_at timestamptz,
  created_at timestamptz default now()
);

create table candidates (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references scans(id) on delete cascade,
  lane text not null, phrase text not null,
  demand numeric, competition numeric, quality_gap numeric, pain_signal numeric,
  opportunity_score numeric, quadrant text,
  status candidate_status not null default 'new',
  evidence jsonb not null default '{}',
  created_at timestamptz default now()
);

create table competitor_snapshots (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references candidates(id) on delete cascade,
  asin text not null, title text, bsr int, reviews int, rating numeric,
  pages int, price numeric, publisher text, pub_date date,
  bsr_history jsonb, captured_at timestamptz default now()
);

create table pain_queries (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references candidates(id) on delete cascade,
  query text not null,
  interest_series jsonb, slope_24m numeric, solution_intent_share numeric,
  rising_related jsonb, top_related jsonb, regions jsonb,
  captured_at timestamptz default now()
);

create table watchlist (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references candidates(id) on delete cascade,
  last_score numeric, score_delta numeric,
  added_at timestamptz default now()
);

create table exports (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references books(id) on delete cascade,
  version_stamp text not null,
  pdf_path text, epub_path text, docx_path text,
  metadata jsonb not null default '{}', qa_results jsonb not null default '{}',
  page_count int, spine_width numeric, release_ready boolean not null default false,
  created_at timestamptz default now()
);

create table jobs_meta (
  id uuid primary key default gen_random_uuid(),
  job_type text not null, book_id uuid, scan_id uuid,
  status job_status not null default 'queued',
  progress jsonb not null default '{}', error text,
  tokens_in int default 0, tokens_out int default 0,
  started_at timestamptz, finished_at timestamptz,
  created_at timestamptz default now()
);

create table settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz default now()
);
```

`jobs_meta` is the operator-facing record of a job; `pg-boss` keeps its own queue tables in the `pgboss` schema. Seed `settings` with lane defaults, the modifier list, typography defaults, and templates from `supabase/seed.sql`.

## Prompt template layer

Every AI call goes through `packages/prompts`. A template is a Markdown file with YAML front matter in `prompts/<task>/<version>.md`. The loader fills named slots, validates that every required slot is present, and returns the system prompt, user prompt, and output contract.

**Template files to create**

| Task | File | Output contract |
| --- | --- | --- |
| Brief | `prompts/brief/1.0.0.md` | JSON: title, subtitle, promise, reader\_profile, positioning, frameworks\[\], tone |
| Outline | `prompts/outline/1.0.0.md` | JSON: intro, chapters\[\] (title, goal, points\[\], example, action\_step, word\_target), conclusion |
| Chapter draft | `prompts/chapter/1.0.0.md` | Markdown body only, no heading |
| Running summary | `prompts/summary/1.0.0.md` | Plain text under 1,500 words |
| Developmental pass | `prompts/edit-dev/1.0.0.md` | JSON: revised\_markdown, changes\[\] (type, location, before, after, reason), flags\[\] |
| Line pass | `prompts/edit-line/1.0.0.md` | Same shape as developmental |
| Copy pass | `prompts/edit-copy/1.0.0.md` | Same shape |
| Proof pass | `prompts/edit-proof/1.0.0.md` | Same shape |
| Pain translation | `prompts/pain-queries/1.0.0.md` | JSON: queries\[\] (5 to 8 strings) |
| Metadata | `prompts/metadata/1.0.0.md` | JSON: description\_html, keywords\[7\], categories\[2\], back\_cover, price\_print, price\_ebook |
| Matter | `prompts/matter/1.0.0.md` | JSON: introduction\_markdown, conclusion\_markdown, companion\_course\_markdown |

**Front matter fields**

```yaml
task: chapter
version: 1.0.0
model: sonnet          # setting key, resolved at runtime
slots: [brief, outline, chapter_index, voice_profile, prior_summary, word_target]
output: markdown       # or json with a zod schema name
schema: ChapterOutput  # when output is json
```

**Rules written into every template**

- No em dashes, no emojis, paragraphs by default, lists only when the content is a list
- No generic motivation; every claim ties to an action or an example
- Frameworks are named once, then used by name
- Edit passes return `changes[]` in the same response as the revised text
- Edit passes never alter examples, stories, or framework names; they add a flag instead

**Source material**

The operator will place `docs/sop.md` (the seven-stage production SOP) and `docs/publishing-system-v2.md` in the repo before Phase 0. Translate their instructions into the templates faithfully. Do not add rules of your own. Where the two documents disagree, follow `publishing-system-v2.md` and note the conflict in `docs/prompt-notes.md`.

**Post-processing**

Every text output passes through `sanitize()` in `packages/shared`: replace em and en dashes with a comma, period, or colon by context; strip emojis; normalize quotes; collapse triple blank lines. Log any replacement count above zero on the job so template drift is visible.

**Evaluation harness**

`scripts/eval.ts` runs a fixed brief and outline through the chapter and developmental templates and writes the output to `eval/<date>/`. Run it after any template change and link the output in the pull request.

## Worker service and job system

The worker is one long-running Node process that polls `pg-boss` queues and writes progress to `jobs_meta`. The web app only enqueues and reads.

**Job types**

| Job | Payload | Steps | Progress unit |
| --- | --- | --- | --- |
| `scan.lane` | lane, trigger (scheduled or manual), optional seed | expand seeds, fetch results, fetch Keepa history, translate pains, fetch Trends, score, write candidates, update watchlist | candidate phrases processed |
| `scan.phrase` | phrase, lane | same steps for one phrase | steps |
| `book.brief` | book\_id | load inputs, call template, write brief | one step |
| `book.outline` | book\_id | load brief, call template, write outline | one step |
| `book.draft` | book\_id, chapter positions\[\] or all | per chapter: build context, call template, sanitize, write version, update summary | chapters |
| `book.regen` | book\_id, chapter\_id, note | one chapter with the note appended | one step |
| `book.edit` | book\_id, passes\[\] (dev, line, copy, proof), intensity | per pass per chapter: call template, check 40 percent cap, write version and change log | pass x chapter |
| `book.matter` | book\_id | call matter template, assemble fixed pages from settings | one step |
| `book.export` | book\_id | assemble manuscript, render PDF, build EPUB, run EPUBCheck, generate metadata, run QA, upload to Storage, write exports row | steps |

**Rules**

- Each job writes `progress` at least every 15 seconds while running and on every unit completed
- A failed step retries twice with backoff; a third failure marks the job failed with the error text and leaves all earlier writes in place
- Jobs are idempotent per unit: rerunning `book.draft` never re-drafts a chapter that already has a version unless `force` is set
- The 40 percent cap in `book.edit` pauses the job with status `waiting_operator` and a message; the UI offers Apply or Skip
- Token counts from every AI call are summed onto `jobs_meta.tokens_in` and `tokens_out`
- The scheduler runs `scan.lane` for each lane on the cron expression in `settings.scan_schedule` (default Monday 03:00 America/Chicago)

**Container**

The Dockerfile installs Node 22, Pandoc, Playwright with Chromium, a Java runtime, and EPUBCheck. Keep the image under 2 GB. Health check endpoint on `/healthz` returns queue depth and last successful job time.

## Stage 0: Market Scan implementation

Build `packages/market` as pure functions with injected HTTP clients so every step is unit-testable with recorded fixtures. Record one real response per vendor into `packages/market/fixtures/` during development and never call vendors in tests.

**Step 1: Seed expansion (`expand.ts`)**

For each seed phrase in `settings.lanes[lane].seeds`, request Amazon completion suggestions for the bare phrase, the phrase plus each letter a to z, and the phrase plus each modifier in `settings.modifiers`. Deduplicate, drop suggestions under three words unless they match the seed exactly, and cap at 60 candidates per lane per scan. Throttle to one request per 600 ms. Log the raw suggestion count on the scan.

**Step 2: Results capture (`amazon.ts`)**

For each candidate call SerpApi's Amazon engine twice, once for Kindle Store and once for Books, page one only. Store for each of the top ten: asin, title, bsr, reviews, rating, pages, price, publisher, pub\_date. Store total\_results per department. Mark a title as traditional-publisher when `publisher` matches a maintained list in `settings.trad_publishers` or review count exceeds 2,000.

**Step 3: Sales history (`keepa.ts`)**

For each of the top ten ASINs request Keepa product data with history. Convert BSR history to a 12-month series sampled weekly. Compute `bsr_median_12m`, `bsr_median_90d`, and `stability` as 1 minus the coefficient of variation of the 12-month series, clamped 0 to 1. Keepa is Phase 3; stub it returning null in Phase 2 and treat stability as 0.5 when null.

**Step 4: Pain translation (`pain.ts`)**

Call the `pain-queries` template with the candidate phrase, lane, and the top ten titles. Require five to eight queries in reader language. Reject any query that contains the words book, guide, workbook, or author and ask the template for a replacement.

**Step 5: Trends (`trends.ts`)**

For each pain query call SerpApi's Google Trends engine for interest over time (past five years), related queries (rising and top), and interest by region. Run one comparison request per candidate against two sibling candidates from the same lane so scores are relative. Store the raw series.

**Step 6: Scoring (`score.ts`)**

Implement exactly this, with every weight read from `settings.scoring` so the operator can tune without a deploy:

```ts
estSales(bsr)            // KDP curve: piecewise log fit from settings.bsr_curve
demand   = norm( median(estSales(top10.bsr)) * (1 + 0.15*autocompleteHits) * (0.5 + 0.5*meanStability) )
competition = norm( log10(totalResults+1) * 0.4 + log10(meanReviews+1) * 0.4 + tradShare * 0.2 )
qualityGap  = norm( lowRatedSteadyShare*0.4 + oldShare*0.3 + thinShare*0.2 + weakDescShare*0.1 )
painSignal  = norm( interest12m*0.4 + slopeBonus(slope24m)*0.3 + solutionIntentShare*0.3 )
opportunity = norm( (demand * qualityGap * painSignal) / max(competition, 5) )
```

`norm` rescales 0 to 100 within the lane for this scan. `lowRatedSteadyShare` is the share of top ten with rating under 4.2 and stability above 0.6. `oldShare` is the share published over three years ago. `thinShare` is the share under 120 pages. `solutionIntentShare` is the share of related queries containing any phrase in `settings.solution_words`. `slopeBonus` maps a 24-month linear slope to 0 to 100 with zero slope at 50.

**Step 7: Quadrant**

`high` is at or above the lane median for that scan. Quadrant labels: `proven` (high demand, high pain), `underserved` (low demand, high pain), `crowded` (high demand, low pain), `ignore` (low, low).

**Step 8: Watchlist and alerts**

After scoring, update `watchlist.last_score` and `score_delta` for tracked phrases. Flag a candidate `shifted` when three or more of its top ten ASINs differ from the previous scan.

**Budget guard**

Estimate SerpApi calls before a scan starts (candidates x 2 Amazon + pain queries x 3 Trends). If the estimate exceeds `settings.scan_budget`, trim candidates by autocomplete hit count and log the trim.

## Stages 1 to 5 implementation

Build `packages/pipeline` as pure functions: each takes typed inputs and an AI client and returns typed outputs. The worker and `scripts/phase0.ts` both call the same functions, so Phase 0 and the app cannot drift.

**Stage 1: Brief (`brief.ts`)**

Inputs: book row, candidate evidence when present, voice profile. Call the `brief` template. Validate with the `BriefOutput` zod schema. Write the brief with `status = 'draft'`. The UI edits any field and sets `status = 'approved'` with `locked_at`. Any later edit to an approved brief sets `books.needs_drift_check = true` (add this column) and the developmental pass reads it.

**Stage 2: Outline (`outline.ts`)**

Inputs: approved brief, voice profile, target words. Call the `outline` template. Run `validateOutline()` before saving: every framework from the brief appears in at least one chapter, no two chapters share more than one key point (string similarity over 0.85), word targets within 10 percent of the total, every chapter has `example` and `action_step`. Return violations as a list the UI shows beside the outline. On approval, create `chapters` rows from the outline positions.

**Stage 3: Draft (`draft.ts`)**

`buildChapterContext(bookId, position)` assembles: brief, outline with the current chapter marked, voice profile, running summary of chapters 1 to position minus 1, the list of frameworks already introduced, word target. Call the `chapter` template, sanitize, count words, write a `versions` row with `source = 'draft'`, set `chapters.current_version_id`. Then call `summary` with the new chapter appended and store the result on `books.running_summary` (add this column, text). `regenChapter(chapterId, note)` does the same with the note added to the user prompt and `source = 'regen'`. Word count outside tolerance sets a `flag` on the version, never a rejection.

**Stage 4: Edit passes (`edit.ts`)**

`runPass(bookId, pass, intensity)` iterates chapters in order, skipping pinned and final chapters. For each: load current version, call the pass template with brief, outline, voice profile, and intensity; validate `EditOutput`; compute changed ratio with a word-level diff. If ratio exceeds 0.40, write nothing, set the job to `waiting_operator`, and return. Otherwise sanitize, write a new version with `source = pass`, write a `change_logs` row with the diff and the template's `changes[]` and `flags[]`, and advance `current_version_id`. Developmental pass also receives `needs_drift_check` and the diff between the approved brief and its latest edit when set.

**Stage 5: Matter (`matter.ts`)**

Call the `matter` template for introduction, conclusion, and Companion Course copy. Assemble fixed pages from `settings.templates[language]`: half title, title, copyright (year, identity, ISBN if present, lane disclaimer), dedication if set, about the author from `voice_profiles.bio_long`, Also By from `author_identities.also_by`, review request. Generate the QR code for the Companion Course URL with a pure JS library and store it as a data URI on the book. Output a single `ManuscriptModel` object: ordered sections with type, title, and Markdown body, which Stage 6 consumes.

## Stages 6 and 7: Export and QA

Build `packages/export` around the `ManuscriptModel`. Every renderer takes the model plus typography settings and returns a file buffer and a report.

**Print PDF (`pdf.ts`)**

Render the model to a single HTML document with a print stylesheet. Use `@page` rules for 6in x 9in, mirrored margins, running heads in `@top-left` and `@top-right`, and folios in `@bottom-center`. Display pages (half title, title, copyright, part openers) set `@page :blank` and chapter openers use `page-break-before: right`. Render with Playwright Chromium to PDF with `preferCSSPageSize: true`. Chromium's paged-media support is limited for running heads, so if the smoke test shows missing heads, switch the renderer to Pandoc with a LaTeX template in `packages/export/latex/` using the `memoir` class and the same margin bands. Both renderers implement `renderPdf(model, typo): Promise<{buffer, pageCount}>`.

Margins are chosen by page count after a first render pass: inside 0.375 in for 24 to 150 pages, 0.5 in for 151 to 300, 0.625 in for 301 to 500; outside, top, and bottom 0.5 in. Re-render if the band changes. Embed fonts; load Garamond from `packages/export/fonts/` (EB Garamond, OFL licensed) and fall back only if the setting names another installed font.

**EPUB (`epub.ts`)**

Write the model to Markdown with a Pandoc title block and chapter headings at level 1, then run `pandoc --to epub3 --toc --toc-depth 1 --epub-cover-image <path if set> --css epub.css`. Then run EPUBCheck and parse its JSON report. Zero errors is required; warnings are stored.

**DOCX (`docx.ts`)**

`pandoc --to docx --reference-doc reference-6x9.docx` from the same Markdown. This is the archive master and the Phase 0 output.

**Metadata (`metadata.ts`)**

Call the `metadata` template with the brief, the first 2,000 words, Stage 0 rising queries and autocomplete hits when present, and the top ten competitor titles. Validate lengths: description under 4,000 characters, each keyword under 50 characters, exactly seven keywords and two categories. Compute spine width as `pageCount * 0.002252` inches and include it with page count and word count for the cover designer.

**QA (`qa.ts`)**

Implement every check in SPEC.md Stage 7 as a function returning `{id, severity, passed, detail}`. Hard failures set `exports.release_ready = false` and block the download links in the UI. Checks that need the rendered PDF (orphan headings, widows, fonts embedded) parse the PDF with `pdf-lib` or `pdfjs-dist`; checks on text (em dashes, banned terms, framework coverage, matter order) run on the model. Store the full result array on `exports.qa_results`.

**Upload**

Write PDF, EPUB, and DOCX to the `exports` bucket at `books/<book_id>/<version_stamp>/`. Record paths on the `exports` row. Serve downloads through signed URLs that expire in one hour.

## UI screens and component rules

Five routes, built with shadcn/ui components and no custom design system. Function first; the operator reads manuscripts in this UI for hours, so legibility beats decoration.

| Route | Screen | Must have |
| --- | --- | --- |
| `/` | Library | Table of books with lane, identity, stage badge, word count, last activity; filters; New Book |
| `/scan` | Market Scan | Lane tabs; sortable candidate table with Opportunity Score and four sub-scores; quadrant scatter (Recharts); detail drawer with top ten, BSR sparkline, pain queries, rising queries; Watch, Dismiss, Start Book; Run Scan for a lane or a phrase |
| `/books/[id]` | Book Workspace | Left rail of Stages 1 to 7 with status; main panel per stage; right panel pinned to brief summary, outline, voice; version history drawer with restore; job progress bar; change log viewer with per-change revert |
| `/voices` | Voice Profiles | List; editor for every field; Test button rendering a 300-word sample |
| `/settings` | Settings | Lane seeds and modifiers; typography per lane; templates per language; Companion Course URL pattern; also-by lists; scoring weights; scan schedule; vendor key status (set, not shown) |

**Rules**

- The chapter editor is a Markdown editor with a preview toggle, not a WYSIWYG rich-text editor; manual saves create a `versions` row with `source = 'manual'`
- Every long action shows the job progress inline and a toast on completion; the page never blocks
- Diffs render word-level with additions and deletions colored; the operator can revert a single change from the change log
- Stage gates are enforced in the UI and in the API: a locked brief shows a Reopen button with a warning about drift checks
- Dark mode supported through shadcn theming; body text in the editor is at least 16 px
- No marketing pages, no onboarding tour, no empty-state illustrations

## Build order and acceptance criteria

Work one phase at a time. Do not start the next phase until the operator confirms the exit test in chat.

| Phase | Build | Exit test (operator confirms) |
| --- | --- | --- |
| 0: Prompt pipeline | Monorepo scaffold; `packages/shared`, `prompts`, `pipeline`; all templates from `docs/`; `scripts/phase0.ts` that takes a brief JSON and produces outline, chapters, four passes, change logs, and a DOCX via Pandoc; `scripts/eval.ts` | Two manuscripts produced from two different briefs; operator reads both and says he would publish them after his own light pass; template fixes made and re-run |
| 1: Core app | Supabase migrations and types; auth with allowlist; `apps/web` with Library and Book Workspace for Stages 1 to 4; `apps/worker` with pg-boss and the `book.*` jobs; versions, rollback, change logs, 40 percent cap flow; DOCX export; CI | One book carried from New Book through Stage 4 in the UI; any chapter restored to an earlier version; a pass that would exceed 40 percent pauses and resumes correctly |
| 2: Market Scan | `packages/market` with fixtures and tests; `scan.*` jobs and scheduler; `/scan` screen with table, quadrant, drawer, watchlist, Start Book; budget guard | One lane scanned end to end; operator hand-checks the top ten candidates against Amazon and Google Trends and adjusts weights in Settings; Start Book produces a pre-filled brief |
| 3: Export and QA | Voice Profiles screen; Stage 5 templates and matter assembly; PDF renderer (Playwright, with Pandoc LaTeX fallback tested side by side); EPUB plus EPUBCheck; metadata; all QA checks; Keepa integration; Settings screen | One book exported; PDF uploaded to KDP as a draft passes the previewer with no margin or font errors; EPUB passes EPUBCheck; metadata pasted into KDP without edits |
| 4: Harden | Spanish templates and language switch; shifted-candidate alerts; retry and error surfaces; backups; eval harness in CI; docs for deploy and recovery | Three books in flight at once move through stages with no manual intervention; a simulated SerpApi outage fails cleanly and the operator sees why |

Within a phase, work in this order: schema and types, pure functions with tests, job handlers, API routes, UI. Ship the thinnest vertical slice first and widen.

## Working agreement

**Before you build.** At the start of every session, read `CLAUDE.md`, `SPEC.md`, and `docs/STATUS.md`. Open with a plan of no more than ten lines: what you will build this session, which files you will touch, and what the operator will be able to test at the end. Wait for a go before writing code unless the plan is a direct continuation of the previous session's approved plan.

**While you build.** Work in small commits with messages in the form `phase1: add versions table and rollback query`. Run tests before every commit. When a decision is not covered by `SPEC.md` or this file, choose the simplest option that keeps the non-negotiables, record it in `docs/DECISIONS.md` with one line of reasoning, and mention it in your session summary. Never silently change a scoring weight, a margin value, a template rule, or a stage gate.

**When you are blocked.** Ask one specific question with the options you see and your recommendation. Do not stop work on everything else while waiting; move to the next item in the plan that does not depend on the answer.

**When you finish a session.** Update `docs/STATUS.md` with: phase and item completed, what the operator should test and how, open questions, and the next three items. Keep it under 40 lines; replace, do not append.

**What you never do.** Add a dependency without asking. Call a vendor from the browser. Store a key in code. Invent a KDP rule you have not verified against KDP's published specifications. Rewrite a prompt template because you think you can do better than the source documents. Mark a phase complete yourself; the operator does that.

**Tone.** Reports are plain and short. State what works, what does not, and what you need. No celebration, no filler, no em dashes, no emojis.

## Definition of done

The project is done when all of the following are true and the operator confirms each in writing.

- [ ] A weekly scan runs on its own for every lane and the operator can start a book from a candidate in one click
- [ ] A book moves from brief to release-ready export with no step outside the app
- [ ] Every chapter has a full version history and any version can be restored
- [ ] All four edit passes produce change logs and respect the 40 percent cap and the no-rewrite rule for examples and frameworks
- [ ] The print PDF passes the KDP previewer on first upload for a book in each page-count band
- [ ] The EPUB passes EPUBCheck with zero errors
- [ ] The metadata sheet pastes into the KDP form without edits
- [ ] Final text contains zero em dashes and zero emojis, verified by the QA check
- [ ] A Spanish edition runs through the same pipeline with Spanish fixed pages
- [ ] Every job type and API route has a passing test in CI
- [ ] `docs/DEPLOY.md` lets the operator redeploy both apps and restore the database from a backup without help
- [ ] Monthly vendor cost at four books per month is at or under $250, measured from the token and call counts on `jobs_meta`
