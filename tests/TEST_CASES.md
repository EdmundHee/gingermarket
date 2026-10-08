# Test cases — gingermarket

screen: n/a
run: `claude plugin test plan-tracker`

| ID | Feature | Type | Precondition | Steps | Expected | Code test | Status |
|----|---------|------|--------------|-------|----------|-----------|--------|
| TC-001 | plan-tracker approval | unit | empty store; haiku answers `["a","b"]` | 1. `$.tool.call ExitPlanMode` answered with `result.plan` | one group, 2 items `open`, store written | plan-tracker/hooks/register.test.ts > approval adds a group with haiku's items | pass |
| TC-002 | plan-tracker rejection | unit | empty store | 1. `$.tool.call ExitPlanMode` answered `isError` | tracker unchanged, no store write | plan-tracker/hooks/register.test.ts > rejected plan adds nothing | pass |
| TC-003 | mark_done verified | unit | one open item #1; haiku says verified | 1. `$.tool.call mark_done {id:1, evidence}` | item `verified`, result text contains "verified" | plan-tracker/hooks/register.test.ts > mark_done verified by haiku | pass |
| TC-004 | mark_done unverified | unit | one open item #1; haiku says unverified | 1. `$.tool.call mark_done {id:1, evidence}` | item `claimed`, note = reason, result text contains reason | plan-tracker/hooks/register.test.ts > mark_done unverified becomes claimed | pass |
| TC-005 | system prompt section | unit | items #1 open, #2 claimed, #3 verified; tools include mark_done | 1. `$.prompt.compose()` | section `plan-tracker:open` lists #1 and #2, omits #3 | plan-tracker/hooks/register.test.ts > compose lists open and claimed items | pass |
| TC-006 | pane work button | unit | one open item #1; mounted on terminal and desktop | 1. press `work:1` | `prompt.submit` text contains `#1` and the item text | plan-tracker/hooks/register.test.ts > pressing work submits a prompt | pass |
| TC-007 | verify all | unit | #1 open, #2 claimed, #3 verified; haiku: #1 verified, #2 unverified | 1. press `verify-all` | #1 `verified`, #2 `claimed`, #3 untouched | plan-tracker/hooks/register.test.ts > verify all applies verdicts without unverifying | pass |
| TC-008 | second approval | unit | group A with #1 open | 1. approve plan B | two groups, B first, #1 still open, ids continue | plan-tracker/hooks/register.test.ts > second approval adds a group on top | pass |
| TC-009 | extraction failure | unit | haiku answers non-JSON | 1. approve plan | group with 0 items and a note; element `extract-again` drawn | plan-tracker/hooks/register.test.ts > failed extraction leaves a retry | pass |
| TC-010 | store load | unit | store holds a tracker under this root | 1. `$.session.start` | state equals store | plan-tracker/hooks/register.test.ts > session start loads the store | pass |

## Rules

- IDs are never reused. Delete a row only when the feature is gone; keep the ID retired.
- One row per behaviour. `Type`: `unit`, `api`, `screen`. No UI pages in this repo, so no screen rows.
- `Code test` is the test name under `claude plugin test <plugin>` so it can be found alone.
- `Status` is the result of the last real run: `pass`, `fail`, `todo`. Never `pass` without the run output.
- A failing row is fixed in the code, not in this table. See `Claude/rules/dev-workflow.md` section 4.
