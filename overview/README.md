# overview

A Claude Code mod. An **Overview** pane, a tab beside plan-tracker's **Plan**, shows where the work stands in four
rows: three drawn from the trackers' own data, and this project's tokens:

```
PLAN MODE                                   42/44
  plan-tracker 0.4.9: fewer rounds… ▰▰▰▰▰▰▰▰▰▰ 42/44
    Plan                                   9m 40s
    Codex review                              44s
    Dev                                  ● 1m 52s
    Test                                   6m 46s
    Codex verify                           8m 53s
    Total                                 27m 57s
  #298 #304 need you; press ▶ or ✓

GIT
feat/overview ← dev  2↑ 0↓
PR #21 open
https://github.com/EdmundHee/gingermarket/pull/21
CHANGED 2                                 +20 −3
NEW 3                                       +412

TESTS
feat/overview · Branch tests
▰▰▰▰▰▰▰▰▰▱ 12/14 · 8s
  ✓ 11  ✗ 1   now: overview pane renders

Branch TCs 6   ✓ 4  ✗ 1  · 1 not run
  ✗ TC-306 overview plan row
  · TC-311 overview empty state

Last full     ✓ 118/118   1h ago
Last branch   ✗ 52/53   2m ago

TOKENS

                      in     out   cache   total
This session           0       0       0       0
November            5.0K    2.8M  536.7M  539.5M
Since 20 Oct        5.3K    2.9M  559.9M  562.8M
cache = 10.0M write + 550.0M read

Days  Months
                          █                202.2M
                          █
                          █
                          █
                          █     ▅ ▃        101.1M
                    ▂ ▃   █     █ █
                    █ █   █   ▁ █ █
                    █ █   █ ▁ █ █ █ ▃ ▂    0
7 Nov                            26 Nov
```

- **Plan**: the latest plan of each source (`PLAN DOCS`, `PLAN MODE`, `TASKS`), folded as plan-tracker draws it: its
  title, bar and count, its time per phase (`●` on the one running) and Total, and its note; a finished plan is one
  `✓` line. The latest is the newest, or the one whose clock runs (a plan approved again keeps its old place). Older
  plans, items and buttons stay in the Plan tab.
- **Git**: git-tracker's branch line (the branch it was cut from, commits ahead and behind), the PR and its link, and
  the changed and new file counts with their line totals. The graph and the file list stay in the Git tab.
- **Tests**: test-tracker's summary card: the run going now (else the newest), branch TCs, the last run per scope.
  The run history stays in the Tests tab.
- **Tokens**: tokens this project used, from Claude Code's transcripts of this folder, as a table: this session (with
  its subagents), this month, and every transcript counted so far, `Since` the first one's day; per row input, output,
  cache (write + read) and total, and under them the cache's write and read for all time. Under 44 columns the table
  gives way to the totals alone and an `out · cache` line. Tokens = input + output + cache write + cache read, once per model reply, as `/cost`-style tools count
  them: a resumed session's transcript repeats its parent's replies and links its subagent files, and those count
  once. The first count after install reads every transcript once (`Counting tokens…`, some seconds for ~100 MB);
  after that only what was added, every 30 s. Transcripts Claude Code deletes later (`cleanupPeriodDays`) stay
  counted. A session started in a worktree or a subfolder has its own transcript folder and is not counted here.
  Under the counts, an 8-row bar chart of total tokens: **Days** (per local day, up to the last 30, today last) or
  **Months** (up to the last 12), its bars spread over the pane's width with a gap between them, the tallest bar's count
  at the top right and half of it halfway down. Click Days or Months to switch; the choice is kept. A day bar needs 2
  columns and a month 3, so a narrow pane shows fewer (30 days from 68 columns), none under 20 columns. After updating
  from 0.2.0 or 0.3.0, the transcripts on disk are counted again once, to split their months into days and their
  months into input, output and cache; deleted ones keep their counts (a dim line says how much of this month has no
  split).

The pane opens at session start; `/overview` opens it again. Rows are split by a dim rule, each row's title in its own
color (Plan teal, Git orange, Tests blue, Tokens purple). Times tick each second while a plan phase or a test run runs.

### Tab order

Tabs follow the order panes open. Overview opens its pane as soon as its session starts, so it is the first tab when
Claude Code starts it before the trackers, as it did installed after them (probe of the plugin chain:
feature-tracker, ravenquill, overview, plan-tracker, git-tracker, test-tracker). The order Claude Code starts plugins
in is its own, not a setting Overview controls. If a tracker's tab comes first, close the trackers' tabs and reopen
them with `/plan-tracker`, `/git-tracker`, `/test-tracker`: they open after Overview.

Overview is also the tab shown at start. It opens with `focus`, the only open that brings a pane to the front;
without it the last tab to open (Features) is shown. `focus` also gives the pane the keyboard while the prompt is
empty: letters still land in the prompt, but the first Up (history), Shift+Tab (mode) or Esc goes to the pane. One
Esc, or a letter typed, gives the keys back. With text already in the prompt, or a dialog up, Claude Code refuses the
focus and the pane opens behind. A plugin reload re-opens the pane without `focus`, so the tab you are on stays; if you closed Overview, a reload
opens it in front again.
`/overview` brings Overview to the front the same way. Like any pane Claude Code opens unasked, it is drawn from
144 terminal columns; narrower, it waits until you run `/overview` or widen the terminal.

## Needs

plan-tracker, git-tracker and test-tracker, installed and enabled: `plugin.json` lists them under `dependencies`. A
row whose tracker has no data yet shows a one-line empty state (`No plan tracked yet.`, `Reading git…`,
`No test runs yet.`). With no transcript kept for the session, the Tokens row says `No transcript to count.`

## What it runs and writes

It runs nothing: no git, gh, test command or model call. It reads the three trackers' session state (any plugin may
read another's; only the owner writes it) and redraws when they write. Its own timer checks each second and redraws
while a plan phase or a test runs, or when a `… ago` label changes. The same timer reads the transcripts in
`~/.claude/projects/<this folder>/` (the bytes added since the last read, at most 8 MiB a second) and writes the
token tally to its own plugin store, keyed by that folder: per transcript a read offset, the counts (in all, per month,
per month split four ways, per day), and a 4-byte hash of each reply's id while the transcript is on disk; the chart choice under `chart`. A read or save that fails shows as a dim line under the counts.

## Install

```bash
/plugin install overview@gingermarket
```
