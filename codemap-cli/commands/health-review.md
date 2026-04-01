---
description: Review code quality and identify what to refactor next
---

Review the codebase health and identify the highest-priority improvements.

Steps:
1. Call `codemap_health` for the full project health score and metrics
2. Call `codemap_structures` with type "hotspots" to find the most complex functions
3. Call `codemap_structures` with type "dead_code" to find unreachable functions safe to delete
4. Call `codemap_structures` with type "cohesion" to find god classes that should be split
5. If a specific area was mentioned ($ARGUMENTS), scope the analysis to that module

Produce a prioritized action list:
- **Quick wins**: dead code to delete (zero risk, immediate cleanup)
- **High impact**: complex hotspots with many callers (simplifying these improves the most code paths)
- **Structural**: god classes or high-coupling modules that need architectural attention
- **Overall assessment**: health score interpretation and trend direction
