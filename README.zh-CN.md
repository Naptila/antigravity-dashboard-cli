# Antigravity Dashboard CLI (`dash`)

专为 **Google Antigravity CLI (`agy`)** 打造的零依赖极简插件，包含两项轻量能力：
1. **极简底部 `statusLine`**（默认开启 `stack_with_default: true`，与 `agy` 原生底栏共存、无冗余进度条与花哨配色）：
   ```text
   ctx 38% of 512K | cache 94% | 5h 72% (resets 18:30) | 7d 94%
   ```
   自动读取环境变量 `AGY_CLI_AUTO_COMPACT_OVERRIDE` 与 `settings.json` 中的 `"contextWindow"`。
2. **按需详细统计**：通过 `/dash:stats`（0 Token 本地秒出）查看累计 Token、缓存、12 周热力图与按日/周/月/模型花销估算，通过 `/dash:lang` 实时切换语言（默认英文 `en`）。

[English](README.md)

## 安装

需要 **Node.js 20+** 与 **Antigravity CLI (`agy`)**。

```sh
# 1. 安装极简底部 statusLine（默认与官方原生状态栏叠放，自动备份原配置）
node bin/cli.mjs install

# 2. 安装原生插件以启用 /dash:stats 与 /dash:lang
agy plugin validate --strict .
agy plugin install .
```

重开 `agy`（或执行 `/statusline on`）即可生效；随时可用 `node bin/cli.mjs uninstall` 无损还原。

## 使用方法

### 在 `agy` 控制台内

```text
/dash:stats                      # 默认近 14 天按日期明细 + 12 周热力图 + 按模型分布 + 花销
/dash:stats 30                   # 近 30 天
/dash:stats all week             # 全量历史按周汇总
/dash:stats --by month           # 按月汇总
/dash:stats --model carbon       # 按模型名筛选
/dash:stats --tz utc+8 zh        # 指定时区与中文输出

/dash:lang                       # 查看当前语言（默认 en）
/dash:lang en | zh | tw | toggle # 切换语言
```

### 在终端运行

```sh
node bin/cli.mjs stats
node bin/cli.mjs stats --days 30 --by week
node bin/cli.mjs stats --from 2026-11-01 --to 2026-11-26 --tz utc+8
node bin/cli.mjs stats --json
node bin/cli.mjs lang toggle
```

### 卸载

```sh
agy plugin uninstall dash
```

## 测试与校验

```sh
npm test
agy plugin validate --strict .
```

## 许可证

[MIT](LICENSE)
