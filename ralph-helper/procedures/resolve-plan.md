# Procedure: Resolve Plan Path

This is a shared procedure called by ralph-helper commands. The calling command MUST
pass:
- **Path argument**: only the plan-path part of its arguments, with flags and phase
  numbers already removed (may be empty)
- **Filter patterns**: which filename patterns to exclude (e.g., `-agent-`, `-ralph-helper`)
- **Prefer progress**: whether to prefer plans that have a run (Yes/No)
- **Check pre-analyzed**: whether to prefer a `-ralph-helper` variant of the plan (Yes/No)
- **Confirmation question**: the exact question to ask the user

---

## Procedure Steps

If the path argument is not empty, use it as the plan path and return to the
calling command.

If it is empty:

1. List candidate plans, newest first, from both plan folders:
   `find ./plans ~/.claude/plans -maxdepth 1 -name '*.md' -exec ls -t {} + 2>/dev/null`.
   A missing folder or no match prints nothing (a bare `*.md` glob would abort in
   zsh).
2. Filter out any file whose name contains any of the stated **filter patterns**.
3. If nothing remains, tell the user: "No plan files found in `./plans/` or
   `~/.claude/plans/`." and stop.
4. **If "Prefer progress" is Yes**: for each candidate, newest first, compute its
   slug (`${CLAUDE_PLUGIN_ROOT}/procedures/run-state.md`) and check whether
   `./logs/<slug>/ralph-helper.json` exists. Select the first that has one;
   otherwise fall through to the newest candidate.
   - If none has a run and the calling command needs one (resume, test, status,
     phase), say so.
5. **If "Prefer progress" is No**: take the newest candidate.
6. **If "Check pre-analyzed" is Yes**: if the selected candidate is `foo.md` and
   `foo-ralph-helper.md` exists beside it, at least as recent, prefer it. Tell the
   user: "A pre-analyzed version of this plan exists. Using that for optimized
   execution."
7. Read the first heading of the selected file as a brief summary.
8. Present: the filename and full path, when it was last modified, the summary, the
   run status (if "Prefer progress" found one), and a staleness warning if it was
   last modified more than 24 hours ago.
9. Ask the stated **confirmation question**.
10. If the user confirms, return that path to the calling command.
11. If not, list the 5 newest candidates (with dates and summaries) and ask the
    user to pick one or give a path.
