# Procedure: Capture Learnings

This is a shared procedure called by `execute-phase.md` at a phase's **terminal
outcome** — a successful gate (6f) or a final failure after all retries are
exhausted (6h). It distills what happened into a durable lesson and writes it to
three homes so future phases and future runs can learn from it.

**Call this ONCE per phase, at the terminal outcome only.** Do NOT call it on
intermediate retries — mid-retry, the full error context is still in the window
and the agent is adapting live. Capturing half-lessons per retry is noise.

The calling command MUST provide:
- **Plan name**, **Phase number**, **Phase name**
- **Outcome**: `success` or `failure`
- **Iterations used** and **Retries used** for this phase
- **Root cause** (what went wrong — required on failure, and on a success that
  took retries; null on a clean first-try success)
- **Fix / what worked** (the approach that passed, or — on failure — the last
  approach tried and why it fell short)
- **Tests touched** (names/files) and **Browser verified** (true/false/null)

---

## Distill the lesson

Write one caveman-compact lesson, 1–3 lines. Failure or corrected form:
`[plan/phase] <what failed> — root cause: <X> → fix: <Y>`. Clean-success form:
`[plan/phase] <what worked>: <the approach / key decision>`. Keep it specific and
reusable on the *same* codebase (name the file, the framework quirk, the gotcha) —
not generic advice.

## Home 1 — Obsidian `_MEMORY.md` (durable, human-readable)

**Follow the procedure in `procedures/project-memory.md`** with operation
**RESOLVE**. If a vault folder exists, edit its `_MEMORY.md`: insert the lesson at
the top of the `## Ralph Learnings` section, merge near-duplicates, keep it
compact. If RESOLVE reports no vault, skip this home (the other two still capture).

## Home 2 — `./logs/<plan-name>/learnings.json` (structured)

Append an entry to the `entries` array (create the file if absent). Schema:

```json
{
  "plan": "<plan-name>",
  "generated_at": "<git date: git log -1 --format=%cd --date=short>",
  "entries": [
    {
      "phase": <N>,
      "phase_name": "<name>",
      "outcome": "success" | "failure",
      "iterations": <int>,
      "retries": <int>,
      "root_cause": "<text>" | null,
      "fix": "<text>",
      "tests_touched": ["<name>", "..."],
      "browser_verified": true | false | null,
      "committed_at": "<git sha or date>"
    }
  ]
}
```

This is the machine-readable feed `/ralph-helper:evolve` aggregates across
projects later. Keep it valid JSON.

## Home 3 — Graphify (searchable, feeds `reflect`)

Run `graphify save-result` so the lesson becomes queryable and feeds
`graphify reflect` (see `final-report.md`). Map the outcome:
- terminal success, 0 retries → `--outcome useful`
- terminal success, ≥1 retry (something was corrected) → `--outcome corrected`
- terminal failure (phase abandoned) → `--outcome dead_end`

```
graphify save-result \
  --question "Phase <N> (<phase-name>): <objective in a few words>" \
  --answer  "<the distilled lesson>" \
  --type    query \
  --outcome useful|corrected|dead_end \
  --nodes   "<comma-separated files/nodes the phase touched>"
```

If the `graphify` CLI is unavailable, skip this home (do not block the gate) and
note it — Homes 1 and 2 still captured the lesson.

## Ordering note

On the **success** path this runs inside 6f **before** 6g compaction — the lesson
must be persisted before the context window is compacted away. On the **failure**
path it runs in 6h's "still failing after all retries" block, after the final
rollback, so `root_cause`/`fix` reflect everything that was tried.
