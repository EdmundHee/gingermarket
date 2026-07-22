# Procedure: Final Report

This is a shared procedure called by ralph-helper commands after all phases complete successfully.

---

## Procedure Steps

1. **Run the full test suite** one final time to confirm everything passes.

2. **Present a summary**:
   - Total phases completed
   - Total iterations used across all phases
   - Full test suite results
   - List of files created/modified
   - Git tags for each phase boundary

3. **Update PROGRESS.md** with final status marking the plan as fully complete.

4. **Reflect (graphify)**: run `graphify reflect --if-stale`. This deterministically
   folds the run's `save-result` entries (written by `capture-learnings.md`) into
   `graphify-out/reflections/LESSONS.md` — preferred sources, known dead-ends, and
   corrections that future runs read via `inject-context.md`. No LLM cost. Skip if
   `graphify` is unavailable.

5. **Persist run memory (Obsidian)**: **follow the procedure in
   `procedures/project-memory.md`** RESOLVE. If a vault folder exists:
   - **Session log**: write `sessions/<YYYY-MM-DD>_<slug>.md` (date from
     `git log -1 --format=%cd --date=short`) starting with `Project: [[<project>]]`
     — what was built, phases completed, key decisions, any blockers, next steps.
   - **Roll up `_MEMORY.md`**: add one `## Recent Changes` bullet for this run
     (newest first, ending in a `[[<session-file>]]` wikilink); promote durable
     items from `## Ralph Learnings` into `## Features` / `## Key Decisions`; update
     the `updated:` frontmatter date. **Enforce the ~150-line cap** — merge and drop
     the oldest `## Recent Changes` lines rather than appending forever.
   - **Hub note**: append a `- <date> — [[<session-file>]]` line to the project's
     hub note (`<project>.md`) if one exists.

   Skip step 5 entirely if no Obsidian vault exists on this machine.
