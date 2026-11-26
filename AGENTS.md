# AGENTS.md — Antigravity Dashboard CLI (`dash`)

Architecture, operational rules, and developer guide for coding agents working in `antigravity-dashboard-cli`.

## 1. Project Overview

`antigravity-dashboard-cli` (plugin name: `dash`) is a zero-dependency Node.js 20+ ES module plugin and standalone CLI for **Google Antigravity CLI (`agy`)**. It provides two core capabilities:

1. **On-Demand Usage & Spend Analytics (`/dash:stats`, `/dash:lang`, `agy-dashboard`)**: Incrementally indexes local `agy` conversation transcripts into a compact local ledger and renders multi-window token totals, cache hit rates, API-equivalent spend & cache savings, a 12-week activity heatmap, and date/week/month/model breakdowns at zero model-token cost.
2. **Minimalist Bottom `statusLine` (`agy-dashboard-statusline`)**: Reads `agy`'s live `statusLine` JSON payload from `stdin` and renders a calm, single-line context/cache/quota bar that stacks cleanly alongside `agy`'s built-in status bar (`stack_with_default: true`).

---

## 2. Plugin Entrypoints & Registration

| File | Role & Registration Mechanism |
| :--- | :--- |
| `plugin.json` | Native `agy` plugin manifest (`name: "dash"`). Validated via `agy plugin validate .` and installed via `agy plugin install .`. *(Note: root `AGENTS.md` is intentionally kept at repo root for contributors rather than under `rules/`, so installing `dash` adds zero context overhead to end-user sessions.)* |
| `hooks.json` | Registers the `dash-console-commands` hook exclusively on `PreInvocation` (`node ./src/hook-handler.mjs`, 10s timeout). **Never** register `PreToolUse` or high-frequency hooks unless strictly required. |
| `src/hook-handler.mjs` | Reads `PreInvocation` JSON from `stdin` and delegates `lastUserInput` to `src/console-commands.mjs`. Always fails open (`{}`) on errors or non-matching prompts so normal chat is never blocked. |
| `src/console-commands.mjs` | Strictly parses explicit slash commands (`/dash:stats`, `/dash:lang`, `/stats`, `/dstats`, `/lang`, `/dlang`, `/dashboard stats\|lang`). Any free-form or multi-line natural-language input returns `null` (not intercepted). Matched commands execute locally and return `terminationBehavior: "terminate"` with inline output via `injectSteps[].errorMessage.userMessage` (avoiding `systemMessage.metadata.user_markdown`, which triggers a type-mismatch panic in `agy`'s Go unmarshaler). |
| `skills/stats/SKILL.md` | Exposes `/dash:stats` in `agy`'s slash-command picker and provides fallback CLI instructions if invoked via natural language. |
| `skills/lang/SKILL.md` | Exposes `/dash:lang` in `agy`'s slash-command picker for switching between `en`, `zh-CN`, and `zh-TW`. |
| `bin/cli.mjs` | Standalone CLI binary (`agy-dashboard`) implementing `stats` (default), `lang`, `install`, `uninstall`, `status`, `config`, `preview`, and `help`. |
| `bin/statusline.mjs` | Standalone status bar binary (`agy-dashboard-statusline`). Invoked by `agy` with status JSON on `stdin`, or standalone with `--preview` / `--preview-argon`. |
| `src/lifecycle.mjs` | Manages safe installation/uninstallation of the standalone `statusLine` runtime into `~/.gemini/antigravity-cli/antigravity-dashboard-cli` and patches `settings.json` with lockfile, symlink/junction guards, concurrency byte-checks, and automatic backup/restore (`.antigravity-dashboard-cli-install.json`). |

---

## 3. Modular Data Flow: Parsing, Aggregation & Rendering

The codebase separates I/O & parsing, calendar/window aggregation, and UI rendering into decoupled layers:

```text
~/.gemini/antigravity-cli/brain/<convId>/.system_generated/logs/transcript.jsonl
        │
        ▼  Layer 1: Reading, Streaming Parse & Ledger I/O (src/transcript-reader.mjs)
~/.gemini/antigravity-cli/dashboard-cli-data/usage-v1.json
        │
        ▼  Layer 2: Timezone Math, Rolling Date-Window & Cost Aggregation (src/usage-aggregator.mjs + src/pricing.mjs)
Normalized UsageReport DTO (overview, periods, models, heatmap)
        │
        ▼  Layer 3: Pure Presentation & Width-Aware Rendering (src/stats-render.mjs / --json / --markdown)
Terminal ANSI Table + 12-Week Heatmap  |  Markdown Report  |  JSON Output
```

### Layer 1: Token Log Reading & Incremental Ledger (`src/transcript-reader.mjs`)
- **Discovery (`discoverTranscriptFiles`)**: Scans `<brainDir>/<convId>/.system_generated/logs/transcript.jsonl` once per sync and hashes `<convId>` with SHA-256 (`hashKey`, 20 hex chars) so raw conversation IDs are not duplicated across every record.
- **Incremental Cursors**: Tracks `{ byteOffset, size, mtimeMs, lastStepIndex }` per conversation in `ledger.files[convHash]`. Unchanged files (`size` and `mtimeMs` identical) require zero file opens or reads.
- **Chunked Streaming Parser (`scanSingleTranscriptIntoLedger`)**:
  - Streams unread tail bytes in 4 MiB chunks using `Buffer` slicing up to the last `0x0a` (`\n`) so multi-byte UTF-8 sequences split across chunk boundaries are never corrupted.
  - Handles trailing lines without a final `\n`: complete JSON objects at EOF are parsed and committed; incomplete partial writes leave `byteOffset` at the last newline so the next sync re-reads the completed line.
  - Truncated or compacted transcripts (`stat.size < prev.byteOffset`) reset `byteOffset` to `0` while deduplicating against already-recorded `step_index` values for that conversation.
  - Filters for `"PLANNER_RESPONSE"` entries, extracts non-negative integer `input_tokens`, `cache_read_tokens` (and `cache_read_input_tokens` / `cached_tokens`), `cache_creation_tokens` / `cache_write_tokens`, and `output_tokens`, interns `model` names into `ledger.models[]`, and appends compact 8-element tuples:
    `[tsSec, convHash, stepIndex, modelIdx, inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens]`.
  - **Deleted Chat Preservation**: Deleting a conversation folder under `brain/` never removes historical tuples already persisted in `usage-v1.json`.

### Layer 2: Timezone & Rolling-Day Aggregation (`src/usage-aggregator.mjs` & `src/pricing.mjs`)
- **Timezone Resolution**: Supports `'local'` (true OS local calendar dates across DST transitions), `'utc'`/`'gmt'`/`'z'`, fixed offsets (`utc+8`, `utc-05:30`, `+08:00`), and IANA timezone identifiers (`Asia/Shanghai`, `America/New_York`) via cached `Intl.DateTimeFormat`.
- **DST-Safe Calendar Math**: Rolling windows (`today`, `last7Days`, `days`, 84-day `heatmap`) use pure UTC calendar date shifting (`shiftIsoDate`) anchored to the target end date (`to || todayIso`) rather than subtracting `N * 86_400_000` ms from `now`, avoiding skipped or duplicated dates across 23-hour/25-hour DST transitions.
- **Token & Cache Metrics**:
  - `totalTokens = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens`
  - `cacheRate = (cacheReadTokens / (inputTokens + cacheReadTokens + cacheWriteTokens)) * 100` (`null` when denominator is `0`)
- **Pricing (`src/pricing.mjs`)**: Matches models against user overrides in `<dataDir>/pricing.json` first (exact match, then substring), falling back to `DEFAULT_PRICING_RULES`. Computes API-equivalent `estimatedUsd` and `cacheSavedUsd = max(0, cacheReadTokens * (inputRate - cacheReadRate) / 1e6)`.
- **Backwards-Compatible Facade (`src/usage-ledger.mjs`)**: Re-exports Layer 1 and Layer 2 public symbols so existing imports remain strictly non-breaking.

### Layer 3: Dashboard UI & StatusLine Rendering
- **Stats Report (`src/stats-render.mjs`)**: Pure functions (`renderUsageReport` for ANSI/plain text, `renderUsageReportMarkdown` for GFM tables) with zero filesystem I/O. Uses `src/ansi.mjs` grapheme cluster and East Asian Wide/Emoji cell-width calculations (`displayWidth`, `padStartDisplay`, `padEndDisplay`, `truncateDisplay`, `wrapDisplayText`) so English, Simplified Chinese (`zh-CN`), and Traditional Chinese (`zh-TW`) tables align cleanly on 80+ column terminals.
- **Minimalist StatusLine (`src/statusline-core.mjs`)**:
  - Normalizes `agy` status JSON (`normalizeStatusPayload`), resolving effective compaction limits in priority order: host payload threshold → `AGY_CLI_AUTO_COMPACT_OVERRIDE` → `settings.json` `"contextWindow"` → auto heuristic (`512K` for `>=500K` windows, `80%` otherwise).
  - Enforces **strict model-family quota isolation**: `claude`/`gpt` models only display `3p-*` quotas; `gemini` models only display `gemini-*` (or `gemini-argon-wtu-weekly` for Argon), never leaking cross-family buckets.
  - Progressively sheds optional segments (weekly reset → cost → cache → 5h reset → context ceiling) until the rendered line fits within terminal `width`.

---

## 4. Non-Interactive Build, Check & Test Commands

Always run single-pass, non-interactive commands. Never invoke `--watch` modes or block `stdin` without piping input.

```sh
# Run the full Node.js test suite (isolated temp directories only)
npm test

# Syntax-check all CLI entrypoints, source modules, and test files
npm run check

# Validate Antigravity plugin manifest, skills, and hooks
# (Note: root AGENTS.md triggers an expected informational warning that it is not loaded as a runtime rule)
agy plugin validate .

# Safe, read-only / synthetic CLI smoke checks (isolated from live user data)
node bin/cli.mjs preview --no-color
node bin/cli.mjs preview --argon --no-stack --no-color
node bin/statusline.mjs --preview --no-color
```

To test `stats`, `lang`, `config`, or `install` manually from the terminal without touching live `~/.gemini/antigravity-cli` files, **always** pass isolated temporary paths via `--data-dir`, `--brain-dir`, and `--home`.

---

## 5. Coding Conventions & Safety Rules

1. **Workspace & Host Isolation**:
   - Never modify the user's live `~/.gemini/antigravity-cli/settings.json`, installed plugins, `dashboard-cli-data/`, or `brain/` transcripts during development or testing.
   - Every test must allocate an isolated directory via `fs.mkdtempSync(path.join(os.tmpdir(), '...'))` and clean it up in a `finally` block.
2. **Runtime & Dependencies**:
   - Target **Node.js >= 20.0.0** using native ES modules (`.mjs`, `"type": "module"`).
   - Keep **zero external runtime `dependencies`** so the plugin and copied `statusLine` runtime execute instantaneously anywhere Node 20+ is installed.
3. **File & Security Hygiene (`src/store.mjs`, `src/lifecycle.mjs`)**:
   - Use `writeJsonAtomic` (`0o600` temp file + `fsyncSync` + `renameSync`) for all state and config mutations.
   - Preserve symlink/junction checks (`assertNotSymlinkOrJunction`), lockfiles, and concurrent-modification byte checks in `src/lifecycle.mjs`.
   - Bound all `stdin` reads (`MAX_STDIN_BYTES = 512 KiB`) and strip control/ANSI escape sequences from untrusted model/quota labels via `cleanText`.
   - Keep `STATUSLINE_RUNTIME_FILES` in `src/constants.mjs` synchronized if `bin/statusline.mjs` imports any new module.
4. **Type Safety & Error Handling**:
   - Include `// @ts-check` and JSDoc `@typedef` / `@param` / `@returns` annotations on modules and exported functions.
   - Sanitize external JSON inputs (`transcript.jsonl`, `usage-v1.json`, `pricing.json`, `preferences.json`, `stdin` payloads) with safe fallbacks so malformed, empty, or missing files never crash or produce `NaN` metrics.
   - Hooks (`src/hook-handler.mjs`) must fail open (`{}`) on unexpected exceptions; `bin/statusline.mjs` must degrade gracefully (`ctx --`).

---

## 6. Internal Storage, Overrides & Packaging

### Local State & Cache Schemas (`~/.gemini/antigravity-cli/dashboard-cli-data/`)
- **`preferences.json`**: `{ language: "en" | "zh-CN" | "zh-TW", showCache: boolean, showCost: boolean, updatedAt: string }`.
- **`usage-v1.json`**: Schema `1` incremental ledger (`{ schema: 1, updatedAt, models: string[], files: Record<convHash, Cursor>, records: Tuple[] }`).
- **`pricing.json`** *(optional)*: User model pricing overrides (`USD / 1M tokens` for `input`, `cacheRead`, `cacheWrite`, `output`).

### Internal & Isolation Environment Variables
- `AGY_DASHBOARD_DATA_DIR`: Overrides the `dashboard-cli-data` directory path.
- `AGY_BRAIN_DIR`: Overrides the `brain` transcript root directory path.
- `AGY_CLI_HOME`: Overrides the `~/.gemini/antigravity-cli` base directory when `--home` is not explicitly provided.
- `AGY_CLI_AUTO_COMPACT_OVERRIDE`: Compaction ceiling (`512K`, `80%`, `off`) honored by `statusLine`.
- `NO_COLOR`: Disables ANSI color escapes across CLI and `statusLine` outputs.

### Clean Package Allowlist
`package.json` restricts published tarballs via `"files"` to runtime and plugin assets only (`bin/`, `src/`, `skills/`, `assets/`, `plugin.json`, `hooks.json`, `README.md`, `README.zh-CN.md`, `LICENSE`), excluding `tests/`, `scripts/`, `.github/`, `AGENTS.md`, and local caches. Verify anytime with `npm pack --dry-run`.

---

## 7. CI/CD & Release Workflow

Version numbers are locked identically across `package.json`, `plugin.json`, and `src/constants.mjs` (`PLUGIN_VERSION`) via `scripts/release-bump.mjs`:

```sh
# Verify all manifests & constants match (and optionally match a git release tag)
npm run release:check
node scripts/release-bump.mjs --check --tag v0.1.0

# Synchronize a new X.Y.Z release version across package.json, plugin.json & src/constants.mjs
npm run release:bump -- 0.1.1

# Validate plugin manifest, hooks, skills, and assets in pure Node.js
node scripts/release-bump.mjs --validate-plugin
```

### GitHub Actions Pipelines
- **CI (`.github/workflows/ci.yml`)**: Runs on `push` to `main` and `pull_request` across Node.js `20` and `22` (`npm run check`, `node scripts/release-bump.mjs --check`, `npm test`, `npm pack --dry-run`, `node scripts/release-bump.mjs --validate-plugin`, and `agy plugin validate .` when `agy` is available).
- **Release (`.github/workflows/release.yml`)**: Triggered on `v*.*.*` tags with `permissions: contents: write`. Verifies `${GITHUB_REF_NAME}` matches `package.json`, `plugin.json`, and `src/constants.mjs`, runs checks and tests, builds `<name>-<version>.tgz` + `<name>-<version>.tgz.sha256`, and publishes a GitHub Release via `softprops/action-gh-release@v2`.

### Cutting a Release
1. Run `npm run release:bump -- X.Y.Z`.
2. Run `npm run check && npm run release:check && npm test && npm pack --dry-run`.
3. Commit with `git commit -m "chore(release): vX.Y.Z"` and create an annotated tag `git tag -a vX.Y.Z -m "Release vX.Y.Z"`.
4. Push `main` and the `vX.Y.Z` tag to trigger `.github/workflows/release.yml`.
