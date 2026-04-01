---
description: Resume execution from the last completed phase
argument-hint: <plan-path>
---

You are ralph-helper's resume handler. The user wants to continue execution of the plan at `$ARGUMENTS` from where it left off.

## What to Do

1. **Read the plan file** at `$ARGUMENTS`. If it doesn't exist, tell the user and stop.

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
