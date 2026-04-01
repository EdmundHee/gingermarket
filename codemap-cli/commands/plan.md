---
description: Create an implementation plan using codemap to understand the codebase first
---

Create an implementation plan for: $ARGUMENTS

Before planning, gather structural knowledge about the codebase so the plan is grounded in how the code actually works — not guesses.

Steps:
1. Call `codemap_overview` to understand the full project structure, modules, and patterns
2. Call `codemap_query` to search for any existing code related to the feature/change
3. For relevant matches, call `codemap_callers` and `codemap_calls` to understand how they fit into the architecture
4. Call `codemap_module` on the directories where changes will likely be needed
5. Call `codemap_health` to identify any existing quality issues in affected areas

Then produce a plan:
- **Existing code**: what already exists that's relevant (reuse opportunities)
- **Architecture fit**: where new code should live based on existing module boundaries
- **Implementation steps**: ordered list of changes, each referencing specific files/functions
- **Dependencies**: what existing code will be affected and how
- **Testing strategy**: what to test based on the call graph (which callers to verify)
- **Risk areas**: modules with high complexity or coupling that need extra care
