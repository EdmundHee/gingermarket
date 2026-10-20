# Procedure: Capture Learnings

This is a shared procedure called by `execute-phase.md` at a phase's **terminal
outcome**: a passing gate (step 5) or the final failure after all retries (step 6,
attempt 3). It distills what happened into one durable lesson and writes it to
three homes so later phases and future runs can learn from it.

**Call this ONCE per phase, at the terminal outcome only.** Do NOT call it on
intermediate retries; a half-lesson per retry is noise.

The caller MUST provide:
- **Slug**, **Phase number**, **Phase name**
- **Outcome**: `success` or `failure`
- **Estimate**, **Iterations** (test-fix cycles the agent reported) and **Attempts**
- **Root cause** (required on failure and on a success that took retries; null on a
  clean first-try success)
- **Fix / what worked** (the approach that passed, or on failure the last approach
  and why it fell short)
- **Tests touched** (names/files), **Browser verified** (true/false/null) and
  **Boundary violation** (true if the gate found a protected file changed)

---

## Distill the lesson

One caveman-compact lesson, 1–3 lines. Failure or corrected form:
`<what failed> — root cause: <X> → fix: <Y>`. Clean-success form:
`<what worked>: <the approach / key decision>`. Specific to *this* codebase (the
file, the framework quirk, the gotcha), not generic advice.

## Redact before writing anywhere

Root causes come from test and error output. Before any of the three writes,
replace secrets with `[redacted]`: API keys and tokens (`sk-…`, `ghp_…`, `xox…-`,
`AKIA…`, long base64/hex strings next to `key`, `token`, `secret`, `password`),
`Authorization:` / `Bearer` values, and credentials in URLs (`scheme://user:pass@host`
→ `scheme://[redacted]@host`). The vault is often synced; logs and graphify-out may
be committed.

## Home 1 — vault `_MEMORY.md`

**Follow `${CLAUDE_PLUGIN_ROOT}/procedures/project-memory.md`** RESOLVE with the
notes dir. If it prints a folder, add the lesson to `## Ralph Learnings` per its
write rules (heading added if missing, 10-bullet / 160-char cap). Nothing printed →
skip this home; the other two still capture.

## Home 2 — `./logs/<slug>/learnings.json`

Read the file. If it exists but does not parse as JSON, `mv` it to
`learnings.json.bak-$(date +%Y%m%d%H%M%S)` and say so; start a fresh file. Append
one entry to `entries` and write the whole file back:

```json
{
  "plan": "<slug>",
  "entries": [
    {
      "phase": 1,
      "phase_name": "<name>",
      "outcome": "success",
      "estimate": 5,
      "iterations": 3,
      "attempts": 1,
      "root_cause": null,
      "fix": "<text>",
      "tests_touched": ["<name>"],
      "browser_verified": null,
      "boundary_violation": false,
      "commit": "<done_sha, or start_sha on failure>",
      "date": "<date +%F>"
    }
  ]
}
```

`outcome` is `success` or `failure`. `logs/` is git-excluded (run-state preflight),
so no reset or clean removes earlier entries. This is the feed
`/ralph-helper:evolve` counts from.

## Home 3 — graphify (searchable, feeds `reflect`)

Only if `graphify` is on PATH and `graphify-out/` exists; otherwise skip and note it.
Map the outcome: success with 1 attempt → `useful`; success after retries →
`corrected`; failure → `dead_end`.

Pass every free-text value through a quoted heredoc, never raw inside double
quotes: backticks or `$(…)` in a lesson would otherwise run as commands.

```
graphify save-result \
  --question "$(cat <<'EOF'
Phase <N> (<phase name>): <objective in a few words>
EOF
)" \
  --answer "$(cat <<'EOF'
<the redacted lesson>
EOF
)" \
  --type query \
  --outcome useful|corrected|dead_end \
  --nodes <file1> <file2>
```

`--nodes` takes space-separated file names. **Scope them to the file(s) the outcome
is about.** On `corrected`/`dead_end`, `reflect` marks every listed node as partly
a dead end, so list the file that was at fault, not the good building block it
should have reused.
