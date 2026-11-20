# test-tracker

A Claude Code mod. A **Tests** pane, a tab beside plan-tracker's **Plan**, shows every test run as it
happens:

- the command, how long it has run, and `▶` while it runs
- each test ticked `✓` / `✗` / `○` (skipped) the moment the runner reports it, with its TC id from
  `tests/TEST_CASES.md`
- the test running now, or the last one finished
- the last five finished runs, newest first; a run still going is never dropped

```
▶ claude plugin test plan-tracker      41s
  ✓ 57  ✗ 1   last: compose_lists_open…
  ✗ TC-004 turn_end_verifies_a_claim
  ✓ TC-006 pressing_work_submits_a_prompt
  ✓ TC-005 compose_lists_open_and_claimed

✓ claude plugin test git-tracker  24/24  0.7s
✗ pytest -q                        3/4   2.1s
```

## Install

```
/plugin install test-tracker --marketplace EdmundHee/gingermarket
```

Working from a clone instead: `claude plugin marketplace add <clone folder>` then
`claude plugin install test-tracker@gingermarket`.

## Use

- The pane opens by itself at session start in the fullscreen layout from 144 columns. `/test-tracker`
  opens it at any width. With plan-tracker, git-tracker or feature-tracker installed too, they are tabs.
- **Live**: Claude runs tests through the `run_tests` tool (`mcp__test-tracker__run_tests {command}`).
  The mod starts the command itself with `/bin/sh -c` in the session folder and reads its output piece
  by piece, so each test lands in the pane as the runner prints it. A subagent's run (the screen-test
  runner, for one) shows too, marked `sub`.
- **Bash**: a test command Claude still runs through plain Bash shows as `▶ <command>` with its time
  and `(bash: results at the end)`; its rows come from the output once Bash returns. A mod cannot read
  a Bash call's output before it ends. Background Bash calls are not tracked.
- **What Claude gets back**: `exit <code> · ✓ n ✗ m · <s>s`, the failing tests with their TC ids, then
  the output with the passing-test lines dropped (last 30 000 characters kept, as Bash keeps).
- **Esc** stops the run and its child; the pane marks it `■ stopped`.

### What it reads per test

| Runner | Lines | "now" |
|---|---|---|
| bun, `claude plugin test` | `(pass\|fail\|skip\|todo) name [ms]` | last finished |
| pytest `-v` | `path::test PASSED\|FAILED\|ERROR\|SKIPPED\|XFAIL\|XPASS` | the test it has just named |
| pytest `-q` | the dots (`.` `F` `E` `s` `x` `X`) as counts, `[ 80%]` as progress; names of failures from its `FAILED path::test` summary. Use `-v` for every name | the `%` |
| vitest, jest | `✓` / `×` / `↓` test lines; file lines (`(5 tests)`, jest `PASS file`) are not counted | last finished |
| screen scripts | `TC-012: PASS\|FAIL`, `=== tests/screen/TC-012.mjs` | the script running |

Other lines are ignored. The run's own `✓`/`✗` is its exit code, not the counts.

Rows tick live only as fast as the runner writes. `claude plugin test` prints its whole report when the
suite ends (piped or under a pty), so its run shows `▶` and the time, then every row at once. Plain
`bun test` writes no per-test lines when its output is not a terminal, only the totals. pytest streams
per test (the mod sets `PYTHONUNBUFFERED=1`), and the screen run line streams per script.

**TC ids**: each row's `Code test` cell (`path > name` or `path::name`) is matched by the test's name,
a trailing `(…)` or `[…]` parameter dropped. Two rows with the same name: the one whose path holds the
test's own prefix (bun's describe, pytest's file); still two, no id.

## Permissions

`run_tests` goes through the permission check like any tool: the person approves each command. Allowing
the tool in settings lets **any** command it is given run without a prompt; Bash rules can allow per
command, this tool cannot.

## What it runs and writes

- The test command given to `run_tests`, as `/bin/sh -c <command>` with `PYTHONUNBUFFERED=1`,
  `NO_COLOR=1`, `FORCE_COLOR=0` (pytest writes per test only unbuffered; colour codes would split the
  markers).
- Reads `tests/TEST_CASES.md` at the start of each run. Writes nothing to disk; the runs live in the
  session's plugin state.

## Limits

- `/bin/sh`, not your zsh: a command using zsh-only syntax fails.
- No timeout of its own; Esc stops a run.
- A runner not listed above shows its command, time and exit, with no rows.
