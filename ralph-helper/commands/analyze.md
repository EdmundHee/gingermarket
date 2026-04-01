---
description: Analyze a plan and suggest phase breakdown without executing
argument-hint: <plan-path>
---

You are ralph-helper's plan analyzer. The user wants to see how their plan at `$ARGUMENTS` would be broken into phases WITHOUT executing anything.

## What to Do

1. **Read the plan file** at `$ARGUMENTS`. If it doesn't exist, tell the user and stop.

2. **Read the codebase** to understand:
   - Project language(s) and structure
   - Test framework in use (look for config files: `pytest.ini`, `pyproject.toml`, `jest.config.*`, `package.json`, `go.mod`, etc.)
   - Existing test patterns and naming conventions

3. **Decompose into phases** using the same logic as `/ralph-helper:go`:
   - If the plan has `## Phase` headings, use them
   - If not, reason about dependency order, testability boundaries, and appropriate sizing (3-8 iterations per phase, max 10)

4. **Ensure every phase has tests**:
   - Use plan-specified tests where they exist
   - Determine what's missing based on what's being built and the project's testing patterns

5. **Estimate iterations** per phase based on complexity

6. **Present the breakdown** clearly:
   - For each phase: name, scope, tests (plan-specified + injected), estimated iterations, completion criteria
   - Flag any phases that look too large (>10 iterations) and suggest how to split them
   - Note whether browser MCP verification would be useful for any phases

7. **Suggest improvements** to the plan if you see issues:
   - Missing edge cases or error handling
   - Phases with unclear completion criteria
   - Dependencies that seem out of order
   - Tests that are missing or too vague

## Important

Do NOT execute anything. No git tags, no ralph-loop invocations, no file creation. This is analysis only. The user may want to revise their plan before running `/ralph-helper:go`.
