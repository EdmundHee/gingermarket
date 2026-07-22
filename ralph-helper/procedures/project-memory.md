# Procedure: Project Memory (Obsidian)

This is a shared procedure called by ralph-helper commands. It resolves the
project's Obsidian vault folder and bootstraps it so the durable, cross-session
memory layer exists. **Reads are automatic** — a SessionStart hook
(`~/.claude/hooks/project-memory.sh`) injects the matching project's
`_MEMORY.md` into every future session by repo/cwd basename. This procedure owns
the **write** side: it makes sure the folder + `_MEMORY.md` exist so later
procedures (`capture-learnings.md`, `final-report.md`) have somewhere to write.

The calling command specifies one **operation**:
- **RESOLVE** — return the vault folder path for the current project. Create nothing.
- **BOOTSTRAP** — RESOLVE, then create the folder tree + a seeded `_MEMORY.md` if
  (and only if) it does not already exist. Idempotent.

---

## Vault location & project name

- **Vault root**: `~/.obsidian/GingerVault/Claude Code Logs`.
- **Project name**: the basename of the git root (`git rev-parse --show-toplevel`),
  falling back to the basename of `$PWD`. This MUST match how the SessionStart
  hook resolves the name, or auto-injection will silently miss.
- **Casing**: the hook matches folder names **case-insensitively** (`find -iname`).
  The repo may be checked out at a mixed-case path (e.g. `Work/GitHub/...`) while
  other tools record it lowercase (`work/github/...`). Do not create two folders
  that differ only in case. When RESOLVE finds an existing folder by
  case-insensitive match, reuse it verbatim; only create a new folder (using the
  git-root basename as-is) when none matches.

## RESOLVE

1. If `~/.obsidian/GingerVault/Claude Code Logs` does **not** exist, the Obsidian
   vault is not set up on this machine. Return "no vault" — callers must degrade
   gracefully (skip Obsidian writes; `learnings.json` + graphify still capture
   everything). Do **not** create the vault root yourself.
2. Compute the project name (above).
3. Case-insensitively look for an existing folder:
   `find "$VAULT" -maxdepth 1 -type d -iname "<project>"`. If found, return it.
4. If none found, return the intended path `<VAULT>/<project>` (not yet created)
   plus a flag that it is missing.

## BOOTSTRAP

Run RESOLVE first.
- If RESOLVE returned "no vault": stop, report that Obsidian memory is unavailable
  on this machine, and let the caller proceed without it.
- If the folder exists **and** contains `_MEMORY.md`: do nothing (idempotent).
- Otherwise create:
  - The project folder (if missing) and subdirs `plans/`, `decisions/`, `sessions/`.
  - `_MEMORY.md` seeded from the template below, filled from what you already know:
    the plan being executed, the codebase language/stack (from
    `detect-test-framework.md` + a quick read), and the project's purpose. Keep it
    honest — leave a section terse (`_TBD_`) rather than inventing detail.

Never overwrite an existing `_MEMORY.md`. Bootstrapping only fills the gap.

## `_MEMORY.md` structure (source of truth for all writers)

Match the vault's existing convention exactly (see `~/.claude/CLAUDE.md`
"Project Memory"), plus one ralph-helper-owned section:

```markdown
---
project: <project>
updated: <YYYY-MM-DD>
---
Project: [[<project>]]

# <project> — Memory

## Overview
<2–3 lines: what this project is.>

## Stack
<one dense line: framework, DB, deploy.>

## Direction
<current focus / goals.>

## Features
<bullets of what exists. `_TBD_` if unknown at bootstrap.>

## Recent Changes
<one bullet per plan, newest first, each ending in a [[wikilink]].>

## Key Decisions
<one line each, [[wikilink]] where a decision file exists.>

## Open Threads
<unfinished work / known risks.>

## Ralph Learnings
<ralph-helper writes here. One bullet per durable lesson, newest first:
`- <YYYY-MM-DD> [plan/phase] outcome — root cause → fix / what worked`.
Merge and rewrite; do NOT append forever. Hard cap enforced by final-report.md.>
```

- The `Project: [[<project>]]` backlink is what clusters the note in Obsidian's
  graph view — never omit it.
- `<YYYY-MM-DD>`: derive from `git log -1 --format=%cd --date=short` (do not guess
  today's date).

## Write conventions (used by callers)

- **Append a learning**: edit the `## Ralph Learnings` section — insert the new
  bullet at the top, merge near-duplicates, keep it caveman-compact.
- **Roll up** (final-report.md): promote durable lessons from `## Ralph Learnings`
  into `## Features` / `## Key Decisions`, add a `## Recent Changes` bullet for the
  run, and enforce the ~150-line cap (oldest Recent-Changes lines drop off).
