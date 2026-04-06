# Procedure: Resolve Plan Path

This is a shared procedure called by ralph-helper commands. The calling command MUST specify these parameters before invoking this procedure:

- **Filter patterns**: Which filename patterns to exclude (e.g., `-agent-`, `-ralph-helper`)
- **Prefer progress**: Whether to prefer plans that have existing `ralph-helper.json` progress files (Yes/No)
- **Check pre-analyzed**: Whether to check for and prefer a `-ralph-helper` variant of the plan (Yes/No)
- **Confirmation question**: The exact question to ask the user (e.g., "Is this the plan you want to execute?")

---

## Procedure Steps

If `$ARGUMENTS` is not empty, use it as the plan path and return to the calling command.

If `$ARGUMENTS` is empty:

1. Run `ls -t ~/.claude/plans/*.md` to list all plan files sorted by modification time (most recent first).

2. Filter out any file whose name contains any of the stated **filter patterns**.

3. If no files remain after filtering, tell the user: "No plan files found in `~/.claude/plans/`." and stop.

4. **If "Prefer progress" is Yes**: For each candidate (starting from most recent), derive the plan name from the filename and check if `./logs/<plan-name>/ralph-helper.json` exists. If a plan with existing progress is found, select it. Otherwise, fall through to the most recent plan.
   - If no plans have progress and the calling command requires progress (resume, test), note this to the user appropriately.

5. **If "Prefer progress" is No**: Take the most recently modified file from the filtered list.

6. **If "Check pre-analyzed" is Yes**: If the selected candidate is `foo.md`, check if `foo-ralph-helper.md` exists in the same directory. If it does and it is at least as recent as the base plan, prefer the `-ralph-helper` variant. Note to the user: "A pre-analyzed version of this plan exists. Using that for optimized execution."

7. Read the first few lines of the selected file to extract the first heading as a brief summary.

8. Present to the user:
   - The filename and full path
   - When it was last modified
   - The brief summary (first heading)
   - Progress status (if "Prefer progress" is Yes and progress was found)
   - If the file was last modified more than 24 hours ago, add a staleness warning

9. Ask the stated **confirmation question**.

10. If the user confirms, use that file as the plan path and return to the calling command.

11. If the user says no, list the 5 most recent candidate files (with dates and summaries) and ask the user to pick one, or provide a path manually.
