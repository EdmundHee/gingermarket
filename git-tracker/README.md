# git-tracker

A Claude Code mod. A **Git** pane, a tab beside plan-tracker's **Plan**, shows where the current branch
stands:

- the branch it was cut from, and git's own graph of both since the fork
- changed files with `+added −removed` line counts (`bin` for binary files)
- new files: added on the branch, and untracked ones not yet committed
- the PR for the branch, number, state and a clickable link, once one exists

```
feat/x ← main  2↑ 1↓                    ↻
* 3e1c2aa (HEAD -> feat/x) feat: pane
| * 9f8e7d1 (main) fix typo
|/
o 872a03f Merge: plan-tracker
CHANGED 2                         +40 −12
  hooks/register.tsx              +40 −12
  img.png                             bin
NEW 1                                 +30
  README.md                           +30
PR #12 open
https://github.com/o/r/pull/12
```

## Install

```
/plugin install git-tracker --marketplace EdmundHee/gingermarket
```

Working from a clone instead: `claude plugin marketplace add <clone folder>` then
`claude plugin install git-tracker@gingermarket`.

## Use

- The pane opens by itself at session start in the fullscreen layout from 144 columns. `/git-tracker`
  opens it at any width.
- With plan-tracker installed too, the two are tabs: `ctrl+x tab` gives the panes the keyboard and
  switches tabs, `Esc` goes back to the prompt, `ctrl+x x` closes the pane on show.
- `↻` refreshes by hand. Otherwise the pane refreshes after each `Edit`, `Write`, `MultiEdit`,
  `NotebookEdit` or `Bash` call and at the end of every turn.
- **Parent branch**: of every local and remote branch (the branch's own upstream left out), the one
  missing the fewest of HEAD's commits; ties go to `main`/`master`/`develop`/`dev`, then local over
  remote, then fewest behind. On one of those trunk names there is no parent: the graph is the last
  12 commits and only uncommitted work is listed.
- **Files** compare the working tree to the fork point (`git merge-base`), so Claude's edits show
  before anything is committed. The first 30 untracked files are counted.

## What it runs

Commands only, through `$.process.run` in the session's folder, never a shell:

| When | Commands |
|---|---|
| every refresh | `git rev-parse`, `git for-each-ref`, one `git rev-list --left-right --count` per branch, `git merge-base`, `git log --graph`, `git diff --numstat --summary`, `git ls-files --others`, one `git diff --no-index --numstat` per untracked file |
| session start, turn end, `/git-tracker`, `↻`, and after a Bash `gh pr …` or `git push` | `gh pr view --json number,url,state,isDraft` too |

No `gh`, no PR, or `gh` not signed in: the PR row is left out. No model calls.
