---
description: Run all tests across completed phases (regression suite)
argument-hint: [plan-path]
---

You are ralph-helper's test runner. Run the full test suite for all completed phases and report results. If no plan path is provided, you will auto-detect the most recent plan with existing progress.

## Step 0: Resolve Plan Path

If `$ARGUMENTS` is not empty, use it as the plan path and skip to Step 1.

If `$ARGUMENTS` is empty (the user ran `/ralph-helper:test` with no arguments):

1. Run `ls -t ~/.claude/plans/*.md` to list all plan files sorted by modification time (most recent first).
2. Filter out any file whose name contains `-agent-` (subagent plans).
3. If no files remain after filtering, tell the user: "No plan files found in `~/.claude/plans/`." and stop.
4. For each candidate (starting from most recent), derive the plan name from the filename and check if `./logs/<plan-name>/ralph-helper.json` exists. Prefer plans that have existing progress.
5. If a plan with existing progress is found, select it. If no plans have progress, tell the user: "No plans with previous runs found. Nothing to test." and stop.
6. Read the first few lines of the selected file to extract the first heading as a brief summary.
7. Present to the user: the filename, full path, last modified time, summary heading, and progress status. If modified more than 24 hours ago, note the staleness.
8. Ask: "Is this the plan you want to run tests for?"
9. If the user confirms, use that file as the plan path and proceed to Step 1.
10. If the user says no, list the 5 most recent candidate files (with dates and summaries) and ask the user to pick one, or provide a path manually.

## What to Do

1. **Read the plan file** at the resolved plan path. Derive the plan name from the filename.

2. **Read saved state** from `./logs/<plan-name>/ralph-helper.json`. If it doesn't exist, tell the user: "No previous run found for this plan. Nothing to test."

3. **Detect the test framework**. Read the codebase to find the test runner:
   - Python: look for `pytest.ini`, `pyproject.toml` (pytest section), `setup.cfg`
   - JavaScript/TypeScript: look for `jest.config.*`, `vitest.config.*`, `package.json` test scripts
   - Go: `go.mod` present means `go test ./...`
   - Other: look for common test config files

4. **Run ALL tests** across all completed phases. Use the detected test framework.

5. **Report results per phase**:
   - For each completed phase:
     - Phase name
     - Number of tests passing / total
     - Any failures: test name, error message, relevant file
   - Overall summary:
     - Total tests: passing / total
     - Any regressions since the last run (compare against ralph-helper.json recorded test counts)

6. **Provide actionable guidance** if tests are failing:
   - Which phase introduced the failure (if determinable)
   - Suggest running `/ralph-helper:phase <plan> <N>` to re-run a specific phase
   - Suggest running `/ralph-helper:resume <plan>` if the failure is in an incomplete phase

Do NOT execute any phases or invoke ralph-loop. This command only runs tests and reports.
