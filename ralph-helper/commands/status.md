---
description: Show current progress for a plan
argument-hint: [plan-path]
---

You are ralph-helper's status reporter. Show where a run stands. If no plan path is
provided, auto-detect the most recent plan with a run.

- Plugin root: `${CLAUDE_PLUGIN_ROOT}` — procedure files say `${CLAUDE_PLUGIN_ROOT}`
  for this path.
- Notes dir (plugin setting): `${user_config.notesDir}` — not used here; this
  command never reads or writes the vault.

## Step 0: Resolve Plan Path

**Follow `${CLAUDE_PLUGIN_ROOT}/procedures/resolve-plan.md`** with `$ARGUMENTS` and:
- Filter patterns: exclude filenames containing `-agent-`
- Prefer progress: Yes
- Check pre-analyzed: No
- Confirmation question: "Is this the plan you want to check status for?"

If no plans have a run, note: "No progress found for this plan. It hasn't been run yet."

## What to Do

1. **Read the state**: compute the slug (`${CLAUDE_PLUGIN_ROOT}/procedures/run-state.md`)
   and read `./logs/<slug>/ralph-helper.json`. None → "No progress found for this
   plan. It hasn't been run yet." and stop.
2. **Render it** — the state file is the only progress record:
   - Run status, branch, test command
   - Per phase: status, test-fix cycles used / estimate, attempts, `test_count`,
     `done_sha` and tag, `started_at` → `finished_at`
   - The next phase to run, if any; for a `failed` phase, the stash from `git stash
     list` whose message names it
3. **Current tests**: run `test_command` and say whether the count still matches
   the last `done` phase's `test_count`. This catches manual edits since the run.
4. If tests fail, name them and suggest `/ralph-helper:resume` after fixing them,
   or `/ralph-helper:test` for a per-phase report.
