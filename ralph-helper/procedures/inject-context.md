# Procedure: Inject Context (Graphify search + prior lessons)

This is a shared procedure that closes the **read** side of the feedback loop. It
pulls accumulated lessons and a graphify-derived map of the codebase into a
phase's ralph-loop prompt, so each phase starts informed instead of blind.

Two operations:
- **REFRESH** — called once at plan start (`go.md` / `analyze.md` STEP 1). Keeps the
  knowledge graph fresh and installs the auto-rebuild hook.
- **GATHER** — called from `execute-phase.md` 6b, per phase, before composing the
  ralph-loop prompt. Returns lessons + boundaries to fold into the prompt.

Graphify is a search layer, not a hard dependency. At every step, if `graphify` or
`graphify-out/graph.json` is unavailable, **degrade gracefully**: fall back to
reading the codebase directly (the pre-existing behaviour) and continue.

---

## REFRESH (plan start)

1. If `graphify-out/graph.json` does not exist, skip — there is no graph to search.
   (Optionally note the user can build one by running the graphify skill; do not
   build it automatically — a build can be expensive on large repos.)
2. If it exists, check freshness against `graphify-out/manifest.json` (per-file
   `mtime` + `ast_hash`). If any tracked file changed or new files exist, run
   `graphify --update` to re-extract only the changed files. Cheap; keeps
   boundaries accurate.
3. **Auto-rebuild hook**: if `.git/hooks/post-commit` does not already run
   graphify, run `graphify hook install` so the graph rebuilds (AST track) on every
   commit during the run. Skip if it is already installed.
4. **Live query server (full integration)**: if a graphify MCP server is
   registered for the session, prefer it for GATHER's queries (lower latency, no
   shell round-trip). Otherwise GATHER uses the `graphify` CLI, and failing that
   the inline NetworkX fallback over `graph.json`.

## GATHER (per phase, from 6b)

Produce two things for the current phase and hand them back to 6b:

### A. Prior lessons
- The `## Ralph Learnings` section of the project's `_MEMORY.md`. It is usually
  already in context (auto-injected at session start as a `PROJECT MEMORY (...)`
  block); if not, **follow `procedures/project-memory.md`** RESOLVE and read it.
- `graphify-out/reflections/LESSONS.md` if present (preferred sources / known
  dead-ends / corrections, produced by `graphify reflect` — see `final-report.md`).
- Select only lessons relevant to *this* phase's objective. These go into the
  prompt's **Context** as "known pitfalls / what worked before".

### B. Graphify search → files + boundaries
Query the graph for what this phase touches. Matching is **case-folded substring +
IDF only** — no stemming/synonyms — so do the **vocab-expansion pre-step** from
graphify's `references/query.md` first: extract the graph's real node-label tokens
and pick the ones matching the phase objective (never invent tokens). Then:

- `graphify query "<expanded phase-objective tokens>"` → the files/nodes relevant
  to building this phase → seed the prompt's **Context** ("relevant existing code").
- For boundaries, use `graphify affected "<target>"` (reverse traversal — what
  depends on the node) and `graphify explain "<node>"` to see a node's neighbours.
  Files that prior, completed phases own (known from git tags / PROGRESS.md) and
  that the current phase only *depends on* (does not extend) become the prompt's
  **Boundaries** ("do NOT modify these"). `graphify path "<A>" "<B>"` helps confirm
  how two nodes relate when the dependency direction is unclear.

If graphify is unavailable, derive boundaries the old way (git tags + reading the
code) — this is exactly step 6b's original behaviour.

### Hand-off to 6b
Return: (1) a short "known pitfalls / prior lessons" block for **Context**, (2) a
"relevant existing code" file list for **Context**, (3) a "do-not-modify" file list
for **Boundaries**. 6b folds these into the prompt it composes.
