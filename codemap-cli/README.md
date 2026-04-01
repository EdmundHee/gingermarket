# codemap-cli

A Claude Code plugin that pre-indexes your codebase structure, call graphs, and relationships so Claude Code can answer architecture questions in a single MCP tool call instead of repeatedly scanning files.

## Prerequisites

Install the codemap CLI and MCP server globally:

```bash
npm install -g @gingerdev/codemap-cli
```

Then in your project:

```bash
codemap init      # Create .codemaprc config
codemap generate  # Parse codebase and build the codemap
```

## Commands

| Command | Description |
|---|---|
| `/codemap-cli:explore [area]` | Understand project structure and architecture |
| `/codemap-cli:find-reusable <functionality>` | Find existing code to reuse before writing new |
| `/codemap-cli:impact <function>` | Analyze blast radius before modifying code |
| `/codemap-cli:plan <feature>` | Create implementation plans grounded in actual code structure |
| `/codemap-cli:health-review [area]` | Review code quality and identify refactoring priorities |
| `/codemap-cli:refresh [scope]` | Regenerate codemap when source files have changed |
| `/codemap-cli:usage` | View MCP tool usage statistics |

## MCP Tools

This plugin registers a `codemap` MCP server that exposes:

- `codemap_projects` — List registered projects
- `codemap_overview` — Full project map (modules, classes, functions, frameworks)
- `codemap_module` — Detailed entities in a specific directory
- `codemap_query` — Search by name (exact + fuzzy)
- `codemap_callers` — Find all callers of a function
- `codemap_calls` — Find all functions a function calls
- `codemap_health` — Project health score with trends
- `codemap_structures` — Advanced queries (hotspots, dead code, cohesion)
- `codemap_usage` — Tool usage statistics

## Supported Languages

- TypeScript / JavaScript (via ts-morph)
- Python (via tree-sitter WASM)
- Vue (extracts script blocks, delegates to TS parser)
