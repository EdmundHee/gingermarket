---
description: Run only a specific phase from a plan
argument-hint: [plan-path] <phase-number>
---

You are ralph-helper's single-phase executor. The user wants to (re)run one phase of
a run that `/ralph-helper:go` started.

- Plugin root: `${CLAUDE_PLUGIN_ROOT}` — procedure files say `${CLAUDE_PLUGIN_ROOT}`
  for this path.
- Notes dir (plugin setting): `${user_config.notesDir}` — empty or a literal
  `${user_config.notesDir}` means no vault.

## Step 0: Resolve Plan Path and Phase Number

Split `$ARGUMENTS` on whitespace. If the **last** token is a whole number, it is the
phase number and the tokens before it are the plan path; otherwise all of it is the
plan path and the phase number is unknown.

**Follow `${CLAUDE_PLUGIN_ROOT}/procedures/resolve-plan.md`** with **only the path
part** (empty when just a number was given) and:
- Filter patterns: exclude filenames containing `-agent-`
- Prefer progress: Yes
- Check pre-analyzed: No
- Confirmation question: "Is this the plan you want to run a phase from?"

If the phase number is unknown, ask which phase to run.

## What to Do

1. **Read the state**: compute the slug (`run-state.md`) and read
   `./logs/<slug>/ralph-helper.json`. None → "No run for this plan yet. Run
   `/ralph-helper:go` first." and stop. A phase number outside `1..N` → say how
   many phases exist and stop.
2. **Preflight** (`${CLAUDE_PLUGIN_ROOT}/procedures/run-state.md`): git repo,
   `logs/` excluded, clean tree, then `git switch <branch>`.
3. **Prerequisites**: every phase before the target must be `done`. If any is not,
   list them and stop. A phase whose prerequisites never ran cannot be trusted.
4. **REFRESH**: **follow `${CLAUDE_PLUGIN_ROOT}/procedures/inject-context.md`**
   REFRESH.
5. **Execute** the phase: **follow
   `${CLAUDE_PLUGIN_ROOT}/procedures/execute-phase.md`** with the slug, the phase
   number and caller `phase`.
6. **Later phases**: if the phase passed and later phases are `done`, run
   `test_command`. If it fails or the count drops below their `test_count`, mark
   those later phases `stale` and say so; `/ralph-helper:resume` reruns them.
7. **Report**: tests passing, test-fix cycles used, files changed, any phases now
   `stale`.

Do NOT go on to other phases. This command runs only the one phase.
