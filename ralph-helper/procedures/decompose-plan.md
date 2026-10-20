# Procedure: Decompose a Plan into Phases

This is a shared procedure called by `go` and `analyze`. It is the only place the
phase rules live. It returns a list of phases in the shape of the state file's
`phases[]` (see `${CLAUDE_PLUGIN_ROOT}/procedures/run-state.md`), with `status:
pending` and every git field null.

Inputs: the plan text, the detected test framework and its patterns.

---

## Steps

1. **Boundaries**: if the plan has `## Phase` headings, each one is a phase; read
   its `### Tests` and `### Done When` subsections. If the plan is flat, split it
   by dependency order (what must exist before the next thing) and testability
   (each phase ends with something a test can check).
2. **Tests, always**: every phase gets tests. Use the plan's; where it gives none,
   name what a competent developer would test for that phase (unit tests for new
   functions, an integration test where components meet, edge cases and errors).
   Base them on the project's framework and existing test patterns.
3. **Estimate** test-fix cycles per phase: files touched, tests to pass, external
   dependencies, UI work. Default 5, range 3–8. A phase that states `Estimate: N`
   keeps N.
4. **Split above 10**: a phase estimated above 10 is split into sub-phases of 3–8,
   each with its own tests and done-when, dependency order kept. Renumber all
   phases 1..N (no 2a/2b).
5. **Browser**: `browser: true` when a phase has test lines starting `Browser:` or
   `E2E:`. The gate runs those only when browser MCP tools are present.
6. **Protected files**: collect lines under a `Do not modify` heading or bullet
   (plan-wide or per phase) into the phase's `protected`. The gate fails a phase
   that touches them.
7. **No test framework**: if `detect-test-framework.md` found none, stop before
   confirmation. Tell the user, and offer a Phase 0 that sets up the project's
   natural framework (e.g. `unittest`/`pytest`, `vitest`, `go test`) with one
   passing smoke test. Without a test command no phase can be gated.
