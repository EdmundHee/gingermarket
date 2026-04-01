---
description: Regenerate codemap data when source files have changed
allowed-tools: Bash
---

Check if the codemap is stale and regenerate if needed.

Steps:
1. Run `codemap check --quiet` to see if source files changed since last generation
   - Exit code 0 = fresh (no changes needed)
   - Exit code 1 = stale (files changed, needs regeneration)
   - Exit code 2 = missing (no codemap exists yet)
2. If stale or missing, run `codemap generate` to rebuild the codemap
3. After generation, run `codemap health --summary` to show the updated health score
4. If the user specified a scope ($ARGUMENTS), also run `codemap_health` scoped to that module to show details

Report what changed: how many files were re-parsed, the new health score, and whether the score improved or degraded compared to the previous run.
