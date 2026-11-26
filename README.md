# Antigravity Dashboard CLI (`dash`)

A lightweight, zero-dependency **Google Antigravity CLI (`agy`)** plugin combining:
1. **Minimalist bottom `statusLine`** (stacked cleanly alongside `agy`'s built-in status bar by default, zero progress-bar clutter):
   ```text
   ctx 38% of 512K | cache 94% | 5h 72% (resets 18:30) | 7d 94%
   ```
   Honors `AGY_CLI_AUTO_COMPACT_OVERRIDE` and `settings.json` `"contextWindow"` automatically.
2. **On-demand usage & spend statistics** via `/dash:stats` (0-token local execution) and `/dash:lang` (`en` default, `zh-CN`, `zh-TW`).

[简体中文](README.zh-CN.md)

## Install

Requires **Node.js 20+** and **Antigravity CLI (`agy`)**.

```sh
# 1. Install the minimalist stacked statusLine (backs up existing settings.json)
node bin/cli.mjs install

# 2. Install the native agy plugin for /dash:stats & /dash:lang
agy plugin validate --strict .
agy plugin install .
```

Reopen `agy` (or run `/statusline on`). Use `node bin/cli.mjs uninstall` to restore your prior `statusLine` anytime.

## Usage

### Inside `agy` Console

```text
/dash:stats                      # Last 14 days by date + heatmap + model breakdown + spend
/dash:stats 30                   # Last 30 days
/dash:stats all week             # All history grouped by ISO week
/dash:stats --by month           # Grouped by month
/dash:stats --model neon         # Filter by model substring
/dash:stats --tz utc+8 zh        # Custom timezone & language override

/dash:lang                       # Show current language (default: en)
/dash:lang en | zh | tw | toggle # Switch report language
```

### From Any Terminal

```sh
node bin/cli.mjs stats
node bin/cli.mjs stats --days 30 --by week
node bin/cli.mjs stats --from 2026-11-01 --to 2026-11-26 --tz utc+8
node bin/cli.mjs stats --json
node bin/cli.mjs lang toggle
```

### Uninstall

```sh
agy plugin uninstall dash
```

## Development

```sh
npm test
agy plugin validate --strict .
```

## License

[MIT](LICENSE)
