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
| [**ralph-helper**](ralph-helper/README.md) | Plan-aware phase runner: splits a plan into tested phases, runs each in a fresh subagent, gates on the test exit code, commits and tags every phase on its own branch, rolls back failed attempts, and learns per project via Obsidian memory + graphify search. | A git repo with a test command; optional `notesDir` setting (an Obsidian folder) and graphify | `/plugin install ralph-helper@gingermarket` |
| [**plan-tracker**](plan-tracker/README.md) | Plan tracker pane: items of every approved plan, Claude marks them done, opus verifies each mark and audits every turn, leftovers of a plan turn are sent back to Claude on their own. | Nothing. Costs one opus call per mark and per turn that touched files ([cost](plan-tracker/README.md#cost)) | `/plugin install plan-tracker@gingermarket` |
| [**git-tracker**](git-tracker/README.md) | Git pane beside plan-tracker: the branch this one was cut from as git's own graph, changed and new files with +/- line counts, and the PR link once one exists. | git; `gh` for the PR row | `/plugin install git-tracker@gingermarket` |
| [**feature-tracker**](feature-tracker/README.md) | Features pane beside plan-tracker: the repo's modules and their features from a hand-editable features.md, an opus review per module (missing features, tech debt, missing handling, test gaps, security) logged as checkbox notes in Obsidian or docs/features/, and a Plan fixes button. | Optional `notesDir` setting (an Obsidian folder) | `/plugin install feature-tracker@gingermarket` |

## What each plugin runs and writes

- **ralph-helper**: markdown commands only. Spawns one subagent per phase, runs your tests, works on a `ralph/<plan>` branch: a commit and tag per passing phase, `git reset --hard` + `git clean -fd` for a failed attempt, `git stash` after the last one. Writes `./logs/<plan>/` (git-excluded) and, with `notesDir` set, vault notes.
- **plan-tracker**: loads `hooks/register.tsx` into Claude Code. Makes opus calls, submits prompts on its own to send leftover items back, keeps its tracker in the plugin store.
- **git-tracker**: loads `hooks/register.tsx`. Runs read-only `git` and `gh` commands after each edit or Bash call. Writes nothing.
- **feature-tracker**: loads `hooks/register.tsx`. Runs `git`, spawns a read-only opus reader, writes `features.md` and review notes to `docs/features/` or `notesDir`. Plan fixes submits a prompt.

## Adding Plugins

Each plugin lives in its own subdirectory. A new plugin touches:

- [ ] `<name>/.claude-plugin/plugin.json`: name, version, description, author, license. The version lives only here.
- [ ] `.claude-plugin/marketplace.json`: name, source, the same description, no version.
- [ ] This README: a table row and a "runs and writes" line.
- [ ] `.gitignore`: a `<name>/.claude-plugin/types/` line if the plugin is a mod.
- [ ] `tests/TEST_CASES.md`: rows for each behaviour, and the plugin in the run line.
- [ ] `claude plugin validate --strict .` passes.
