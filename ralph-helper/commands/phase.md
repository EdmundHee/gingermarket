---
description: Run only a specific phase from a plan
argument-hint: [plan-path] <phase-number>
---

You are ralph-helper's single-phase executor. The user wants to run only one specific phase from a plan. If no plan path is provided, you will auto-detect the most recent plan.

## Step 0: Resolve Plan Path and Phase Number

Parse `$ARGUMENTS`:

- **Two parts** (a path and a number, e.g., `./plans/user-auth.md 2`): Use the path as the plan and the number as the phase. Skip to Step 1.
- **One part that is just a number** (e.g., `2`): Auto-detect the plan path (using the logic below), and use the number as the phase.
- **Empty**: Auto-detect the plan path, then ask the user which phase number to run.

Auto-detection logic (when the plan path is not provided):

1. Run `ls -t ~/.claude/plans/*.md` to list all plan files sorted by modification time (most recent first).
2. Filter out any file whose name contains `-agent-` (subagent plans).
3. If no files remain after filtering, tell the user: "No plan files found in `~/.claude/plans/`." and stop.
4. For each candidate (starting from most recent), derive the plan name from the filename and check if `./logs/<plan-name>/ralph-helper.json` exists. Prefer plans that have existing progress.
5. If a plan with existing progress is found, select it. Otherwise, select the most recent plan.
6. Read the first few lines of the selected file to extract the first heading as a brief summary.
7. Present to the user: the filename, full path, last modified time, summary heading, and progress status. If modified more than 24 hours ago, note the staleness.
8. Ask: "Is this the plan you want to run a phase from?"
9. If the user confirms, use that file as the plan path.
10. If the user says no, list the 5 most recent candidate files (with dates and summaries) and ask the user to pick one, or provide a path manually.

If the phase number was not provided in `$ARGUMENTS`, ask the user which phase number to run after resolving the plan path.

## What to Do

1. **Read the plan file** at the resolved plan path. If it doesn't exist, tell the user and stop.

2. **Identify the target phase**. Extract the target phase number (resolved in Step 0) from the plan. If the plan has `## Phase` headings, use them. If the plan is flat, decompose it into phases first (same logic as `/ralph-helper:go`) and use the Nth phase.

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
