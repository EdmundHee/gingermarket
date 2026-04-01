---
description: Analyze the blast radius before refactoring or modifying a function
---

Analyze the impact of changing: $ARGUMENTS

Before modifying this code, we need to understand the full blast radius — what will break, what needs updating, and how risky the change is.

Steps:
1. Call `codemap_query` to find the exact function/class and confirm its location and signature
2. Call `codemap_callers` to find every call site — these are all the places that could break
3. Call `codemap_calls` to find all dependencies — these are what the function relies on
4. For each caller's directory, call `codemap_module` to understand the surrounding context
5. Call `codemap_health` scoped to the affected modules to check existing code quality

Produce an impact report:
- **Target**: what's being changed, where it lives, current signature
- **Direct callers**: list every function that calls this, grouped by module
- **Transitive impact**: callers-of-callers if the signature is changing
- **Dependencies**: what this function calls (need to verify these still work after change)
- **Risk level**: Low (1-2 callers, same module) / Medium (3-10 callers, multiple modules) / High (10+ callers or public API)
- **Suggested approach**: how to safely make the change (feature flag, deprecation, etc.)
