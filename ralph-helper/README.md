# ralph-helper

A Claude Code plugin that orchestrates [ralph-loop](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop) execution from structured plans.

You create a plan in Claude Code. ralph-helper reads it, breaks it into phases, ensures every phase has unit tests, and drives the entire execution automatically — invoking ralph-loop per phase, gating on test results, rolling back on failure, and producing a final report.

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed
- [ralph-loop](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop) plugin installed

## Installation

```bash
claude plugin add /path/to/ralph-helper
```

## How to Use

### 1. Write a Plan

Start by creating a markdown plan file describing what you want to build. You can write it yourself or use Claude Code to help brainstorm:

```bash
# In Claude Code, ask it to help you plan
> Help me plan a user authentication feature

# Or write a plan file directly
> Write a plan to ./plans/user-auth.md
```

A plan template is included at `templates/plan-example.md`. Plans support two formats:

**Structured** — Use `## Phase` headings with `### Tests` and `### Done When` subsections for full control:

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

**Flat** — Just describe what you want. ralph-helper will analyze it and suggest a phase breakdown for your review.

### 2. Analyze the Plan

Before executing, run analyze to get a well-structured, ready-to-execute plan:

```
/ralph-helper:analyze
```

ralph-helper auto-detects the most recent plan in `~/.claude/plans/` and confirms with you before proceeding. You can also pass a path explicitly:

```
/ralph-helper:analyze ./plans/user-auth.md
```

This produces `./plans/user-auth-ralph-helper.md` — a structured plan with properly sized phases (large phases are auto-split), tests, and completion criteria. Review it and revise if needed.

### 3. Execute the Plan

```
/ralph-helper:go
```

Auto-detects the most recent plan (preferring a pre-analyzed `-ralph-helper` variant if one exists). Or pass a path explicitly:

```
/ralph-helper:go ./plans/user-auth-ralph-helper.md
```

If using a pre-analyzed plan (from step 2), ralph-helper trusts the phase structure and skips redundant decomposition. You can also pass an unanalyzed plan directly — ralph-helper will decompose it itself.

ralph-helper will:

1. Read your plan and the codebase (language, test framework, existing patterns)
2. Decompose the plan into phases with tests for each (skipped if pre-analyzed)
3. Present the breakdown and ask for your confirmation — **this is the only human touchpoint**
4. After you confirm, execute each phase automatically:
   - Create a git tag at the start of each phase
   - Compose a detailed prompt and invoke ralph-loop
   - Run all tests (current phase + regression from previous phases)
   - On success: tag the phase as done, advance to next
   - On failure: rollback via git, retry with error context (up to 2 retries)
5. Produce a final report with test results, iterations used, and files changed

### 4. Monitor Progress

While a run is in progress or after it completes:

```
/ralph-helper:status ./plans/user-auth.md
```

Shows per-phase status (completed, in progress, failed, not started), iterations used, test results, git tags, and whether any regressions have been introduced since the last run.

### 5. Resume After Interruption

If a run is interrupted (e.g., you close Claude Code, or a phase fails and you want to fix something manually):

```
/ralph-helper:resume ./plans/user-auth.md
```

ralph-helper reads the saved state from `./logs/<plan-name>/ralph-helper.json`, verifies git tag consistency, runs regression tests on completed phases, and picks up from where it left off.

### 6. Re-run a Single Phase

If a specific phase needs to be re-executed (e.g., after manual changes or plan revisions):

```
/ralph-helper:phase ./plans/user-auth.md 2
```

Runs only phase 2. It will check that prior phases' tests still pass before executing, and will not automatically continue to subsequent phases.

### 7. Run Regression Tests

After manual edits or to verify the full suite at any time:

```
/ralph-helper:test ./plans/user-auth.md
```

Runs all tests across completed phases, reports results per phase, and flags any regressions compared to the last recorded run.

## Commands

| Command | Description |
|---|---|
| `/ralph-helper:go [plan-path]` | Analyze plan, confirm phases, then execute all phases automatically |
| `/ralph-helper:analyze [plan-path]` | Analyze plan, auto-split large phases, write a `-ralph-helper.md` plan file |
| `/ralph-helper:resume [plan-path]` | Resume from last completed phase |
| `/ralph-helper:status [plan-path]` | Show current progress |
| `/ralph-helper:phase [plan-path] <N>` | Run only a specific phase |
| `/ralph-helper:test [plan-path]` | Run all tests across completed phases |

All commands auto-detect the most recent plan in `~/.claude/plans/` when no path is provided. For `resume`, `status`, `test`, and `phase`, auto-detection prefers plans with existing progress logs. For `go`, it prefers a pre-analyzed (`-ralph-helper`) variant if one exists.

## Plugin Structure

```
ralph-helper/
  commands/       # User-facing commands (go, analyze, resume, status, phase, test)
  procedures/     # Shared reusable procedures referenced by commands
  templates/      # Plan template for users
  .claude-plugin/ # Plugin metadata
```

Commands delegate shared logic to procedure files in `procedures/`:
- `resolve-plan.md` — Plan path auto-detection and user confirmation
- `detect-test-framework.md` — Test framework and pattern detection
- `execute-phase.md` — Single-phase execution (git tag, ralph-loop, test gate, retry)
- `final-report.md` — Final report generation after all phases complete

## Key Behaviors

- **Test injection**: Every phase gets unit tests. If the plan doesn't specify them, Claude Code determines what's needed based on what's being built.
- **Regression gate**: All previous phases' tests must pass before advancing. No exceptions.
- **Rollback**: Each phase is git-tagged at start and end. On failure, it rolls back and retries with error context (up to 2 retries, 3 total attempts per phase).
- **Browser MCP**: If browser MCP tools are available, frontend phases get E2E verification (tests prefixed with `Browser:` or `E2E:`). If not, it skips gracefully.

## Progress Tracking

ralph-helper maintains two files during execution:

- `./logs/<plan-name>/PROGRESS.md` — Human-readable progress with phase status, test results, and git tags
- `./logs/<plan-name>/ralph-helper.json` — Machine-readable state used by `/ralph-helper:resume`

## License

MIT
