# Procedure: Run State

This is a shared procedure called by ralph-helper commands. It owns the three
things every command must agree on: the plan's **slug**, the **state file**, and
the **preflight** that makes rollback safe. Every other procedure reads phases,
the test command and git checkpoints from the state file, never from the plan or
from memory.

---

## Slug

Take the plan's filename, drop `.md`, drop a trailing `-ralph-helper`, lowercase
it, and replace every run of characters outside `[a-z0-9]` with one `-` (trim
leading/trailing `-`). `./plans/User Auth-ralph-helper.md` → `user-auth`.

The slug names the logs folder (`./logs/<slug>/`), the branch (`ralph/<slug>`) and
the tags (`ralph-helper/<slug>/phase-<N>`). A plan and its `-ralph-helper` copy
share one slug, so `go foo-ralph-helper.md` and `resume foo.md` find the same run.

## State file — `./logs/<slug>/ralph-helper.json`

The only source of truth for a run. Write it whole (Write tool) after every
change; keep it valid JSON.

```json
{
  "plan": "<slug>",
  "plan_path": "<absolute path of the plan file that was confirmed>",
  "branch": "ralph/<slug>",
  "test_command": "<command that runs the whole suite, e.g. python3 -m unittest>",
  "status": "running" | "done" | "failed",
  "phases": [
    {
      "n": 1,
      "name": "<phase name>",
      "objective": "<what this phase builds>",
      "tests": ["<test name or assertion>", "..."],
      "done_when": ["<concrete criterion>", "..."],
      "protected": ["<file the plan says not to modify>", "..."],
      "estimate": 5,
      "browser": false,
      "status": "pending" | "running" | "done" | "failed" | "stale",
      "start_sha": null,
      "done_sha": null,
      "tag": null,
      "attempts": 0,
      "iterations": 0,
      "test_exit": null,
      "test_count": null,
      "test_files": [],
      "started_at": null,
      "finished_at": null
    }
  ]
}
```

- `estimate` / `iterations`: test-fix cycles the phase's agent may use / did use.
- `attempts`: agent runs for this phase (1 + retries).
- `test_count`: tests the gate saw pass. `test_files`: test files the phase added or
  changed. Both feed the next phases' gate.
- Times: `date -u +%FT%TZ`.
- **Clash check**: if `./logs/<slug>/ralph-helper.json` exists with a different
  `plan_path`, stop and tell the user two plans share the slug `<slug>`. Never
  overwrite another plan's run.

## Preflight

Run before any phase executes (go, resume, phase). Stop at the first failure and
tell the user what to do; never work around it.

1. **Git repo**: `git rev-parse --show-toplevel`. Not a repo → stop.
2. **Logs never tracked**: if `.git/info/exclude` (path from
   `git rev-parse --git-path info/exclude`) has no `logs/` line, append one. `git
   add -A`, `git reset --hard`, `git clean -fd` and `git stash -u` then all leave
   `./logs/` alone, so rollback never eats the run's own state.
3. **Clean tree**: `git status --porcelain` must print nothing. If the only entries
   are untracked generated files (caches, build output, dependency folders, as in
   `execute-phase.md` step 5), add their patterns to `.git/info/exclude` and check
   again. Otherwise stop: "Commit or stash your changes first — a failed phase rolls
   back with `git reset --hard`." Never stash or discard the user's work yourself.
4. **Branch**: `go` runs `git switch -c ralph/<slug>` (or `git switch ralph/<slug>`
   when it already exists and the state file is this plan's). `resume` and `phase`
   `git switch` to the state's `branch`. Phase commits never land on the user's
   branch.
5. **Test command**: use the state's `test_command`. Only when there is none
   (first `go`) follow `${CLAUDE_PLUGIN_ROOT}/procedures/detect-test-framework.md`
   and store what it finds.
