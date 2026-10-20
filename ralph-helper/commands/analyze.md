---
description: Analyze a plan, auto-split large phases, and write a ready-to-execute plan file
argument-hint: [plan-path]
---

You are ralph-helper's plan analyzer. Break a plan into properly sized phases with
tests and write a structured plan file ready for `/ralph-helper:go`. If no plan path
is provided, auto-detect the most recent plan.

- Plugin root: `${CLAUDE_PLUGIN_ROOT}` — procedure files say `${CLAUDE_PLUGIN_ROOT}`
  for this path.
- Notes dir (plugin setting): `${user_config.notesDir}` — empty or a literal
  `${user_config.notesDir}` means no vault.

## Step 0: Resolve Plan Path

**Follow `${CLAUDE_PLUGIN_ROOT}/procedures/resolve-plan.md`** with `$ARGUMENTS` and:
- Filter patterns: exclude filenames containing `-agent-`
- Prefer progress: No
- Check pre-analyzed: No
- Confirmation question: "Is this the plan you want to analyze?"

## What to Do

1. **Read the plan file**. If it doesn't exist, tell the user and stop.
2. **Read the codebase** and **follow
   `${CLAUDE_PLUGIN_ROOT}/procedures/detect-test-framework.md`**. If a vault folder
   resolves (`${CLAUDE_PLUGIN_ROOT}/procedures/project-memory.md` RESOLVE), read its
   `## Ralph Learnings` for sizing and test hints. If `graphify-out/graph.json`
   exists, query it as-is to spot dependency order; do not refresh it.
3. **Decompose**: **follow `${CLAUDE_PLUGIN_ROOT}/procedures/decompose-plan.md`**.
4. **Pick the output path**:
   - Input already ends in `-ralph-helper.md` → write it in place, after the user
     confirms.
   - Otherwise insert `-ralph-helper` before `.md` (`./plans/my-feature.md` →
     `./plans/my-feature-ralph-helper.md`). If that file exists, ask before
     overwriting: it may hold the user's own revisions.
5. **Write the analyzed plan**:
   - `# Feature: <name from the original plan>`
   - Per phase: `## Phase N: <Name>`, a description paragraph, `### Tests`
     (bulleted testable assertions; `Browser:`/`E2E:` prefixes kept), `### Done
     When` (concrete criteria), and `### Do not modify` when the phase has
     protected files
   - Complete and self-contained, every phase included
6. **Suggest improvements** (missing edge cases, unclear criteria, odd dependency
   order, vague tests), already folded into the file where they fit.
7. **Present**: the phase breakdown (name, scope, tests, estimate, done-when), the
   output path, and: "Review the analyzed plan. Run `/ralph-helper:go <output-path>`
   to execute it, or ask me to revise."

## Important

The analyzed plan file is the **only** write. No branch, no tags, no state file, no
graph refresh, no vault writes, no phase runs.
