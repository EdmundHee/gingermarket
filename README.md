# gingermarket

A Claude Code plugin marketplace by Edmund Hee.

## Installation

Add this marketplace to Claude Code, then install a plugin by name:

```bash
/plugin marketplace add EdmundHee/gingermarket
/plugin install <name>@gingermarket
```

On Claude Code 2.1.275 or later, one step does both: `/plugin install <name> --marketplace EdmundHee/gingermarket`.

- Update: `/plugin marketplace update gingermarket` pulls new versions.
- Remove: `/plugin uninstall <name>@gingermarket`.

## Available Plugins

| Plugin | Description | Needs | Install |
|---|---|---|---|
| [**ralph-helper**](ralph-helper/README.md) | Self-improving, plan-aware orchestrator for ralph-loop. Decomposes a plan into phases, injects unit tests, drives execution with test gating/rollback/regression checks, and learns per project via Obsidian memory + graphify search. | [ralph-loop](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop) installed **and enabled**; graphify optional | `/plugin install ralph-helper@gingermarket` |
| [**plan-tracker**](plan-tracker/README.md) | Plan tracker pane: items of every approved plan, Claude marks them done, opus verifies each mark and audits every turn, leftovers of a plan turn are sent back to Claude on their own. | Nothing. Costs one opus call per mark and per turn that touched files ([cost](plan-tracker/README.md#cost)) | `/plugin install plan-tracker@gingermarket` |
| [**git-tracker**](git-tracker/README.md) | Git pane beside plan-tracker: the branch this one was cut from as git's own graph, changed and new files with +/- line counts, and the PR link once one exists. | git; `gh` for the PR row | `/plugin install git-tracker@gingermarket` |
| [**feature-tracker**](feature-tracker/README.md) | Features pane beside plan-tracker: the repo's modules and their features from a hand-editable features.md, an opus review per module (missing features, tech debt, missing handling, test gaps, security, improvements) logged as checkbox notes in Obsidian or docs/features/, with each finding listed in the pane to pick and plan. | Optional `notesDir` setting (an Obsidian folder) | `/plugin install feature-tracker@gingermarket` |

## What each plugin runs and writes

- **ralph-helper**: markdown commands only. Drives ralph-loop, runs your tests, tags each phase in git and `git reset --hard` on a failed phase, writes `./logs/<plan>/` (PROGRESS.md, state, learnings) and Obsidian vault notes.
- **plan-tracker**: loads `hooks/register.tsx` into Claude Code. Makes opus calls, submits prompts on its own to send leftover items back, keeps its tracker in the plugin store.
- **git-tracker**: loads `hooks/register.tsx`. Runs read-only `git` and `gh` commands after each edit or Bash call. Writes nothing.
- **feature-tracker**: loads `hooks/register.tsx`. Runs `git`, spawns a read-only opus reader, writes `features.md` and review notes to `docs/features/` or `notesDir`. Plan N selected and ▶ submit a prompt.

## Adding Plugins

Each plugin lives in its own subdirectory. A new plugin touches:

- [ ] `<name>/.claude-plugin/plugin.json`: name, version, description, author, license. The version lives only here.
- [ ] `.claude-plugin/marketplace.json`: name, source, the same description, no version.
- [ ] This README: a table row and a "runs and writes" line.
- [ ] `.gitignore`: a `<name>/.claude-plugin/types/` line if the plugin is a mod.
- [ ] `tests/TEST_CASES.md`: rows for each behaviour, and the plugin in the run line.
- [ ] `claude plugin validate --strict .` passes.
