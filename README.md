# gingermarket

A Claude Code plugin marketplace by Edmund Hee.

## Installation

Add this marketplace to Claude Code:

```bash
/plugin marketplace add EdmundHee/gingermarket
```

## Available Plugins

| Plugin | Description | Install |
|---|---|---|
| **ralph-helper** | Plan-aware orchestrator for ralph-loop with automatic phase execution, test gating, and rollback | `/plugin install ralph-helper@gingermarket` |

## Adding Plugins

Each plugin lives in its own subdirectory. To add a new plugin, create a directory with a `.claude-plugin/plugin.json` manifest and add it to `.claude-plugin/marketplace.json`.
