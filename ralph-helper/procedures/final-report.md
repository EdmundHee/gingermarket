# Procedure: Final Report

This is a shared procedure called at the end of a run, in one of two modes:
- **success**: by `go` / `resume` once every phase is `done`
- **failure**: by `execute-phase.md` after a phase's terminal failure

Inputs: the slug, the mode, and the notes dir from the command header.

---

## Procedure Steps

1. **Success mode only: final test run.** Run the state's `test_command`. If it
   exits non-zero or passes fewer tests than the last phase's `test_count`, a late
   regression slipped in: set the run `status: failed`, name the failing tests, and
   **continue in failure mode**. Never report success over a red suite.
2. **State**: set the run `status` to `done` (success) or `failed`.
3. **Summary to the user**:
   - Success: phases done, total attempts and test-fix cycles, final test count,
     files changed (`git diff --stat <first phase start_sha> HEAD`), the branch and
     its `ralph-helper/<slug>/phase-N` tags, and the next step (review the branch,
     merge it).
   - Failure: the failed phase, its failing tests and why, what was tried, the stash
     name, and how to continue (fix, commit, `/ralph-helper:resume`).
4. **Reflect (graphify)**: if `graphify` is on PATH and `graphify-out/` exists, run
   `graphify reflect --if-stale`. It folds the run's `save-result` entries
   (including a failure's `dead_end`) into `graphify-out/reflections/LESSONS.md`,
   which GATHER reads next time. No model cost.
5. **Vault**: **follow `${CLAUDE_PLUGIN_ROOT}/procedures/project-memory.md`**
   RESOLVE. If it prints a folder, apply its write rules:
   - **Session note** (both modes): `sessions/<date +%F>_ralph-<slug>.md`, with
     `-2`, `-3`, … if taken. Start with `Project: [[<project>]]`, then what was
     built, phases done, decisions, and on failure the blocker and next step.
   - **Success only**: one `## Recent Changes` bullet in `_MEMORY.md` and one line in
     the hub note `<project>.md`, each ending in the session note's `[[wikilink]]`.
   Nothing printed → skip.
