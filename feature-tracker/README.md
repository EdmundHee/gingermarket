# feature-tracker

A Claude Code mod. A **Features** pane, a tab beside plan-tracker's **Plan**, lists the current repo's
modules and the features inside each one. It also runs an opus review per module that reports:

- **Missing feature**: something the module plainly needs but lacks
- **Tech debt**: duplication, dead code, wrong abstractions, fragile code
- **Missing handling**: error handling, edge cases, validation, loading/empty states, retries
- **Test gap**: behaviour no test covers
- **Security**: authz, injection, secrets, unsafe input
- **Improvement**: UX, performance, clearer API, simpler flow; not a defect. The pane lists these apart,
  under **Ideas**.

```
Features · syph (vault)             [ Scan ]
▾ Auth
  3✓ 1◐ 1○ 0✗ · 2 open · 1 idea · stale · 3 files
  [ Review ] [ Note ]
    ✓ Email login
    ◐ Password reset
  ▾ Fixes 3  [ all ]
    ▾ auth-login 2 · 1 high      [ PR ▶ ]
        ◉  high  No rate limit on login  [ ▶ ]
        ○  med   Lockout never resets    [ ▶ ]
    ▸ postgres 1 · 1 med         [ PR ▶ ]
  ▸ Ideas 1  [ all ]
  [ Plan 1 selected ]
▸ Billing
  2✓ 0◐ 0○ 1✗ · never reviewed
  [ Review ]
```

Actions are framed (`[ … ]`); module, group and finding rows are plain. Severity shows as a filled chip:
`high` red, `med` yellow, `low` blue. Status counts take their glyph's colour, and `stale` is yellow.

## Install

```
/plugin install feature-tracker --marketplace EdmundHee/gingermarket
```

Working from a clone instead: `claude plugin marketplace add <clone folder>`, then
`claude plugin install feature-tracker@gingermarket`.

## Use

1. **Scan** (or `/feature-tracker scan`). An opus subagent reads the repo, plus graphify's
   `GRAPH_REPORT.md` if one exists, and drafts `features.md`. After that the file is yours to edit:
   ```
   ## Auth
   paths: server/auth/**, client/src/login/**
   - [done] Email login
   - [partial] Password reset
   ```
   A status is `planned`, `partial`, `done` or `broken`. `paths:` are git globs from the repo root.
   Text after ` — ` on a feature line is your note: kept, hidden in the pane, given to the reviewer.
   Any other line is kept and ignored. A later Scan only **appends**: new features go at the end of
   their module with ` (new)`, new modules go at the end of the file. It never rewrites or removes a
   line of yours.
2. **Review** on a module (or `/feature-tracker review <module>`). A read-only opus subagent
   (Read/Grep/Glob only) reviews that module's paths. A second run of it then checks each finding
   against the code (the button shows `verifying…`): `true` stays, `partly` stays with a
   `verify: partly — …` line, and `false` goes under `## Rejected by verifier`, already ticked, with
   the reason. It can re-rate severity. Then the mod writes a new note,
   `reviews/YYYY-MM-DD_<module>-<sha7>.md`, with one `- [ ]` checkbox per finding and
   `verified: n/m` in its frontmatter. Each finding also gets an area **tag**, the part of the
   product its fix is for (`auth-login`, `auth-password`, `postgres`, `database`): lowercase
   kebab-case, at most 24 characters, sized so one tag's findings make one PR. The reviewer is
   shown every tag already used in the repo and reuses one when it fits. A finding line reads
   ``- [ ] high · `auth-login` · server/auth/login.ts:42 — No rate limit → add a limiter``; the tag is
   in backticks, not `#`, so it never becomes an Obsidian tag. If the check fails, the findings are kept as the reviewer
   wrote them and the toast says `unverified`. Untick a rejected finding to bring it back.
   Files under the module's paths that were uncommitted at review time are recorded as `dirty: N`,
   and the pane shows `dirty`, since the note's sha doesn't hold what the reviewer read.
3. **Tick a box** in the note when a finding is fixed or not worth fixing. The next review of that
   module reads the last 5 notes. Ticked findings are not repeated, and open ones it finds fixed are
   listed under `## Resolved since last review`. Old notes are never rewritten, so the history stays.
4. **Expand** a module (▸) to see `Fixes N` and `Ideas N`. Open a group to see its unticked findings
   by tag, most urgent first (more `high`, then `med`, then `low`). Each tag row is a suggested PR:
   **PR ▶** plans all of that tag's findings as one branch and one PR. Open a tag row to list its
   findings. Click findings to select them, or `all` for the whole group, then **Plan N selected**.
   **▶** plans one finding right away. Each way Claude gets a plan-mode prompt that quotes the chosen note
   lines and asks it to check each one against the current code first, dropping or lowering any
   that is wrong or overstated. It also asks Claude to tick each finding's box in the note once it is
   fixed or dropped. The pane re-reads the note after every turn, so a ticked finding leaves its group.
   With plan-tracker installed, the approved plan's items are tracked as usual. **Note** opens
   the newest review note (`open`, else `xdg-open`, else a toast with its path). Notes written
   before tags show their findings under `untagged` until the module's next review.

A module shows `stale · N files` once files under its paths have changed since the commit it was last
reviewed at (`git diff --name-only <sha> -- ':(glob)<path>'`; no model call). A review never edits
`features.md`.

## Where things are kept

| Setting `notesDir` (`/config`) | Folder |
|---|---|
| empty (default) | `<repo>/docs/features/`: `features.md` and `reviews/` |
| an Obsidian folder that holds one folder per project, e.g. `~/.obsidian/MyVault/Projects` | `<notesDir>/<project>/` |

The vault project is the folder named after the repo. If `<notesDir>/_tools/groups.json` exists and
lists the repo under `projects.<name>.repo`, `<name>` is used instead, and the note frontmatter gets
that entry's `group` and `stack`. If the folder doesn't exist, the pane says so and keeps using
`docs/features/`. In vault mode notes carry `Project: [[<project>]]` for Obsidian's graph.

## Cost

Each Scan is one opus subagent run that reads code with tools. A Review with findings is two (review,
then verify); one with none is one. Cost grows with the module's size. Nothing runs on its own. Staleness and the pane use only git and file reads.

The engine also hands each reader's report to your main session as a message, which would start a
Claude turn over it. The mod already has the report, so it drops that message. You'll see
`Prompt dropped by a hook: feature-tracker already took its reader's report` in the transcript.
