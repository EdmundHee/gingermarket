---
description: Find existing functions to reuse or extend before writing new code
---

Before writing new code for: $ARGUMENTS

Search the codebase for existing functions, classes, or utilities that already do something similar — so we can reuse, extend, or improve them instead of duplicating logic.

Steps:
1. Break down the requested functionality into key concepts and action words
2. For each concept, call `codemap_query` to search for existing functions/classes with related names
3. For promising matches, call `codemap_calls` to understand their internal dependencies
4. For promising matches, call `codemap_callers` to see how widely they're already used (more callers = more mature/tested)
5. Check `codemap_module` on the directories where matches live to see if there are related utilities nearby

Then provide a recommendation for each match:
- **Reuse as-is**: function already does what's needed, just import and call it
- **Extend**: function is close but needs a small addition — suggest how to extend it
- **Improve**: function has the right intent but poor implementation — suggest refactoring it
- **Write new**: nothing similar exists, explain why new code is justified

Always prefer reuse over new code. If writing new code, suggest which module it should live in based on the existing structure.
