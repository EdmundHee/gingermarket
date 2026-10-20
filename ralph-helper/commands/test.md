---
description: Run all tests across completed phases (regression suite)
argument-hint: [plan-path]
---

You are ralph-helper's test runner. Run the run's test command and report results
against what each phase recorded. If no plan path is provided, auto-detect the
most recent plan with a run.

- Plugin root: `${CLAUDE_PLUGIN_ROOT}` — procedure files say `${CLAUDE_PLUGIN_ROOT}`
  for this path.
- Notes dir (plugin setting): `${user_config.notesDir}` — not used here; this
  command never reads or writes the vault.

## Step 0: Resolve Plan Path

**Follow `${CLAUDE_PLUGIN_ROOT}/procedures/resolve-plan.md`** with `$ARGUMENTS` and:
- Filter patterns: exclude filenames containing `-agent-`
- Prefer progress: Yes
- Check pre-analyzed: No
- Confirmation question: "Is this the plan you want to run tests for?"

If no plans have a run, tell the user: "No plans with previous runs found. Nothing to test." and stop.

## What to Do

1. **Read the state**: compute the slug (`${CLAUDE_PLUGIN_ROOT}/procedures/run-state.md`)
   and read `./logs/<slug>/ralph-helper.json`. None → "No previous run found for
   this plan. Nothing to test." and stop.
2. **Run** the state's `test_command`. Never re-detect the framework.
3. **Report**:
   - Exit code, passing / total
   - Per `done` phase: its name, its recorded `test_count`, and whether its
     `tests` entries still pass (match names in the output)
   - **Regressions**: passing count below the last `done` phase's `test_count`, or
     any failure in a test from a `done` phase's `test_files`
4. **Guidance** if tests fail: the phase that most likely introduced it (from
   `test_files`), `/ralph-helper:phase <plan> <N>` to rerun it, or
   `/ralph-helper:resume <plan>` for an unfinished run.

Do NOT run any phase or change any file. This command only runs tests and reports.
