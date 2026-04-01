---
description: View MCP tool usage statistics with 5-hour interval breakdown
---

Show codemap MCP usage statistics to understand how the tools are being utilized.

Steps:
1. Call `codemap_usage` with format "summary" to get the full usage report
2. Highlight the key insights:
   - Which tools are used most and least
   - The 5-hour interval breakdown showing usage patterns over time
   - Any tools with high error rates that may need attention
   - Most frequently queried parameters (shows which parts of the codebase get the most AI attention)
3. If the user specified a focus ($ARGUMENTS), filter or emphasize that aspect:
   - "json" → call `codemap_usage` with format "json" instead
   - A tool name → highlight stats for that specific tool
   - "today" or a date → focus on intervals for that day

Present the data clearly — don't just dump the raw output. Summarize trends and actionable insights.
