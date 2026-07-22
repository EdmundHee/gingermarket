# Procedure: Execute a Single Phase

This is a shared procedure called by ralph-helper commands. It executes one phase of a plan using ralph-loop.

The calling command MUST provide these inputs before invoking this procedure:
- **Plan name**: Derived from the plan filename (e.g., `user-auth`)
- **Phase number**: Which phase to execute (e.g., `2`)
- **Phase objectives**: What this phase needs to accomplish
- **Test requirements**: Specific tests that must pass (current phase + regression)
- **Iteration estimate**: How many ralph-loop iterations to allow
- **Completion criteria**: Concrete conditions for phase completion
- **Previous phases**: Which phases are complete and what they produced

---

## 6a. Prepare the Phase

- Create a git tag: `ralph-helper/<plan-name>/phase-<N>-start`
- Create or update `./logs/<plan-name>/PROGRESS.md` marking this phase as in-progress
- Create or update `./logs/<plan-name>/ralph-helper.json` with the phase state

## 6b. Compose the ralph-loop Prompt

First, **follow the procedure in `procedures/inject-context.md`** with operation
**GATHER** to collect (1) prior lessons / known pitfalls for this phase, (2) the
relevant existing code (graphify-searched), and (3) a graphify-derived
do-not-modify boundary list. Then read the plan, the codebase state, and
PROGRESS.md, and compose a prompt for ralph-loop that includes:

1. **Context**: What has already been built in previous phases. Reference PROGRESS.md and the actual codebase state. Mention which phases are complete and what they produced. **Fold in GATHER's prior-lessons block ("known pitfalls / what worked before") and its relevant-existing-code file list** so the loop starts informed instead of rediscovering.

2. **Objectives**: What this phase needs to accomplish, drawn directly from the plan.

3. **Test requirements**: The specific tests that must be written and pass. Include both the plan's tests and any determined to be needed. Be explicit about test names and what they verify. Also state that ALL previous phases' tests must continue to pass.

4. **Boundaries**: What files and modules from previous phases should NOT be modified. **Use GATHER's do-not-modify list** (graphify dependency analysis); fall back to git tags + code reading if graphify is unavailable.

5. **Completion criteria**: The concrete conditions under which this phase is done. This should map to testable, verifiable outcomes.

## 6c. Determine ralph-loop Parameters

- `--max-iterations`: Based on the provided iteration estimate
- `--completion-promise`: Derive from the completion criteria. It should be a concrete, checkable statement like "All tests pass including regression tests from previous phases, and PROGRESS.md is updated with phase completion status."

## 6d. Invoke ralph-loop

Run:
```
/ralph-loop:ralph-loop PROMPT --max-iterations N --completion-promise "TEXT"
```

Where PROMPT is the full prompt composed in 6b.

## 6e. Verify the Phase

After ralph-loop completes:

1. **Run ALL tests** — current phase's tests AND all previous phases' tests. Use the detected test framework.
2. **Read the test output** and reason about whether everything truly passes.
3. **Check PROGRESS.md** — did ralph-loop update it appropriately?

## 6f. Gate Decision

**If all tests pass (current + regression)**:
- Create git tag: `ralph-helper/<plan-name>/phase-<N>-done`
- Update `./logs/<plan-name>/PROGRESS.md` with phase completion (iterations used, tests passing, git tag, duration)
- Update `./logs/<plan-name>/ralph-helper.json` with phase status
- **Capture the learning**: **follow the procedure in `procedures/capture-learnings.md`** with outcome `success`, the iterations and retries used, what worked (and the root cause of any failed attempts if retries > 0), the tests touched, and whether the phase was browser-verified. This MUST happen here — before step 6g compaction discards the context that holds the details.
- Proceed to step 6g (compact context), then return success to the calling command

## 6g. Compact Context for Next Phase

After a successful phase, reduce the context window before proceeding to the next phase.

**Skip this step if**:
- This is the **last phase** in the plan (no next phase to prepare for)
- The phase ended via the **retry/failure** path (retry needs full error context)

**Action**: Run `/compact` with this directive:

> Ralph-helper is executing a multi-phase plan. Preserve this context:
>
> - Plan: [plan file path]
> - Plan name: [plan name]
> - Completed phases: 1 through [N] (details in ./logs/[plan-name]/PROGRESS.md)
> - Next phase: [N+1] of [total] total
> - State files: ./logs/[plan-name]/ralph-helper.json, ./logs/[plan-name]/PROGRESS.md
> - Test framework: [framework] (command: [test-command])
> - Git tags: ralph-helper/[plan-name]/phase-[N]-done is the latest checkpoint
>
> You are in the middle of executing /ralph-helper:go. After compaction, continue with the next phase by following procedures/execute-phase.md.

Replace bracketed values with actual values from the current execution context.

**If `/compact` fails or is unavailable**: Proceed without compaction. Log a note but do not block execution. This is a token optimization, not a correctness requirement.

## 6h. Handle Test Failures

**If tests fail**:
- Run `git reset --hard ralph-helper/<plan-name>/phase-<N>-start` to rollback
- Read the test failure output carefully
- Reason about what went wrong — was it a logic error, a missing dependency, a regression?
- Compose a **new retry prompt** that includes:
  - Everything from the original prompt
  - The specific test failures and error messages
  - Analysis of what likely went wrong
  - Guidance on a different approach if the original approach seems flawed
- Retry the phase (invoke ralph-loop again with the adjusted prompt)
- Allow up to **2 retries** per phase (3 total attempts)

**If still failing after all retries**:
- Stop execution
- Update PROGRESS.md with the failure details
- **Capture the learning**: **follow the procedure in `procedures/capture-learnings.md`** with outcome `failure`, the iterations and retries used, the root cause, the last approach tried and why it fell short, and the tests touched. (Do NOT capture on the intermediate retries above — only here, at the terminal failure.)
- Report to the calling command:
  - Which phase failed
  - What tests are failing and why
  - What was tried
  - The git tag to reset to
  - Whether the phase needs restructuring or the plan needs revision
