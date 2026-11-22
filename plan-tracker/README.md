# plan-tracker

A Claude Code mod. Whatever task is running becomes a group of items in a **Plan** pane beside the
transcript: a superpowers plan doc, a plan approved in plan mode, or a task you typed. Claude marks an item with `mark_done`, which
returns at once; when the turn ends sonnet checks every claim against the recent tool calls. The pane shows `○` open,
`⚠` claimed (waiting for the audit, or refused by it, with the reason), `✓` verified. The open items are also listed in Claude's system prompt every
turn, so the plan is never out of sight.

## Install

```
/plugin install plan-tracker --marketplace EdmundHee/gingermarket
```

Answer `y` to add the marketplace, then pick the user scope. Working from a clone instead:
`claude plugin marketplace add <clone folder>` then `claude plugin install plan-tracker@gingermarket`;
the installed copy is read from the folder, so `/reload-plugins` picks up edits.

## Use

- Three sources make a group, toast `tracker: N items from "<title>"`:
  - **superpowers plan doc**: Claude starts `executing-plans` or `subagent-driven-development`. The doc
    is the `.md` path in the skill's args, else the plan doc last written this session, else the newest
    in `docs/superpowers/plans/`. One item per `### Task N:` heading, no model call; a doc without them
    goes to opus.
  - **plan mode**: approving a plan.
  - **typed task**, in any permission mode: the first edit of a repo file in a turn you typed. Opus pulls
    the checklist from your prompt, leaving out what is already tracked; a prompt with nothing new adds no
    group. Edits outside the repo or under `docs/superpowers/` (specs, plan docs, vault notes, memory,
    plan-mode drafts) never count, so questions and planning turns stay untracked. Each typed task gets its
    own group.
- The pane splits groups into sections by source: `PLAN DOCS`, `PLAN MODE`, `TASKS` (empty ones
  hidden), each with its verified/total. A group sits indented under its section: `▸` (or `▾`), its title,
  a progress bar `▰▰▱▱▱▱▱▱▱▱ 2/10` and `x`. Groups start collapsed; `▸` shows the items, `▾` hides them.
- A group from a file shows its path (relative to the project) under the title.
- `▶` on an item sends Claude to work on it (a new turn, with the item and the plan file named).
- `✓` on an item marks it verified by hand, for when the verifier is wrong.
- `Verify all` re-audits every non-verified item in one sonnet call. Never un-verifies.
- `x` on a group removes it. `extract again` re-reads the plan file when extraction failed.
- `Clear done` (beside `Verify all`, shown once a group is fully verified) removes every fully verified group
  after you confirm. Ids keep counting, so an old `#id` never names a new item.
- `/plan-tracker` opens the pane (needed below 144 columns, where an unasked pane waits);
  `/plan-tracker reset` wipes the tracker for this project; ids keep counting, so an old `#id` never
  names a new item. `/clear` keeps the tracker: it reloads from the project store.
- Status line: `plan 2/7`.
- At the end of every turn in which Claude edited a file or ran a command (test-tracker's `run_tests` counts as
  one), the tracker audits the
  open items itself (one sonnet call): it checks each `mark_done` claim, and `✓` marks land even where Claude
  called no `mark_done`. The audit reads Claude's final reply too, not only the tool calls. A reply line
  `✓ #<id> <evidence>` is a claim, the same as a `mark_done`: Claude ends its reply that way for items its last
  tool call finished, instead of spending a round on `mark_done`. A bare `#n` (a PR number) is not a claim. A turn you stop with
  Esc is not audited: its claims stay `⚠` until the next audited turn or `Verify all`.
- When a **plan turn** ends with items unverified, the tracker sends them back on its own. A plan
  turn is the turn a group was added in (any source), a turn started by `▶` or an earlier nudge, or a
  turn in which Claude called `mark_done` or ended its reply with a `✓ #<id>` line. Claude's reply decides what happens:
  - blocked on you (asked a question, needs a decision, hit an error it could not fix, or an item only you
    can do or check) → nothing is sent; the group reads `waiting on you: …`.
  - waiting on a background task (a Codex review, a subagent, a long run) → nothing is sent and no nudge is
    spent; the group reads `waiting on background: …`. The task's finish wakes Claude anyway.
  - otherwise → one `Work on plan items #a #b` prompt is queued, each item with the verifier's reason.
  - two auto-nudges per item, then the row shows `↻2` and the group asks you to press `▶` or `✓`.
  A typed prompt breaks the chain; `▶` re-enters it. `Verify all` never sends anything.
- Every third file edit, command or subagent dispatch while items are open adds one reminder line to the tool result,
  which the model reads and you do not: the open items, and "call mark_done in the same message as your next
  tool call", never as a round of its own. A `mark_done` restarts the count, so marks land as the work does, not
  at the end of the turn.
- **Timing.** Every group keeps its own wall-clock time per phase, shown under its title: one row per phase
  that has time, `●` on the one running, then Total. A fully verified group shows only its total on its one line.
  The phase follows the tool calls:
  - **Plan**: from the first prompt you send in plan mode (it also opens the pane with the keyboard on it),
    and edits of the plan file before approval.
  - **Codex review**: a Bash `codex exec` with `MODE: plan-review`. **Codex verify**: one with `MODE: acceptance`.
  - **Dev**: from the approval, and every repo-file edit; **Review fixes** once a Codex verify has run for that group.
  - **Test**: `claude plugin test|validate`, `npm|pnpm|yarn|bun test`, `pytest`, `vitest`, `jest`, `go|cargo test`,
    `tests/screen/`, `tmux send-keys|capture-pane`, and test-tracker's `run_tests` tool (its call switches as it
    starts, a subagent's too). Other Bash (git, grep) switches nothing.
  - **Not counted**: from the end of each turn until the next one, and while a question or plan-approval dialog
    is up, the clock pauses. A Codex run launched in the background keeps counting as Codex until the turn its
    result starts.
  Before approval the time sits in a `Planning (not approved yet)` block at the top and moves into the group
  on approval. A typed task counts from its prompt, a plan doc from the skill start. The clock follows the
  group Claude marks or works on, and stops when that group's last item is verified or the group is removed.
  `/clear` and a plugin reload keep it running; a new session does not count the time the app was closed.
  Subagents' calls count too. Groups from before 0.4.6 have no time.
- `▶` twice queues once. Pull a queued prompt back with **Up** in an empty composer; its items
  stay `already queued` until `/clear` or a new session.

A second approval adds a new group on top; approving the same plan text again (say, re-shown after
`/compact`) keeps its group and ids. A fully verified group shrinks to one line. There is no
cap on items: a list taller than the pane scrolls (arrows or wheel while the pane is focused).

## Cost

One opus call (60 s timeout) per plan-mode approval and per typed task (on its first repo edit, which waits for
it). One sonnet call (60 s timeout) per `Verify all`, per turn that touched files while items are
open, and per plan turn (even one that only talked); its input is up to ~20K tokens of tool calls. `mark_done` costs no model call. A plan doc with `### Task` headings costs nothing to extract. Nothing on a
read-only typed turn. The mid-turn reminder costs no model call.

## Where things are kept

Per project, in Claude Code's plugin store (`tracker:<cwd>`), so it survives sessions.
The verifier reads tool calls from the session transcript, never files or git on its own. A long output
reaches it as its first 200 and last 600 characters, so a failure at the end of a test run is seen. It reads
the last 120 calls, up to 80,000 characters in all (oldest dropped): about 78 calls at full length, so a long
turn's early edits still reach it.
