# overview

A Claude Code mod. An **Overview** pane, a tab beside plan-tracker's **Plan**, shows where the work stands in three
rows, each drawn from its tracker's own data:

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
```

- **Plan**: plan-tracker's plans, folded: each source (`PLAN DOCS`, `PLAN MODE`, `TASKS`) with its count, each plan's
  title, bar and count, its time per phase (`●` on the one running) and Total, and its note. Items and buttons stay
  in the Plan tab.
- **Git**: git-tracker's branch line (the branch it was cut from, commits ahead and behind), the PR and its link, and
  the changed and new file counts with their line totals. The graph and the file list stay in the Git tab.
- **Tests**: test-tracker's summary card: the run going now (else the newest), branch TCs, the last run per scope.
  The run history stays in the Tests tab.

The pane opens at session start; `/overview` opens it again. Rows are split by a dim rule, each row's title in its own
color (Plan teal, Git orange, Tests blue). Times tick each second while a plan phase or a test run runs.

### Tab order

Tabs follow the order panes open. Overview opens its pane as soon as its session starts, so it is the first tab when
Claude Code starts it before the trackers, as it did installed after them (probe of the plugin chain:
feature-tracker, ravenquill, overview, plan-tracker, git-tracker, test-tracker). The order Claude Code starts plugins
in is its own, not a setting Overview controls. If a tracker's tab comes first, close the trackers' tabs and reopen
them with `/plan-tracker`, `/git-tracker`, `/test-tracker`: they open after Overview.

## Needs

plan-tracker, git-tracker and test-tracker, installed and enabled: `plugin.json` lists them under `dependencies`. A
row whose tracker has no data yet shows a one-line empty state (`No plan tracked yet.`, `Reading git…`,
`No test runs yet.`).

## What it runs and writes

Nothing. It reads the three trackers' session state (any plugin may read another's; only the owner writes it) and
redraws when they write. Its own timer checks each second and redraws while a plan phase or a test runs, or when a
`… ago` label changes. No git, gh, test command or model call.

## Install

```bash
/plugin install overview@gingermarket
```
