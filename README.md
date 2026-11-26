# Antigravity Dashboard CLI (`dash`)

English | [简体中文](README.zh-CN.md)

Lightweight, zero-dependency **Google Antigravity CLI (`agy`)** plugin providing:

1. **Minimalist bottom `statusLine`** — stacks cleanly alongside `agy`'s built-in status bar with zero progress-bar clutter:
   ```text
   ctx 38% of 512K | cache 94% | 5h 72% (resets 18:30) | 7d 94% (resets 12/03)
   ```
2. **On-demand usage & spend reports** — view Today / 7d / Month / All-Time token totals, cache hit rates, a 12-week activity heatmap, and date/week/month/model API-equivalent spend (`Est.$`) via `/dash:stats` (0-token local execution), and switch language live for **both `statusLine` and `/dash:stats`** via `/dash:lang` (`en`, `zh-CN`, `zh-TW`).

## Install

Requires **Node.js 20+** and **Antigravity CLI (`agy`)**.

```sh
# 1. Install minimalist stacked statusLine (backs up existing settings.json)
node bin/cli.mjs install

# 2. Install the agy plugin for /dash:stats & /dash:lang
agy plugin install .
```

Reopen `agy` (or run `/statusline on`) to activate.

## Usage

### In `agy` Console

```text
/dash:stats                      # Last 14 days + 12w heatmap + model breakdown + Est.$
/dash:stats 30                   # Last 30 days
/dash:stats all week             # Full history grouped by ISO week
/dash:stats --by month           # Grouped by month
/dash:stats --from 2026-11-01 --to 2026-11-26
/dash:stats --model carbon       # Filter by model substring
/dash:stats --tz utc+8 zh        # Custom timezone & language override

/dash:lang                       # Show active language for statusLine & /dash:stats (default: en)
/dash:lang en | zh | tw | toggle # Switch between English, 简体中文, and 繁體中文
```

### Standalone CLI

```sh
node bin/cli.mjs stats
node bin/cli.mjs stats --days 30 --by week
node bin/cli.mjs stats --from 2026-11-01 --to 2026-11-26 --tz Asia/Shanghai
node bin/cli.mjs stats --markdown
node bin/cli.mjs stats --json
node bin/cli.mjs lang toggle
node bin/cli.mjs preview
node bin/cli.mjs preview --show-cost true
```

## Configuration

### StatusLine Options

- **Display toggles**: `showCache` defaults to `true`; `showCost` defaults to `false`. Enabling `--show-cost true` appends `| $0.18` to `statusLine` **only when `agy` reports a session cost** in its live status payload (omitted on quota-only sessions or narrow terminals):
  ```sh
  node bin/cli.mjs config --show-cost true
  node bin/cli.mjs config --show-cache false
  node bin/cli.mjs install --no-stack   # Replace native bar instead of stacking
  ```
- **Context compaction ceiling**: Automatically respects `AGY_CLI_AUTO_COMPACT_OVERRIDE` (e.g. `512K`, `80%`, `off`) and `"contextWindow"` in `settings.json`.

### `/dash:stats` Custom Model Pricing (`pricing.json`)

`stats` computes `Est.$` and `Saved$` from local token usage (separate from `statusLine` `--show-cost`; unpriced models display `--`). To override or add rates (USD per 1M tokens, matched by exact model ID first, then case-insensitive substring), create `~/.gemini/antigravity-cli/dashboard-cli-data/pricing.json`:

```json
{
  "models": {
    "gemini-4-carbon": {
      "input": 2.0,
      "cacheRead": 0.2,
      "cacheWrite": 2.0,
      "output": 12.0
    }
  }
}
```

## Uninstall

```sh
node bin/cli.mjs uninstall
agy plugin uninstall dash
```

## License

[MIT](LICENSE)
