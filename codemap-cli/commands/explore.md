---
description: Explore and understand the project structure using codemap
---

Explore and understand this project's codebase structure.

Steps:
1. Call `codemap_overview` to get the full project map — all modules, classes, functions, frameworks, and languages
2. Identify the most important directories based on file count and what the user is interested in
3. For the top 2-3 relevant modules, call `codemap_module` on each to get detailed class/function listings
4. Summarize: project structure, key entry points, main abstractions, and how the modules connect

If the user specified a focus area: $ARGUMENTS
— prioritize modules related to that area and drill deeper into those.

Present results as a concise architectural overview, not a raw data dump.
