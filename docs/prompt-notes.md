# Prompt notes

How the templates in `prompts/` were translated from `docs/sop.md` and `docs/publishing-system-v2.md`. Each template lists its sources in its front matter. Where the two documents disagree, `publishing-system-v2.md` wins. Where `SPEC.md` disagrees with a source document, the conflict is listed here for the operator to settle.

## Conflicts between the source documents

1. Edit pass structure. The SOP's Stage 4 has structural, cut, fact, example, line, and action passes. Publishing System v2 defines four passes (developmental, line, copy, proof) and says its definitions are authoritative. The templates follow v2. The SOP's structural, cut (10 to 20 percent reduction), example, and action checks sit inside the developmental pass, where v2's "cuts, moves, merges, reorders" and "missing steps" cover them.
2. Grammar. The SOP puts grammar in its line pass; v2 puts it in the copyedit. Followed v2. The SOP's "reading level" and "remaining AI patterns" stay in the line pass because v2 does not place them anywhere else.
3. Unverified claims. The SOP's fact pass says to remove or replace anything that cannot be verified. v2's copyedit flags claims the ledger cannot verify. Followed v2: the copy pass flags and never deletes; the operator decides.
4. Pricing. The SOP sets ebooks at $2.99 to $5.99 and paperbacks to clear $3 net. v2's price ladder sets Catalog Lane at $4.99 to $7.99 ebook and $12.99 to $15.99 paperback, and Authority Lane at $6.99 to $9.99 and $16.99 to $19.99. The metadata template uses v2.
5. Drafting source. The SOP drafts with AI from the spec. v2 makes the drafting source a per-book setting: Authority Lane titles under Michael's name are dictated and AI edits only; Catalog Lane titles may be AI-drafted. Phase 0 implements the AI-drafted path. The voice-first path needs a transcript cleanup template that is not in CLAUDE.md's template list (open question).

## Conflicts between SPEC.md and the source documents

6. Developmental pass and missing material. SPEC says the developmental pass fixes "weak or missing examples and action steps." v2 says the developmental pass never writes new passages and turns anything that needs new material into a MISSING flag, and CLAUDE.md non-negotiable 5 says passes flag examples. The template flags.
7. Book promise length. The SOP says the promise is one sentence; SPEC says one paragraph. The brief template uses one sentence, plus the reader job sentence from v2.
8. Chapter count. The SOP sets 8 to 12 chapters for Tier 2; SPEC says 8 to 14. The range is a setting (`chapter_min`, `chapter_max`), defaulting to the SOP's 8 to 12.
9. Course placements. The SOP's course track places the course three times: a front matter course page, a mid-book callout after the most actionable chapter, and the back matter offer. SPEC's Stage 5 lists only the back matter Companion Course page. Phase 0 produces the back matter page and a conclusion that points to the course.

## Interpretations made to implement the documents

10. `PROPOSED:` prefix. The SOP requires real, concrete, original examples from the spec. When the operator supplies fewer than the book needs, the brief and outline templates may propose one but must mark it `PROPOSED:` so it is confirmed or replaced at approval.
11. "Do not invent statistics or studies" in the chapter template applies v2's claim ledger and stop-on-no-evidence rule and the SOP's fact-check list to an AI-drafted chapter.
12. Intensity. SPEC names light, standard, and deep but no source defines them. Wording used: light makes only the edits the pass clearly requires; standard applies the pass in full; deep applies it in full and examines every paragraph. The SOP's 10 to 20 percent cut target is tied to standard.
13. Guards. v2's voice guard and fact guard run in code (see DECISIONS.md). The voice guard's "hedging you do not use" and "generic coaching language" have no list in either source; the guard uses the voice profile's banned terms, so the operator's list is the definition.
14. The 40 percent limit is stated in every edit template and also enforced in code (CLAUDE.md non-negotiable 6).
15. KDP description HTML. The metadata template asks for simple HTML (paragraphs, bold, italics, lists). The exact tags KDP accepts have not been verified against KDP's published help in this session; verify before Phase 3 ships.

## Source instructions not yet encoded

16. SOP Stage 3 step 7, the AI-tell scan and cliche scrub. Neither document defines the list. Until one exists, put the phrases in the voice profile's banned terms, where the QA check and the voice guard both enforce them.
17. SOP Stage 4 step 8, the half-page editor's note (promise delivered or not, biggest weakness, rewrite needed). Not in CLAUDE.md's template list. Phase 0's `report.md` collects every flag, including `rewrite` flags, but makes no judgment of its own.
18. SOP Stage 2 steps 9, 11, 12 (keywords and categories, course outcome and lessons, next book). Keywords and categories come from the metadata template in Stage 6; the course and next-book fields have no template yet.
19. v2 back matter (next title preview, series list, reader magnet). Stage 5 fixed pages, Phase 3.
