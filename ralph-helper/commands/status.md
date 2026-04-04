---
description: Show current progress for a plan
argument-hint: [plan-path]
---

You are ralph-helper's status reporter. Show the user where things stand for a plan. If no plan path is provided, you will auto-detect the most recent plan with existing progress.

## Step 0: Resolve Plan Path

If `$ARGUMENTS` is not empty, use it as the plan path and skip to Step 1.

If `$ARGUMENTS` is empty (the user ran `/ralph-helper:status` with no arguments):

1. Run `ls -t ~/.claude/plans/*.md` to list all plan files sorted by modification time (most recent first).
2. Filter out any file whose name contains `-agent-` (subagent plans).
3. If no files remain after filtering, tell the user: "No plan files found in `~/.claude/plans/`." and stop.
4. For each candidate (starting from most recent), derive the plan name from the filename and check if `./logs/<plan-name>/ralph-helper.json` exists. Prefer plans that have existing progress.
5. If a plan with existing progress is found, select it. If no plans have progress, select the most recent plan and note: "No progress found for this plan. It hasn't been run yet."
6. Read the first few lines of the selected file to extract the first heading as a brief summary.
7. Present to the user: the filename, full path, last modified time, summary heading, and progress status. If modified more than 24 hours ago, note the staleness.
8. Ask: "Is this the plan you want to check status for?"
9. If the user confirms, use that file as the plan path and proceed to Step 1.
10. If the user says no, list the 5 most recent candidate files (with dates and summaries) and ask the user to pick one, or provide a path manually.

## What to Do

1. **Read the plan file** at the resolved plan path. Derive the plan name from the filename.

2. **Read progress files**:
   - `./logs/<plan-name>/PROGRESS.md` — human-readable progress
   - `./logs/<plan-name>/ralph-helper.json` — machine-readable state

   If neither exists, tell the user: "No progress found for this plan. It hasn't been run yet."

3. **Present a clear summary**:
   - Overall status (in progress, completed, failed)
   - For each phase:
     - Status (completed, in progress, failed, not started)
     - Iterations used / max
     - Tests: passing / total
     - Retries used
     - Git tags (start and done)
     - Duration if available
   - Next phase to be executed (if any remain)

4. **Check current test state**. Run the test suite and report whether all completed phases' tests are currently passing. This catches cases where manual changes may have introduced regressions since the last run.

5. If tests are failing, report which ones and suggest running `/ralph-helper:resume` after fixing them, or `/ralph-helper:test` for a detailed test report.
