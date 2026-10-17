# design-tracker

A Claude Code mod. A **Design** pane, a tab beside plan-tracker's **Plan** and git-tracker's **Git**, shows the
Claude Design canvas this project is built from and how far the build has got:

- the canvas and its design library, both clickable
- every artboard, by the canvas's own pages, with its design state (`draft` or approved) and build state:
  `○` not started, `◐` in progress, `✓` done
- `▶` on an approved artboard not yet done sends Claude to build it; `audit` asks Claude to mark what the code
  already has; `↻` reads the canvas again

```
Syphonr flows                     audit ↻
lib Syphonr                 ✓12 ◐2 ○40

F07 Conversation           ✓4 ◐1 ○25
  ◐ F07b Composer — data source picker
  ○ F07c Share chat — actions         ▶
  ✓ F07a Conversation home — workspa…

F18 Skills                       ✓0 ◐0 ○6
  ○ F18 SKL-00 — Settings · Skills… draft
```

## Install

```
/plugin install design-tracker --marketplace EdmundHee/gingermarket
```

Working from a clone instead: `claude plugin marketplace add <clone folder>` then
`claude plugin install design-tracker@gingermarket`.

## Use

- Link the project once: `/design-tracker https://claude.ai/artifact/<canvas id>` (the canvas's link from
  claude.ai). The link and the build states go in `.claude/design-tracker.json`; commit it so teammates see the
  same. `/design-tracker` alone opens the pane.
- The library is the one installed on the canvas (its first design system); nothing to set.
- Design state comes from the artboard title: Claude Design has no approval field, so a `[Draft]` tag is a draft
  and no tag is approved. Titles holding `(retired …)` are left out.
- Build state:
  - `○` the artboard has no entry in `.claude/design-tracker.json`.
  - `◐` Claude called `mark_board` with `started`, or a turn that `▶` started edited a project file.
  - `✓` Claude called `mark_board` with `done` and the files that implement it. If every one of those files is
    gone, the artboard shows `◐` again.
- Work typed without `▶` is marked by Claude, who is told about the canvas and `mark_board` every turn. `audit`
  catches up an existing codebase.
- The pane opens by itself at session start in the fullscreen layout from 144 columns. With plan-tracker and
  git-tracker installed too, `ctrl+x tab` switches tabs.
- The canvas is read at session start, on `/design-tracker` and on `↻`; build states redraw after every mark.

## What it runs

- `Artifact` (`action: read`, `path: project/canvas.json`) through the engine's own tool call, so your claude.ai
  login and permission rules apply. If the first read asks permission, allowing `Artifact` stops the question.
- File reads and writes: `.claude/design-tracker.json`, and an existence check for each done artboard's files.

No model calls of its own: the marks come from your session's model through `mark_board`, and `▶` and `audit` only
send it a prompt.
