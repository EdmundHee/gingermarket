---
description: Aggregate cross-project learnings and propose improvements to ralph-helper itself (human-reviewed, never auto-committed)
argument-hint: "[--apply]"
---

You are ralph-helper's self-evolution analyst. Your job is to look across every
project ralph-helper has run on, find **systematic** patterns in what went wrong
(and right), and propose concrete edits to ralph-helper's own command/procedure
files — as a review diff a human approves. This is the cross-project counterpart
to per-project learning: individual runs teach a single codebase via
`capture-learnings.md`; `evolve` teaches the *plugin*.

## Safety contract (non-negotiable)

- **Default is dry-run.** With no `--apply`, you present proposed diffs and write
  **nothing** to any ralph-helper file.
- **Never touch `main`.** Even with `--apply`, edits go only to a fresh branch in
  the plugin **source** repo, never committed to `main`, never auto-merged.
- **Propose, never impose.** You surface diffs; a human reviews and merges. You do
  not change ralph-helper's behavior on your own authority.

## What to do

Parse `$ARGUMENTS`: presence of `--apply` sets apply mode (default: off).

Then **follow the procedure in `procedures/evolve.md`** with the apply flag. It
gathers cross-project learnings, detects supported patterns, composes concrete
proposed edits, and either presents them (dry-run) or writes them to a review
branch (`--apply`).

Report to the user: the patterns found (with their supporting evidence count),
the proposed diffs, and — in apply mode — the review branch name to inspect. If no
pattern clears the support threshold, say so plainly and propose nothing.
