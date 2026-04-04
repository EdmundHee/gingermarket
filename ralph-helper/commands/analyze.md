---
description: Analyze a plan, auto-split large phases, and write a ready-to-execute plan file
argument-hint: [plan-path]
---

You are ralph-helper's plan analyzer. Your job is to analyze a plan, break it into properly sized phases with tests, and produce a well-structured plan file ready for `/ralph-helper:go`. If no plan path is provided, you will auto-detect the most recent plan.

## Step 0: Resolve Plan Path

If `$ARGUMENTS` is not empty, use it as the plan path and skip to Step 1.

If `$ARGUMENTS` is empty (the user ran `/ralph-helper:analyze` with no arguments):

1. Run `ls -t ~/.claude/plans/*.md` to list all plan files sorted by modification time (most recent first).
2. Filter out any file whose name contains `-agent-` (subagent plans) or `-ralph-helper` (already-analyzed plans).
3. If no files remain after filtering, tell the user: "No plan files found in `~/.claude/plans/`. Create a plan first using plan mode." and stop.
4. Take the most recently modified file from the filtered list.
5. Read the first few lines of that file to extract the first heading or first non-empty line as a brief summary.
6. Present to the user:
   - The filename and full path
   - When it was last modified
   - The brief summary (first heading)
   - If the file was last modified more than 24 hours ago, add: "Note: this plan was last modified [time ago] — please confirm this is the correct plan."
7. Ask: "Is this the plan you want to analyze?"
8. If the user confirms, use that file as the plan path and proceed to Step 1.
9. If the user says no, list the 5 most recent candidate files (with dates and summaries) and ask the user to pick one, or provide a path manually.

## What to Do

1. **Read the plan file** at the resolved plan path. If it doesn't exist, tell the user and stop.

2. **Read the codebase** to understand:
   - Project language(s) and structure
   - Test framework in use (look for config files: `pytest.ini`, `pyproject.toml`, `jest.config.*`, `package.json`, `go.mod`, etc.)
   - Existing test patterns and naming conventions

3. **Decompose into phases** using the same logic as `/ralph-helper:go`:
   - If the plan has `## Phase` headings, use them as a starting point
   - If not, reason about dependency order, testability boundaries, and appropriate sizing (3-8 iterations per phase, max 10)

4. **Ensure every phase has tests**:
   - Use plan-specified tests where they exist
   - Determine what's missing based on what's being built and the project's testing patterns

5. **Estimate iterations** per phase based on complexity

6. **Auto-split large phases**:
   - If any phase is estimated at more than 10 iterations, actively split it into sub-phases of 3-8 iterations each
   - Renumber all phases sequentially after splitting (Phase 1, Phase 2, etc. — no Phase 2a/2b)
   - Each resulting sub-phase must have its own `### Tests` and `### Done When` sections
   - Preserve dependency order: a sub-phase that produces outputs another depends on must come first
   - Note whether browser MCP verification would be useful for any phases

7. **Write the analyzed plan file**:
   - Derive the output path by inserting `-ralph-helper` before the `.md` extension. For example: `./plans/my-feature.md` becomes `./plans/my-feature-ralph-helper.md`
   - Write the plan using the structured template format:
     - Top heading: `# Feature: [name derived from original plan]`
     - For each phase: `## Phase N: [Name]` heading, followed by a description paragraph, then `### Tests` (bulleted list of testable assertions), then `### Done When` (concrete completion criteria)
   - The file must be a complete, self-contained plan including all phases — both those that were already well-sized and any newly split ones
   - This is the ONE file you are permitted to create

8. **Suggest improvements** to the plan if you see issues:
   - Missing edge cases or error handling
   - Phases with unclear completion criteria
   - Dependencies that seem out of order
   - Tests that are missing or too vague
   - Note: improvements should already be incorporated into the written plan file where appropriate

9. **Present for approval**:
   - Present the full phase breakdown to the user in chat (phase name, scope, tests, estimated iterations, completion criteria)
   - Show the output file path
   - Tell the user: "Review the analyzed plan. Run `/ralph-helper:go <output-path>` to execute it, or ask me to revise."

## Important

Do NOT execute any phases. No git tags, no ralph-loop invocations. The ONLY file you create is the `-ralph-helper.md` analyzed plan file. The user will review it before running `/ralph-helper:go`.
