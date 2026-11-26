# Antigravity Dashboard CLI (`dash`)

[English](README.md) | 简体中文

专为 **Google Antigravity CLI (`agy`)** 打造的轻量零依赖插件，包含两项核心功能：

1. **极简底部 `statusLine`** — 默认与 `agy` 原生底栏叠放共存，无冗余进度条与花哨配色：
   ```text
   ctx 38% of 512K | cache 94% | 5h 72% (resets 18:30) | 7d 94% (resets 12/03)
   ```
2. **按需用量与花销统计** — 通过 `/dash:stats`（0 Token 本地执行）查看今日 / 近 7 天 / 本月 / 累计 Token、缓存命中率、12 周活跃热力图及按日/周/月/模型的 API 等效花销估算（`估算花销`）；通过 `/dash:lang` 实时切换 **`statusLine` 与 `/dash:stats` 的显示语言**（`en`、`zh-CN`、`zh-TW`）。

## 安装

需要 **Node.js 20+** 与 **Antigravity CLI (`agy`)**。

```sh
# 1. 安装极简底部 statusLine（自动备份原 settings.json）
node bin/cli.mjs install

# 2. 安装原生插件以启用 /dash:stats 与 /dash:lang
agy plugin install .
```

重开 `agy`（或执行 `/statusline on`）即可生效。

## 使用方法

### 在 `agy` 控制台内

```text
/dash:stats                      # 默认近 14 天明细 + 12 周热力图 + 按模型分布 + 估算花销
/dash:stats 30                   # 近 30 天
/dash:stats all week             # 全量历史按周汇总
/dash:stats --by month           # 按月汇总
/dash:stats --from 2026-11-01 --to 2026-11-26
/dash:stats --model carbon       # 按模型名筛选
/dash:stats --tz utc+8 zh        # 指定时区与输出语言

/dash:lang                       # 查看当前状态栏与统计语言（默认 en）
/dash:lang en | zh | tw | toggle # 切换英文 / 简体中文 / 繁体中文
```

### 命令行运行

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

## 配置说明

### `statusLine` 底栏选项

- **显示项开关**：`showCache` 默认为 `true`，`showCost` 默认为 `false`。开启 `--show-cost true` 后，**仅当宿主 `agy` 在实时状态数据中上报会话费用时**才会在底栏末尾追加 `| $0.18`（纯配额计费未上报或窄终端下自动省略）：
  ```sh
  node bin/cli.mjs config --show-cost true
  node bin/cli.mjs config --show-cache false
  node bin/cli.mjs install --no-stack   # 替换原生底栏而非叠放
  ```
- **上下文压缩上限**：自动读取环境变量 `AGY_CLI_AUTO_COMPACT_OVERRIDE`（如 `512K`、`80%`、`off`）及 `settings.json` 中的 `"contextWindow"`。

### `/dash:stats` 自定义模型单价（`pricing.json`）

`stats` 报表中的 `估算花销` 与 `缓存节省` 基于本地 Token 用量独立折算（与 `statusLine` 的 `--show-cost` 互不影响；未匹配单价的模型显示 `--`）。如需覆盖或新增单价（USD / 1M tokens，优先精确匹配模型 ID，其次不区分大小写子串匹配），可创建 `~/.gemini/antigravity-cli/dashboard-cli-data/pricing.json`：

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

## 卸载

```sh
node bin/cli.mjs uninstall
agy plugin uninstall dash
```

## 许可证

[MIT](LICENSE)
