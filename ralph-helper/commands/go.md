---
description: Analyze a plan, confirm phases, then execute all phases automatically via ralph-loop
argument-hint: [plan-path]
---

You are ralph-helper's main orchestrator. If no plan path is provided, you will auto-detect the most recent plan. If this is a pre-analyzed plan (from `/ralph-helper:analyze`), trust its structure and skip redundant decomposition. Otherwise, read it, break it into executable phases with unit tests, get confirmation, and drive the entire build automatically using ralph-loop.

## STEP 0: RESOLVE PLAN PATH

If `$ARGUMENTS` is not empty, use it as the plan path and skip to Step 1.

If `$ARGUMENTS` is empty (the user ran `/ralph-helper:go` with no arguments):

1. Run `ls -t ~/.claude/plans/*.md` to list all plan files sorted by modification time (most recent first).
2. Filter out any file whose name contains `-agent-` (subagent plans) or `-ralph-helper` (already-analyzed plans).
3. If no files remain after filtering, tell the user: "No plan files found in `~/.claude/plans/`. Create a plan first using plan mode." and stop.
4. Take the most recently modified file from the filtered list.
5. **Check for a pre-analyzed variant**: If the candidate is `foo.md`, check if `foo-ralph-helper.md` exists in the same directory. If it does and it is at least as recent as the base plan, prefer the `-ralph-helper` variant (since `go` benefits from pre-analyzed plans). Note this to the user: "A pre-analyzed version of this plan exists. Using that for optimized execution."
6. Read the first few lines of the selected file to extract the first heading as a brief summary.
7. Present to the user: the filename, full path, last modified time, and summary heading. If modified more than 24 hours ago, note the staleness.
8. Ask: "Is this the plan you want to execute?"
9. If the user confirms, use that file as the plan path and proceed to Step 1.
10. If the user says no, list the 5 most recent candidate files (with dates and summaries) and ask the user to pick one, or provide a path manually.

## STEP 1: READ AND UNDERSTAND

Read the plan file at the resolved plan path. Also read the codebase:

- What language(s) is this project using?
- What test framework is configured (pytest, jest, go test, vitest, etc.)? Look for config files like `pytest.ini`, `pyproject.toml`, `jest.config.*`, `vitest.config.*`, `package.json` test scripts, `go.mod`, etc.
- What existing patterns exist (project structure, naming conventions, existing tests)?
- Is there an existing `./logs/` directory or `PROGRESS.md` from a previous run?

If the plan file does not exist, tell the user and stop.

## STEP 1.5: DETECT PRE-ANALYZED PLAN

After reading the plan, determine if it is a pre-analyzed plan from `/ralph-helper:analyze`. A plan is considered pre-analyzed if:

1. The filename contains `-ralph-helper` (e.g., `my-feature-ralph-helper.md`), **OR**
2. The plan has `## Phase` headings where every phase contains both a `### Tests` subsection and a `### Done When` subsection

If the plan IS pre-analyzed:
- Trust the phase structure exactly as written. Do not re-decompose, re-number, or modify the phases.
- Skip STEP 2 (Decompose into Phases) entirely.
- Skip STEP 3 (Ensure Every Phase Has Tests) entirely — the tests are already defined.
- Skip STEP 4 (Estimate Iterations) — instead, estimate iterations inline during STEP 5 presentation.
- Proceed directly to STEP 5 (Present for Confirmation) with the phases as defined in the file.

If the plan is NOT pre-analyzed:
- Proceed through all steps normally (STEP 2 through STEP 7 unchanged).

## STEP 2: DECOMPOSE INTO PHASES

*Skip this step if the plan was detected as pre-analyzed in Step 1.5.*

If the plan already has `## Phase` headings, use them as the phase boundaries. Read the `### Tests` and `### Done When` subsections if present.

If the plan is flat (no phase headings), reason about:

- **Dependency order**: What needs to exist before the next thing can be built?
- **Testability boundaries**: Each phase should end with something verifiable.
- **Size**: Each phase should be achievable in roughly 3-8 ralph-loop iterations. If a phase looks like it needs more than 10, suggest splitting it.

## STEP 3: ENSURE EVERY PHASE HAS TESTS

*Skip this step if the plan was detected as pre-analyzed in Step 1.5.*

This is non-negotiable. For each phase:

- If the plan specifies tests for this phase, use them.
- If the plan does NOT specify tests, determine what a competent developer would test for what's being built in this phase. Consider:
  - Unit tests for new functions/methods/components
  - Integration tests if the phase connects multiple components
  - Edge cases and error handling
  - For Phase 2+: regression — all previous phases' tests must still pass

Base your test decisions on the project's language, framework, and existing test patterns you found in Step 1.

## STEP 4: ESTIMATE ITERATIONS

*Skip this step if the plan was detected as pre-analyzed in Step 1.5. Iteration estimates will be determined inline during Step 5.*

For each phase, reason about how many ralph-loop iterations it will likely need:

- How many files or components need to be created/modified?
- How many tests need to pass?
- Does it involve external dependencies or integrations?
- Is there UI work?

General guidance: default around 5, cap at 10.

## STEP 5: PRESENT FOR CONFIRMATION

Present the phase breakdown to the user clearly.

If this is a pre-analyzed plan, note to the user: "This plan was pre-analyzed by `/ralph-helper:analyze`. Phase structure, tests, and completion criteria are used as-is." Then present each phase with its tests and criteria from the file, plus inline iteration estimates.

For each phase, show:
- Phase name and description
- What will be built
- What tests will be required (both from the plan and any you're adding)
- Estimated iterations
- Completion criteria

Ask the user to confirm before proceeding. This is the **only human touchpoint** — everything after confirmation is automatic.

If the user wants to edit the breakdown, incorporate their changes and re-present.

## STEP 6: EXECUTE (after confirmation)

Once the user confirms, proceed to fully automatic execution. For each phase, in order:

### 6a. Prepare the Phase

- Derive a plan name from the plan filename (e.g., `./plans/user-auth.md` becomes `user-auth`)
- Create a git tag: `ralph-helper/<plan-name>/phase-<N>-start`
- Create or update `./logs/<plan-name>/PROGRESS.md` marking this phase as in-progress
- Create or update `./logs/<plan-name>/ralph-helper.json` with the phase state

### 6b. Compose the ralph-loop Prompt

Read the plan, the codebase state, and PROGRESS.md. Then compose a prompt for ralph-loop that includes:

1. **Context**: What has already been built in previous phases. Reference PROGRESS.md and the actual codebase state. Mention which phases are complete and what they produced.

2. **Objectives**: What this phase needs to accomplish, drawn directly from the plan.

3. **Test requirements**: The specific tests that must be written and pass. Include both the plan's tests and any you determined are needed. Be explicit about test names and what they verify. Also state that ALL previous phases' tests must continue to pass.

4. **Boundaries**: What files and modules from previous phases should NOT be modified. Determine this from the git tags and your understanding of what was built.

5. **Completion criteria**: The concrete conditions under which this phase is done. This should map to testable, verifiable outcomes.

### 6c. Determine ralph-loop Parameters

- `--max-iterations`: Based on your complexity estimate from Step 4
- `--completion-promise`: Derive from the completion criteria. It should be a concrete, checkable statement like "All tests pass including regression tests from previous phases, and PROGRESS.md is updated with phase completion status."

### 6d. Invoke ralph-loop

Run:
```
/ralph-loop:ralph-loop PROMPT --max-iterations N --completion-promise "TEXT"
```

Where PROMPT is the full prompt you composed in 6b.

### 6e. Verify the Phase

After ralph-loop completes:

1. **Run ALL tests** — current phase's tests AND all previous phases' tests. Use the test framework you detected in Step 1.
2. **Read the test output** and reason about whether everything truly passes.
3. **Check PROGRESS.md** — did ralph-loop update it appropriately?

### 6f. Gate Decision

**If all tests pass (current + regression)**:
- Create git tag: `ralph-helper/<plan-name>/phase-<N>-done`
- Update `./logs/<plan-name>/PROGRESS.md` with phase completion (iterations used, tests passing, git tag, duration)
- Update `./logs/<plan-name>/ralph-helper.json` with phase status
- Proceed to the next phase (back to 6a)

**If tests fail**:
- Run `git reset --hard ralph-helper/<plan-name>/phase-<N>-start` to rollback
- Read the test failure output carefully
- Reason about what went wrong — was it a logic error, a missing dependency, a regression?
- Compose a **new retry prompt** that includes:
  - Everything from the original prompt
  - The specific test failures and error messages
  - Your analysis of what likely went wrong
  - Guidance on a different approach if the original approach seems flawed
- Retry the phase (invoke ralph-loop again with the adjusted prompt)
- Allow up to **2 retries** per phase (3 total attempts)

**If still failing after all retries**:
- Stop execution
- Update PROGRESS.md with the failure details
- Report to the user:
  - Which phase failed
  - What tests are failing and why
  - What was tried
  - The git tag they can reset to
  - Suggest whether the phase needs to be restructured or the plan needs revision

## BROWSER MCP VERIFICATION

During Step 2 (decomposition), check whether browser MCP tools are available in the current Claude Code session. Look for tools related to Playwright, Puppeteer, or Chrome MCP.

If browser MCP is available:
- During analysis, identify which phases involve frontend/UI components or end-to-end user flows
- Mark those phases for browser verification
- During Step 6e (verification), after unit tests pass for a browser-marked phase:
  - Use the browser MCP to navigate to the local dev server
  - Execute the E2E scenario described in the phase's tests (look for tests prefixed with "Browser:" or "E2E:")
  - Take a screenshot as evidence
  - Include the browser verification result in PROGRESS.md

If browser MCP is NOT available:
- Skip browser verification entirely
- Note in PROGRESS.md: "Browser verification skipped — no browser MCP available"
- Still require all unit/integration tests to pass
- In the final report, suggest the user verify UI manually

Browser verification is always supplementary — it never replaces unit tests. Unit tests are the hard gate; browser verification is an additional confidence check.

## STEP 7: FINAL REPORT

After all phases complete successfully:

- Run the full test suite one final time to confirm everything passes
- Present a summary:
  - Total phases completed
  - Total iterations used across all phases
  - Full test suite results
  - List of files created/modified
  - Git tags for each phase boundary
- Update PROGRESS.md with final status
