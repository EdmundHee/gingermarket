---
description: Resume execution from the last completed phase
argument-hint: [plan-path]
---

You are ralph-helper's resume handler. The user wants to continue execution of a plan from where it left off. If no plan path is provided, you will auto-detect the most recent plan with existing progress.

## Step 0: Resolve Plan Path

**Follow the procedure in `procedures/resolve-plan.md`** with:
- Filter patterns: exclude filenames containing `-agent-`
- Prefer progress: Yes
- Check pre-analyzed: No
- Confirmation question: "Is this the plan you want to resume?"

If no plans have progress, note: "No previous run found for this plan. You may want to use `/ralph-helper:go` instead."

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

7. **Resume execution** by following the procedure in `procedures/execute-phase.md` for each remaining phase. Loop through all remaining phases sequentially, providing each phase's plan name, phase number, objectives, test requirements, iteration estimate, completion criteria, and previous phase context.

8. **Final report** — follow the procedure in `procedures/final-report.md` when all phases complete.
