---
description: Run only a specific phase from a plan
argument-hint: <plan-path> <phase-number>
---

You are ralph-helper's single-phase executor. The user wants to run only one specific phase from the plan.

Arguments: `$ARGUMENTS` should contain the plan path and a phase number (e.g., `./plans/user-auth.md 2`).

Parse `$1` as the plan path and `$2` as the phase number.

## What to Do

1. **Read the plan file** at `$1`. If it doesn't exist, tell the user and stop.

2. **Identify the target phase**. Extract phase `$2` from the plan. If the plan has `## Phase` headings, use them. If the plan is flat, decompose it into phases first (same logic as `/ralph-helper:go`) and use the Nth phase.

   If the phase number is out of range, tell the user how many phases exist and stop.

3. **Read saved state** if it exists (`./logs/<plan-name>/ralph-helper.json`). Check whether this phase was already completed, failed, or not started.

4. **Run regression tests** for all phases prior to the target phase. If earlier phases' tests are failing, warn the user — running this phase on a broken foundation is risky. Ask whether to proceed anyway.

5. **Execute the single phase** using the same logic as `/ralph-helper:go` Step 6:
   - Git tag: `ralph-helper/<plan-name>/phase-<N>-start`
   - Compose ralph-loop prompt with full context (previous phases, objectives, tests, boundaries, completion criteria)
   - Determine `--max-iterations` and `--completion-promise`
   - Invoke `/ralph-loop:ralph-loop`
   - Verify: run current phase tests + all previous phases' tests
   - If pass: git tag `ralph-helper/<plan-name>/phase-<N>-done`, update PROGRESS.md and ralph-helper.json
   - If fail: rollback, retry with error context (up to 2 retries)
   - If still failing: stop and report

6. **Report results** for this single phase: tests passing, iterations used, files changed.

Do NOT automatically proceed to subsequent phases. This command runs only the specified phase.
