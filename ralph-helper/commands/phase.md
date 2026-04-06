---
description: Run only a specific phase from a plan
argument-hint: [plan-path] <phase-number>
---

You are ralph-helper's single-phase executor. The user wants to run only one specific phase from a plan. If no plan path is provided, you will auto-detect the most recent plan.

## Step 0: Resolve Plan Path and Phase Number

Parse `$ARGUMENTS`:

- **Two parts** (a path and a number, e.g., `./plans/user-auth.md 2`): Use the path as the plan and the number as the phase. Skip to Step 1.
- **One part that is just a number** (e.g., `2`): Auto-detect the plan path (using the procedure below), and use the number as the phase.
- **Empty**: Auto-detect the plan path, then ask the user which phase number to run.

**Follow the procedure in `procedures/resolve-plan.md`** (when auto-detection is needed) with:
- Filter patterns: exclude filenames containing `-agent-`
- Prefer progress: Yes
- Check pre-analyzed: No
- Confirmation question: "Is this the plan you want to run a phase from?"

If the phase number was not provided in `$ARGUMENTS`, ask the user which phase number to run after resolving the plan path.

## What to Do

1. **Read the plan file** at the resolved plan path. If it doesn't exist, tell the user and stop.

2. **Identify the target phase**. Extract the target phase number (resolved in Step 0) from the plan. If the plan has `## Phase` headings, use them. If the plan is flat, decompose it into phases first (reason about dependency order, testability boundaries, and sizing at 3-8 iterations per phase) and use the Nth phase.

   If the phase number is out of range, tell the user how many phases exist and stop.

3. **Read saved state** if it exists (`./logs/<plan-name>/ralph-helper.json`). Check whether this phase was already completed, failed, or not started.

4. **Run regression tests** for all phases prior to the target phase. If earlier phases' tests are failing, warn the user — running this phase on a broken foundation is risky. Ask whether to proceed anyway.

5. **Execute the single phase** by following the procedure in `procedures/execute-phase.md` with the phase's plan name, phase number, objectives, test requirements, iteration estimate, completion criteria, and previous phase context.

6. **Report results** for this single phase: tests passing, iterations used, files changed.

Do NOT automatically proceed to subsequent phases. This command runs only the specified phase.
