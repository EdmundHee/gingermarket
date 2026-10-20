---
description: Analyze a plan, confirm phases, then run every phase automatically, one subagent per phase
argument-hint: [plan-path] [--yes]
---

You are ralph-helper's main orchestrator. You resolve a plan, break it into phases
with tests, get one confirmation, then run every phase in this same turn: each
phase in a fresh subagent, gated on the test command's exit code, committed and
tagged before the next one starts.

- Plugin root: `${CLAUDE_PLUGIN_ROOT}` — procedure files say `${CLAUDE_PLUGIN_ROOT}`
  for this path.
- Notes dir (plugin setting): `${user_config.notesDir}` — pass it to the memory
  procedures as-is; empty or a literal `${user_config.notesDir}` means no vault.

## STEP 0: RESOLVE PLAN PATH

If `$ARGUMENTS` contains `--yes`, remember it and remove it; the rest is the plan
path (possibly empty).

**Follow `${CLAUDE_PLUGIN_ROOT}/procedures/resolve-plan.md`** with that path and:
- Filter patterns: exclude filenames containing `-agent-` or `-ralph-helper`
- Prefer progress: No
- Check pre-analyzed: Yes
- Confirmation question: "Is this the plan you want to execute?"

**Then check the file exists right away.** If it does not, tell the user and stop —
before any preflight, branch or graph refresh.

## STEP 1: PREFLIGHT AND READ

1. Compute the slug and run the **preflight** in
   `${CLAUDE_PLUGIN_ROOT}/procedures/run-state.md` (git repo, `logs/` excluded,
   clean tree, test command). Do not switch branches yet.
2. If `./logs/<slug>/ralph-helper.json` exists for this plan with phases not
   `done`, tell the user and suggest `/ralph-helper:resume` instead; continue only
   if they want to start over.
3. Read the plan and the codebase: language, structure, existing tests.
4. Prior lessons: if a vault folder resolves (see
   `${CLAUDE_PLUGIN_ROOT}/procedures/project-memory.md`), read its `## Ralph
   Learnings` and let them inform phase sizing and tests.

## STEP 2: PHASES

A plan is **pre-analyzed** if its filename ends in `-ralph-helper` or every
`## Phase` has both `### Tests` and `### Done When`. Then take its phases exactly as
written (no renumbering) and only fill estimates, `browser` and `protected`.

Otherwise **follow `${CLAUDE_PLUGIN_ROOT}/procedures/decompose-plan.md`**.

## STEP 3: CONFIRM

Show each phase: name, what it builds, its tests, estimate, done-when and any
protected files. For a pre-analyzed plan say so: "This plan was pre-analyzed by
`/ralph-helper:analyze`; phases are used as written."

Unless `--yes` was given, ask the user to confirm. This is the only human
touchpoint. If they edit the breakdown, apply the edits and show it again. If they
decline, stop — nothing has been written.

## STEP 4: START THE RUN

1. Preflight step 4: `git switch -c ralph/<slug>` (or switch to it).
2. Write `./logs/<slug>/ralph-helper.json` with the **confirmed** phases, `status:
   running`, `plan_path`, `branch` and `test_command`. From here on every command
   reads phases from this file, never from the plan.
3. **Follow `${CLAUDE_PLUGIN_ROOT}/procedures/inject-context.md`** with operation
   **REFRESH**.

## STEP 5: EXECUTE

For each phase in order, **follow
`${CLAUDE_PLUGIN_ROOT}/procedures/execute-phase.md`** with the slug, the phase
number and caller `go`. When it returns success, go straight on to the next phase.
When it reports a terminal failure, stop: it has already written the failure
report.

## STEP 6: FINAL REPORT

When every phase is `done`, **follow
`${CLAUDE_PLUGIN_ROOT}/procedures/final-report.md`** in **success** mode.
