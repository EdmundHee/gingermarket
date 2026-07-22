# Procedure: Evolve (plugin self-improvement)

Called by `/ralph-helper:evolve`. Aggregates learnings **across projects**, detects
systematic patterns, and proposes edits to ralph-helper's own files for human
review. Read the safety contract in `commands/evolve.md` first — default is
dry-run, never touch `main`, propose only.

Input: **apply flag** (default off).

---

## Step 1 — Gather cross-project learnings

The cross-project store is the **Obsidian vault** (each project's `_MEMORY.md`
centralizes its lessons there), plus per-repo structured feeds:

- **Obsidian**: `~/.obsidian/GingerVault/Claude Code Logs/*/_MEMORY.md` → the
  `## Ralph Learnings` section of each project folder. This is the primary,
  already-centralized source. If no vault exists, fall back to Step 1b only.
- **Structured (1b)**: any reachable `./logs/*/learnings.json` in the current repo
  (and other repos the user points at) — richer fields (`iterations`, `retries`,
  `outcome`, `root_cause`).
- **Graphify**: each repo's `graphify-out/reflections/LESSONS.md` if present.

Collect every entry with its project, phase, outcome, iterations/retries, and
root cause. If nothing is found, stop and report "no learnings to aggregate yet".

## Step 2 — Detect systematic patterns

Only a pattern with **enough support** is actionable — require **≥3 occurrences
across ≥2 distinct projects** (avoid overfitting to one noisy run). Log what you
dropped for lack of support rather than silently ignoring it.

Pattern categories (extend as evidence warrants):

- **Iteration-estimate drift** — phases repeatedly use far more iterations than
  estimated (or far fewer). → Target `commands/go.md` STEP 4 / `commands/analyze.md`
  default estimate.
- **Recurring root cause** — the same class of failure across projects (e.g. "tests
  need an in-memory DB", "mocks drift from real signatures"). → Target
  `procedures/execute-phase.md` 6b guidance or `procedures/detect-test-framework.md`.
- **Gate / retry churn** — phases that consistently need all retries, or a
  completion-promise wording that keeps mis-firing. → Target the retry budget or
  wording in `execute-phase.md` 6c/6h.
- **Boundary violations** — phases that keep modifying files they shouldn't. →
  Strengthen the boundary derivation in `inject-context.md` GATHER.

## Step 3 — Compose concrete proposed edits

For each supported pattern, produce a **specific** edit: the target file, the exact
location, and old → new text — as a unified diff. Vague suggestions are not
allowed; if you can't name the file and line intent, the pattern isn't ready.

## Step 4 — Locate the plugin SOURCE (not the cache)

Edits target the marketplace **source** repo — the directory containing
`ralph-helper/.claude-plugin/plugin.json` under version control — NOT the installed
cache at `~/.claude/plugins/cache/...` (that's regenerated). Resolve it from the
plugin's `repository` field / the user's known checkout. If you can't find a
writable source checkout, stay in dry-run and tell the user where to apply the diff.

## Step 5 — Output

**Dry-run (default)** — write nothing to any ralph-helper file. Present each pattern
(with its supporting evidence count) and its proposed unified diff in chat.
Optionally write a proposal doc to `./logs/evolve/proposals-<date>.md` (a log file,
never a plugin file) for the user to keep. Date from `git log -1 --format=%cd --date=short`.

**Apply mode (`--apply`)** — in the source repo:
1. Create a fresh branch `ralph-helper/evolve/<date>` off the current branch.
2. Apply the proposed diffs **on that branch only**.
3. Do **not** commit to `main`; do **not** auto-merge. Leave the branch for the
   human to review, adjust, and merge.
4. Report the branch name and the files touched.

---

## Worked example (also the self-check)

Synthetic learnings across two projects:
`konnec` phase-3 estimated 5 / used 9; `droplet` phase-2 estimated 5 / used 8;
`droplet` phase-4 estimated 5 / used 10. → 3 occurrences, 2 projects → **supported**.

Pattern: iteration-estimate drift (default 5 is low). Proposed edit to
`commands/go.md` STEP 4:

```diff
-General guidance: default around 5, cap at 10.
+General guidance: default around 7, cap at 10. (Historical runs overshoot a
+default of 5 — see cross-project learnings.)
```

Dry-run: this diff is shown, `go.md` is **not** modified. Only `--apply` writes it,
and only to branch `ralph-helper/evolve/<date>`, never `main`. If the estimate data
had come from a single project or fewer than 3 phases, the pattern is dropped and
nothing is proposed.
