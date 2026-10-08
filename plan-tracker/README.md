# plan-tracker

A Claude Code mod. Every plan you approve in plan mode becomes a group of items in a **Plan** pane
beside the transcript. Claude marks an item with `mark_done`, a small model (haiku) checks the claim
against the recent tool calls, and the pane shows `○` open, `⚠` claimed but unverified (with the
verifier's reason), `✓` verified. The open items are also listed in Claude's system prompt every
turn, so the plan is never out of sight.

## Install

```
/plugin install plan-tracker --marketplace EdmundHee/gingermarket
```

Answer `y` to add the marketplace, then pick the user scope. Working from a clone instead:
`claude plugin marketplace add <clone folder>` then `claude plugin install plan-tracker@gingermarket`;
the installed copy is read from the folder, so `/reload-plugins` picks up edits.

## Use

- Approve a plan → toast `tracker: N items from "<title>"`, items appear in the pane.
- `▶` on an item sends Claude to work on it (a new turn, with the item and the plan file named).
- `✓` on an item marks it verified by hand, for when the verifier is wrong.
- `Verify all` re-audits every non-verified item in one haiku call. Never un-verifies.
- `x` on a group removes it. `extract again` re-reads the plan file when extraction failed.
- `/plan-tracker` opens the pane (needed below 144 columns, where an unasked pane waits);
  `/plan-tracker reset` wipes the tracker for this project.
- Status line: `plan 2/7`.
- At the end of every turn in which Claude edited a file or ran a command, the tracker audits the
  open items itself (one haiku call): `✓` marks land without Claude calling `mark_done`.
- `▶` twice queues once. Pull a queued prompt back with **Up** in an empty composer.

A second approval adds a new group on top; a fully verified group collapses to one line.

## Cost

One haiku call per approval, per `mark_done`, per `Verify all`, and per turn that touched files while
items are open. Nothing on a read-only turn.

## Where things are kept

Per project, in Claude Code's plugin store (`tracker:<cwd>`), so it survives sessions.
The verifier reads tool calls from the session transcript, never files or git on its own.
