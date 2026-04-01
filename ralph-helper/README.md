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

## Commands

| Command | Description |
|---|---|
| `/ralph-helper:go <plan-path>` | Analyze plan, confirm phases, then execute all phases automatically |
| `/ralph-helper:analyze <plan-path>` | Analyze plan and suggest phase breakdown without executing |
| `/ralph-helper:resume <plan-path>` | Resume from last completed phase |
| `/ralph-helper:status <plan-path>` | Show current progress |
| `/ralph-helper:phase <plan-path> <N>` | Run only a specific phase |
| `/ralph-helper:test <plan-path>` | Run all tests across completed phases |

## How It Works

1. **You plan first** — Use Claude Code to brainstorm and write a plan markdown file
2. **Run `/ralph-helper:go ./plans/my-feature.md`** — ralph-helper reads the plan, reasons about phases and tests, and presents a breakdown for your confirmation
3. **It executes automatically** — After you confirm, ralph-helper drives every phase: composing ralph-loop prompts, running tests, rolling back on failure, and advancing to the next phase
4. **You get a report** — When done, you see what was built, what passed, and what changed

## Plan Format

ralph-helper works with any markdown plan. A well-structured plan with phase headings gives it more to work with:

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

If your plan doesn't have phase headings, ralph-helper will analyze it and suggest a breakdown.

## Key Behaviors

- **Test injection**: Every phase gets unit tests. If the plan doesn't specify them, Claude Code determines what's needed based on what's being built.
- **Regression gate**: All previous phases' tests must pass before advancing. No exceptions.
- **Rollback**: Each phase is git-tagged at start and end. On failure, it rolls back and retries with error context (up to 2 retries).
- **Browser MCP**: If browser MCP tools are available, frontend phases get E2E verification. If not, it skips gracefully.

## Progress Tracking

ralph-helper maintains two files during execution:

- `./logs/<plan-name>/PROGRESS.md` — Human-readable progress with phase status, test results, and git tags
- `./logs/<plan-name>/ralph-helper.json` — Machine-readable state used by `/ralph-helper:resume`

## License

MIT
