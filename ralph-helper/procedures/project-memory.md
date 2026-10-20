# Procedure: Project Memory (Obsidian)

This is a shared procedure called by ralph-helper procedures. It finds the
project's folder in the user's notes vault and owns the rules for writing into it.
Vault memory is optional: with no vault, `logs/<slug>/learnings.json` and graphify
still capture every lesson.

The vault is the plugin setting **notesDir**: a folder holding one folder per
project (e.g. `~/.obsidian/MyVault/Projects`). Commands print it in their header as
"Notes dir". Empty, or a literal `${user_config.notesDir}` (setting unset), means no
vault.

---

## RESOLVE

Run:

```
bash "${CLAUDE_PLUGIN_ROOT}/scripts/vault-dir.sh" "<notes dir>"
```

- It prints the project folder, or nothing.
- It matches the repo against `<notesDir>/_tools/groups.json` (`projects.<name>.repo`
  lists git roots, case-insensitive), else uses the git root's basename.
- It returns a folder only if it already exists. When it doesn't, it prints a hint
  (naming the vault's `_tools/new_project.sh` when present) on stderr. Pass that
  hint on to the user once.

**Never create the project folder or its subfolders yourself.** A vault has its own
way to register projects. Nothing printed → skip every vault write.

## Write rules

ralph-helper writes only these, in the folder RESOLVE printed:

- **`_MEMORY.md` → `## Ralph Learnings`** (capture-learnings): if the file exists
  but has no such heading, append `## Ralph Learnings` at the end. Insert the new
  lesson as the top bullet, `- <YYYY-MM-DD> [<slug>/phase <N>] <lesson>`, and merge
  near-duplicates. **Cap: 10 bullets of at most 160 characters each**; drop the
  oldest beyond 10. If `_MEMORY.md` does not exist, skip; don't seed one.
- **`sessions/<YYYY-MM-DD>_ralph-<slug>.md`** (final-report): one per run end. If
  the name exists, add `-2`, `-3`, … The note starts with `Project: [[<project>]]`
  (the folder name). Skip if there is no `sessions/` folder.
- **`_MEMORY.md` → `## Recent Changes`** and the hub note `<project>.md` (final-report,
  success only): one bullet / line ending in the session note's `[[wikilink]]`,
  newest first. Touch only sections that already exist.

Dates: `date +%F`. Never rewrite other sections of `_MEMORY.md`.
