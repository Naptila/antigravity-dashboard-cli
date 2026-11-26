---
name: stats
description: >-
  Display on-demand Antigravity CLI cumulative token usage, cached token totals,
  estimated API-equivalent spend, cache savings, 12-week activity heatmap, and
  breakdowns by date, week, month, or model.
---

# `/dash:stats` — Antigravity CLI Usage & Spend Statistics

When invoked directly as `/dash:stats` (with optional flags like `/dash:stats 30`, `/dash:stats all week`, `/dash:stats --by month`, `/dash:stats --model neon`), the plugin's `PreInvocation` hook intercepts it instantly at zero token cost and renders the report inline.

If activated via natural language, run the statistics CLI from the plugin root:

```sh
node ./bin/cli.mjs stats
node ./bin/cli.mjs stats --days 30
node ./bin/cli.mjs stats --days all --by week
node ./bin/cli.mjs stats --by month
node ./bin/cli.mjs stats --from 2026-11-01 --to 2026-11-19
```
