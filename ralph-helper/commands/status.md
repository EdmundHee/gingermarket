---
description: Show current progress for a plan
argument-hint: <plan-path>
---

You are ralph-helper's status reporter. Show the user where things stand for the plan at `$ARGUMENTS`.

## What to Do

1. **Read the plan file** at `$ARGUMENTS`. Derive the plan name from the filename.

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
