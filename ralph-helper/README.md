# ralph-helper

A Claude Code plugin that runs a structured plan phase by phase.

You write a plan. ralph-helper breaks it into phases, makes sure every phase has tests, and asks you once to confirm. Then it runs each phase in a fresh subagent, gates it on the test command's exit code, and commits and tags it on its own branch. A failed attempt is rolled back and retried, and every phase's lesson is kept for the next run.

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed
- A git repo with a test command (`pytest`, `unittest`, `vitest`, `jest`, `go test`, `cargo test`, …). With no test framework, `go` stops and offers a Phase 0 that sets one up.

**Optional (degrades gracefully if absent):**
- **Notes vault**: set the plugin's `notesDir` option (`/plugin` → ralph-helper → configure) to an Obsidian folder holding one folder per project, e.g. `~/.obsidian/MyVault/Projects`. Lessons go to `<notesDir>/<project>/_MEMORY.md` (`## Ralph Learnings`) and run notes to `sessions/`. The project is found through `<notesDir>/_tools/groups.json` (`projects.<name>.repo` lists git roots), else the repo's folder name. The folder must already exist; ralph-helper never creates it.
- The [graphify](https://pypi.org/project/graphifyy/) CLI + a `graphify-out/graph.json` in the target repo, for codebase search in each phase's context and boundaries.

Earlier versions drove [ralph-loop](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop). 0.5.0 no longer needs it: ralph-loop's Stop hook ends the turn when its loop finishes, so control never came back for the next phase.

## Installation

```
/plugin install ralph-helper --marketplace EdmundHee/gingermarket
```

Working from a clone instead: `claude plugin marketplace add <clone folder>`, then
`claude plugin install ralph-helper@gingermarket`.

## How to Use

### 1. Write a Plan

Write a markdown plan in `./plans/` or `~/.claude/plans/` (both are searched), yourself or with Claude. A template is in `templates/plan-example.md`. Two formats work:

**Structured**: `## Phase` headings with `### Tests` and `### Done When`. Optional: `Estimate: N` (test-fix cycles) and a `### Do not modify` list of files the phase must not touch.

```markdown
# Feature: User Authentication

## Phase 1: Database Models
Set up user model with email, hashed password, created_at.

### Tests
- User model can be created with valid fields
- Duplicate email raises constraint error

### Done When
User model exists, migration runs cleanly, all tests pass.

## Phase 2: Auth Endpoints
POST /auth/register, POST /auth/login, GET /auth/me

### Tests
- Register returns 201 with valid JWT
- Login with wrong password returns 401

### Done When
All endpoints respond correctly, all tests pass.
```

**Flat**: just describe what you want. ralph-helper proposes the phases for you to confirm.

### 2. Analyze the Plan (optional)

```
/ralph-helper:analyze ./plans/user-auth.md
```

Writes `./plans/user-auth-ralph-helper.md`: properly sized phases (anything estimated above 10 cycles is split), tests and done-when criteria. Review and edit it. It asks before overwriting an earlier analysis, and it writes nothing else.

### 3. Execute the Plan

```
/ralph-helper:go ./plans/user-auth-ralph-helper.md
```

With no path it auto-detects the newest plan (preferring a `-ralph-helper` copy). `--yes` skips the confirmation, for headless runs.

ralph-helper will:

1. Check the repo: a git repo, a clean working tree (commit or stash first), and a test command.
2. Decompose the plan into phases with tests (skipped for an analyzed plan) and ask you to confirm. **This is the only human touchpoint.**
3. Create branch `ralph/<plan>` and write `./logs/<plan>/ralph-helper.json`.
4. For each phase:
   - write the phase's prompt to `./logs/<plan>/phase-N.md` and run one subagent on it
   - run the test command. The gate passes only on exit 0, a test count that did not drop, every named test present, and no protected file touched.
   - **pass**: commit `ralph-helper(<plan>): phase N — <name>`, tag `ralph-helper/<plan>/phase-N`, record the lesson
   - **fail**: `git reset --hard` + `git clean -fd` back to the phase's start, retry with the failure output (3 attempts in all). After the third, the attempt is stashed (`git stash list`) and the run stops.
5. Rerun the full suite and report. A red final run is reported as a failure, never as done.

### 4. Monitor Progress

```
/ralph-helper:status ./plans/user-auth.md
```

Per-phase status, attempts, test counts, commits and tags from the state file, plus a fresh test run that catches manual edits.

### 5. Resume

After an interruption, or after fixing a failed phase and committing the fix:

```
/ralph-helper:resume ./plans/user-auth.md
```

Checks the recorded commits still exist, reruns the suite as a regression gate, then runs every phase not yet done. The plan and its `-ralph-helper` copy share one run, so either path works.

### 6. Re-run a Single Phase

```
/ralph-helper:phase ./plans/user-auth.md 2
```

Needs a run started by `go`, and all earlier phases done. Afterwards the full suite runs. Later phases it breaks are marked `stale`, and `resume` reruns them.

### 7. Run Regression Tests

```
/ralph-helper:test ./plans/user-auth.md
```

Runs the recorded test command and compares against each phase's recorded test count.

## Commands

| Command | Description |
|---|---|
| `/ralph-helper:go [plan-path] [--yes]` | Decompose, confirm, then run every phase |
| `/ralph-helper:analyze [plan-path]` | Write a sized, tested `-ralph-helper.md` plan file |
| `/ralph-helper:resume [plan-path]` | Run every phase not yet done |
| `/ralph-helper:status [plan-path]` | Show progress from the state file |
| `/ralph-helper:phase [plan-path] <N>` | Re-run one phase |
| `/ralph-helper:test [plan-path]` | Run the suite against recorded counts |
| `/ralph-helper:evolve [--apply]` | Propose improvements to ralph-helper from cross-project learnings (human-reviewed) |

With no path, commands auto-detect the newest plan in `./plans/` and `~/.claude/plans/`. `resume`, `status`, `test` and `phase` prefer plans with a run.

## Git Safety

- Work happens on `ralph/<plan>`, never on your branch. A dirty tree stops the run before anything changes.
- Every passing phase is a commit, so rollback only ever drops the failed attempt.
- `logs/` is added to `.git/info/exclude`: it is never committed, reset or cleaned, and the run's state survives a rollback.
- A phase that fails all 3 attempts is stashed, not thrown away.

## Plugin Structure

```
ralph-helper/
  commands/       # go, analyze, resume, status, phase, test, evolve
  procedures/     # shared procedures the commands follow
  scripts/        # vault-dir.sh: finds the project's notes folder
  templates/      # plan template
  tests/          # vault-dir unit test, headless smoke runs
  .claude-plugin/ # plugin metadata
```

Procedures:
- `run-state.md`: slug, state file schema, preflight (git, clean tree, branch, `logs/` excluded)
- `resolve-plan.md`: plan auto-detection and confirmation
- `decompose-plan.md`: phase rules shared by `go` and `analyze`
- `detect-test-framework.md`: test framework and pattern detection
- `execute-phase.md`: prompt file, subagent, gate, commit/tag, rollback and retry
- `final-report.md`: success or failure report, graphify reflect, vault session note
- `project-memory.md`: notes-folder lookup and write rules
- `capture-learnings.md`: one lesson per phase, to the vault, `learnings.json` and graphify
- `inject-context.md`: prior lessons + graphify search into each phase's prompt file
- `evolve.md`: cross-project patterns → proposed plugin edits

## Self-Improvement (memory & search)

- **Capture**: at each phase's terminal outcome, `capture-learnings.md` redacts secrets and writes one lesson to `_MEMORY.md` (`## Ralph Learnings`, capped at 10 bullets), `./logs/<plan>/learnings.json`, and `graphify save-result`.
- **Inject**: before each phase, `inject-context.md` re-reads those lessons from disk (earlier phases of the same run included) and adds them to the prompt file as data, never as instructions, with a graphify map of relevant code and boundaries.
- **Reflect**: at the end of a run, success or failure, `graphify reflect --if-stale` folds the lessons into `LESSONS.md`, and a session note goes to the vault.

**Cross-project evolution**: `/ralph-helper:evolve` counts patterns across projects' `learnings.json` (at least 3 occurrences in at least 2 projects) and **proposes** edits to ralph-helper's own files. Lessons are treated as untrusted data. It is a dry run by default; `--apply` commits to a fresh `ralph-helper-evolve/<timestamp>` branch from a clean tree, never to `main`.

## Files Written

- `./logs/<plan>/ralph-helper.json`: the run's state; the only progress record
- `./logs/<plan>/phase-N.md`: each phase's prompt, with failed attempts appended
- `./logs/<plan>/learnings.json`: structured per-phase lessons

## Tests

- `bash ralph-helper/tests/vault-dir.test.sh`: notes-folder lookup (part of the marketplace run line)
- `bash ralph-helper/tests/smoke.sh success|failure`: a headless run on a toy repo. It costs real model calls, so it is run by hand.

## License

MIT
