---
description: Analyze a plan, confirm phases, then execute all phases automatically via ralph-loop
argument-hint: [plan-path]
---

You are ralph-helper's main orchestrator. If no plan path is provided, you will auto-detect the most recent plan. If this is a pre-analyzed plan (from `/ralph-helper:analyze`), trust its structure and skip redundant decomposition. Otherwise, read it, break it into executable phases with unit tests, get confirmation, and drive the entire build automatically using ralph-loop.

## STEP 0: RESOLVE PLAN PATH

**Follow the procedure in `procedures/resolve-plan.md`** with:
- Filter patterns: exclude filenames containing `-agent-` or `-ralph-helper`
- Prefer progress: No
- Check pre-analyzed: Yes
- Confirmation question: "Is this the plan you want to execute?"

## STEP 1: READ AND UNDERSTAND

Read the plan file at the resolved plan path. Also read the codebase:

- What language(s) is this project using?
- **Follow the procedure in `procedures/detect-test-framework.md`** to identify the test framework and patterns.
- What existing patterns exist (project structure, naming conventions, existing tests)?
- Is there an existing `./logs/` directory or `PROGRESS.md` from a previous run?

**Project memory**: durable cross-session memory lives in the project's Obsidian
`_MEMORY.md` and is auto-injected at session start. Check the current context for a
`PROJECT MEMORY (...)` block — if present, read its `## Ralph Learnings` section
and factor prior lessons into phase planning. Then **follow the procedure in
`procedures/project-memory.md`** with operation **BOOTSTRAP** to ensure the vault
folder + `_MEMORY.md` exist for this project, so later phases can capture learnings
and future runs auto-load them. If no Obsidian vault exists on this machine, skip
it — execution proceeds without it.

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

**Follow the procedure in `procedures/execute-phase.md`** with the phase's plan name, phase number, objectives, test requirements, iteration estimate, completion criteria, and previous phase context.

Loop through all phases sequentially. After each phase completes successfully, proceed to the next.

## BROWSER MCP VERIFICATION

During Step 2 (decomposition), check whether browser MCP tools are available in the current Claude Code session. Look for tools related to Playwright, Puppeteer, or Chrome MCP.

If browser MCP is available:
- During analysis, identify which phases involve frontend/UI components or end-to-end user flows
- Mark those phases for browser verification
- During phase verification (after unit tests pass for a browser-marked phase):
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

**Follow the procedure in `procedures/final-report.md`** to generate the final report after all phases complete successfully.
