---
description: Resume execution from the last completed phase
argument-hint: [plan-path]
---

You are ralph-helper's resume handler. The user wants to continue execution of a plan from where it left off. If no plan path is provided, you will auto-detect the most recent plan with existing progress.

## Step 0: Resolve Plan Path

If `$ARGUMENTS` is not empty, use it as the plan path and skip to Step 1.

If `$ARGUMENTS` is empty (the user ran `/ralph-helper:resume` with no arguments):

1. Run `ls -t ~/.claude/plans/*.md` to list all plan files sorted by modification time (most recent first).
2. Filter out any file whose name contains `-agent-` (subagent plans).
3. If no files remain after filtering, tell the user: "No plan files found in `~/.claude/plans/`." and stop.
4. For each candidate (starting from most recent), derive the plan name from the filename and check if `./logs/<plan-name>/ralph-helper.json` exists. Prefer plans that have existing progress.
5. If a plan with existing progress is found, select it. If no plans have progress, select the most recent plan and note: "No previous run found for this plan. You may want to use `/ralph-helper:go` instead."
6. Read the first few lines of the selected file to extract the first heading as a brief summary.
7. Present to the user: the filename, full path, last modified time, summary heading, and progress status. If modified more than 24 hours ago, note the staleness.
8. Ask: "Is this the plan you want to resume?"
9. If the user confirms, use that file as the plan path and proceed to Step 1.
10. If the user says no, list the 5 most recent candidate files (with dates and summaries) and ask the user to pick one, or provide a path manually.

## What to Do

1. **Read the plan file** at the resolved plan path. If it doesn't exist, tell the user and stop.

2. **Find saved state**. Derive the plan name from the filename (e.g., `./plans/user-auth.md` becomes `user-auth`). Look for:
   - `./logs/<plan-name>/ralph-helper.json` — machine-readable state from the previous run
   - `./logs/<plan-name>/PROGRESS.md` — human-readable progress

   If neither exists, tell the user: "No previous run found for this plan. Use `/ralph-helper:go` to start from the beginning."

3. **Read the saved state** from `ralph-helper.json`:
   - Which phases are complete
   - Which phase was in progress or failed
   - Git tags that were created

4. **Verify git tag consistency**. Check that the git tags recorded in `ralph-helper.json` actually exist in the repo. If tags are missing or the repo state doesn't match, warn the user and ask how to proceed.

5. **Run regression tests**. Before resuming, run ALL completed phases' tests to make sure they still pass. The codebase may have been modified manually since the last run.
   - If regression tests fail: report which tests broke and stop. The user needs to fix regressions before resuming.
   - If regression tests pass: proceed.

6. **Identify the next phase** — the first phase that is not marked as `done` in `ralph-helper.json`.

7. **Resume execution** using the exact same logic as `/ralph-helper:go` Step 6 (prepare, compose prompt, invoke ralph-loop, verify, gate, advance). Continue through all remaining phases automatically.

8. **Final report** — same as `/ralph-helper:go` Step 7 when all phases complete.
