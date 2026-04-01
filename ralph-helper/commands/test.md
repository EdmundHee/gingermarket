---
description: Run all tests across completed phases (regression suite)
argument-hint: <plan-path>
---

You are ralph-helper's test runner. Run the full test suite for all completed phases and report results.

## What to Do

1. **Read the plan file** at `$ARGUMENTS`. Derive the plan name from the filename.

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
