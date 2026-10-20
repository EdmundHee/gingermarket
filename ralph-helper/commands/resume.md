---
description: Resume execution from the first phase that is not done
argument-hint: [plan-path]
---

You are ralph-helper's resume handler. The user wants to continue a run from where
it stopped: after an interruption, or after fixing a phase that failed.

- Plugin root: `${CLAUDE_PLUGIN_ROOT}` — procedure files say `${CLAUDE_PLUGIN_ROOT}`
  for this path.
- Notes dir (plugin setting): `${user_config.notesDir}` — empty or a literal
  `${user_config.notesDir}` means no vault.

## Step 0: Resolve Plan Path

**Follow `${CLAUDE_PLUGIN_ROOT}/procedures/resolve-plan.md`** with `$ARGUMENTS` and:
- Filter patterns: exclude filenames containing `-agent-`
- Prefer progress: Yes
- Check pre-analyzed: No
- Confirmation question: "Is this the plan you want to resume?"

## What to Do

1. **Read the state**: compute the slug (`run-state.md`) and read
   `./logs/<slug>/ralph-helper.json`. None → "No previous run found for this plan.
   Use `/ralph-helper:go` to start." and stop. Phases come from this file only.
2. **Preflight** (`${CLAUDE_PLUGIN_ROOT}/procedures/run-state.md`): git repo,
   `logs/` excluded, clean tree, then `git switch <branch>`.
3. **Checkpoints**: every `done` phase's `done_sha` must exist (`git cat-file -e
   <sha>`). A missing one → tell the user which and ask how to proceed; never guess.
4. **REFRESH**: **follow `${CLAUDE_PLUGIN_ROOT}/procedures/inject-context.md`**
   REFRESH, so the graph sees any manual edits.
5. **Regression gate**: if any phase is `done`, run `test_command`. Non-zero exit,
   or fewer passing tests than the last `done` phase's `test_count` → report the
   failures and stop; the user fixes regressions first.
6. **Run** each phase that is `pending`, `failed` or `stale`, in order: **follow
   `${CLAUDE_PLUGIN_ROOT}/procedures/execute-phase.md`** with the slug, phase
   number and caller `resume`. Set the run `status: running` first. Stop at a
   terminal failure.
7. **Final report**: when all phases are `done`, **follow
   `${CLAUDE_PLUGIN_ROOT}/procedures/final-report.md`** in **success** mode.
