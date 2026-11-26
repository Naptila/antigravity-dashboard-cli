# Antigravity Dashboard CLI (`dash`)

[English](README.md) | 简体中文

专为 **Google Antigravity CLI (`agy`)** 打造的轻量零依赖插件，包含两项核心功能：

1. **极简底部 `statusLine`** — 默认与 `agy` 原生底栏叠放共存，无冗余进度条与花哨配色：
   ```text
   ctx 38% of 512K | cache 94% | 5h 72% (resets 18:30) | 7d 94% (resets 12/03)
   ```
2. **按需用量与花销统计** — 通过 `/dash:stats`（0 Token 本地执行）查看今日 / 近 7 天 / 本月 / 累计 Token、缓存命中率、12 周活跃热力图及按日/周/月/模型花销估算；通过 `/dash:lang` 实时切换 `en`、`zh-CN`、`zh-TW`。

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
/dash:stats                      # 默认近 14 天明细 + 12 周热力图 + 按模型分布 + 花销
/dash:stats 30                   # 近 30 天
/dash:stats all week             # 全量历史按周汇总
/dash:stats --by month           # 按月汇总
/dash:stats --from 2026-11-01 --to 2026-11-26
/dash:stats --model carbon       # 按模型名筛选
/dash:stats --tz utc+8 zh        # 指定时区与输出语言

/dash:lang                       # 查看当前语言（默认 en）
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
```

## 配置说明

- **底栏显示项开关**：
  ```sh
  node bin/cli.mjs config --show-cache true --show-cost true
  node bin/cli.mjs install --no-stack   # 替换原生底栏而非叠放
  ```
- **上下文压缩上限**：自动读取环境变量 `AGY_CLI_AUTO_COMPACT_OVERRIDE`（如 `512K`、`80%`、`off`）及 `settings.json` 中的 `"contextWindow"`。
- **自定义模型单价**（可选）：在 `~/.gemini/antigravity-cli/dashboard-cli-data/pricing.json` 中按每百万 Token（USD / 1M tokens）配置：
  ```json
  {
    "models": {
      "gemini-4-carbon": { "input": 2.0, "cacheRead": 0.2, "output": 12.0 }
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
