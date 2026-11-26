import { displayWidth, paintParts, part, subtle } from './ansi.mjs';
import { compactNumber, formatPercentage, formatUsd } from './i18n.mjs';

const STATS_LABELS = {
  en: {
    title: 'Antigravity CLI Usage & Spend Report',
    overview: 'Overview',
    today: 'Today',
    last7d: 'Last 7d',
    thisMonth: 'This Month',
    allTime: 'All Time',
    selected: 'Selected',
    totalTokens: 'Total Tokens',
    uncachedIn: 'Uncached In',
    cacheRead: 'Cache Read',
    output: 'Output',
    cacheHit: 'Cache Hit',
    requests: 'Requests',
    estCost: 'Est. Cost',
    cacheSaved: 'Cache Saved',
    cliCost: 'CLI Reported Cost',
    heatmapTitle: 'Activity Heatmap (Last 12 Weeks)',
    less: 'Less',
    more: 'More',
    byDay: 'Usage by Date',
    byWeek: 'Usage by Week',
    byMonth: 'Usage by Month',
    byModel: 'Usage by Model',
    periodCol: 'Period',
    modelCol: 'Model',
    reqCol: 'Req',
    inCol: 'Uncached',
    cacheCol: 'Cached',
    outCol: 'Output',
    totalCol: 'Total',
    hitCol: 'Hit%',
    costCol: 'Est.$',
    savedCol: 'Saved$',
    shareCol: 'Share',
    noData: 'No recorded requests in this range yet.',
    footerNote:
      'Note: Est. Cost uses public API reference rates ($/1M tok) and can be customized in pricing.json. Subscription plans (Pro/Enterprise) bill by quota.',
    daysShort: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  },
  'zh-CN': {
    title: 'Antigravity CLI Token 用量与花销统计',
    overview: '总览',
    today: '今日',
    last7d: '近 7 天',
    thisMonth: '本月',
    allTime: '全部累计',
    selected: '当前区间',
    totalTokens: '总 Token',
    uncachedIn: '非缓存输入',
    cacheRead: '缓存读取',
    output: '输出',
    cacheHit: '缓存命中率',
    requests: '请求数',
    estCost: '估算花销',
    cacheSaved: '缓存节省',
    cliCost: 'CLI 实报花销',
    heatmapTitle: '近 12 周活跃热力图',
    less: '低',
    more: '高',
    byDay: '按日期统计',
    byWeek: '按周统计',
    byMonth: '按月统计',
    byModel: '按模型分布',
    periodCol: '日期',
    modelCol: '模型',
    reqCol: '请求',
    inCol: '非缓存输入',
    cacheCol: '缓存读取',
    outCol: '输出',
    totalCol: '总计',
    hitCol: '命中率',
    costCol: '估算花销',
    savedCol: '缓存节省',
    shareCol: '占比',
    noData: '当前筛选区间暂无记录。',
    footerNote:
      '说明：估算花销按公开 API 单价（$/1M tok）折算，可在 dashboard-cli-data/pricing.json 自定义单价；订阅制账号（Pro/Enterprise）实际按配额计费。',
    daysShort: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'],
  },
  'zh-TW': {
    title: 'Antigravity CLI Token 用量與花費統計',
    overview: '總覽',
    today: '今日',
    last7d: '近 7 天',
    thisMonth: '本月',
    allTime: '全部累計',
    selected: '目前區間',
    totalTokens: '總 Token',
    uncachedIn: '非快取輸入',
    cacheRead: '快取讀取',
    output: '輸出',
    cacheHit: '快取命中率',
    requests: '請求數',
    estCost: '估算花費',
    cacheSaved: '快取節省',
    cliCost: 'CLI 實報花費',
    heatmapTitle: '近 12 週活躍熱力圖',
    less: '低',
    more: '高',
    byDay: '依日期統計',
    byWeek: '依週統計',
    byMonth: '依月統計',
    byModel: '依模型分佈',
    periodCol: '日期',
    modelCol: '模型',
    reqCol: '請求',
    inCol: '非快取輸入',
    cacheCol: '快取讀取',
    outCol: '輸出',
    totalCol: '總計',
    hitCol: '命中率',
    costCol: '估算花費',
    savedCol: '快取節省',
    shareCol: '佔比',
    noData: '目前篩選區間暫無記錄。',
    footerNote:
      '說明：估算花費依公開 API 單價（$/1M tok）折算，可在 dashboard-cli-data/pricing.json 自訂單價；訂閱制帳號實際依配額計費。',
    daysShort: ['週一', '週二', '週三', '週四', '週五', '週六', '週日'],
  },
};

function padEndDisplay(text, width) {
  const str = String(text ?? '');
  const diff = width - displayWidth(str);
  return diff > 0 ? str + ' '.repeat(diff) : str;
}

function padStartDisplay(text, width) {
  const str = String(text ?? '');
  const diff = width - displayWidth(str);
  return diff > 0 ? ' '.repeat(diff) + str : str;
}

function fmtMoney(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '--';
  return formatUsd(value) || '$0.00';
}

function renderMiniBar(ratio, maxChars, colorCode) {
  const clamped = Math.max(0, Math.min(1, ratio || 0));
  const filled = clamped > 0 ? Math.max(1, Math.round(clamped * maxChars)) : 0;
  const parts = [];
  if (filled > 0) parts.push(part('█'.repeat(filled), colorCode));
  if (maxChars - filled > 0) parts.push(subtle('░'.repeat(maxChars - filled)));
  return parts;
}

function renderHeatmap(days, l, width, color) {
  const maxVal = days.reduce((m, d) => Math.max(m, d.totalTokens), 0);
  // Align columns Monday (row 0) through Sunday (row 6).
  const firstDow = days[0]?.dayOfWeek ?? 1;
  const monOffset = (firstDow + 6) % 7; // 0 for Mon, 6 for Sun
  const padded = [...Array(monOffset).fill(null), ...days];
  const weeks = Math.ceil(padded.length / 7);
  const grid = Array.from({ length: 7 }, () => []);

  for (let w = 0; w < weeks; w++) {
    for (let r = 0; r < 7; r++) {
      grid[r].push(padded[w * 7 + r] || null);
    }
  }

  const levelCell = cell => {
    if (!cell) return part('  ', 39);
    if (cell.totalTokens <= 0 || maxVal <= 0) return subtle('· ');
    const ratio = cell.totalTokens / maxVal;
    if (ratio < 0.25) return part('░ ', 36);
    if (ratio < 0.5) return part('▒ ', 32);
    if (ratio < 0.75) return part('▓ ', 33);
    return part('█ ', 35, true);
  };

  const lines = [];
  const header = [
    part(l.heatmapTitle, 36, true),
    subtle(`   ${l.less} `),
    subtle('· '),
    part('░ ', 36),
    part('▒ ', 32),
    part('▓ ', 33),
    part('█', 35, true),
    subtle(` ${l.more}`),
  ];
  lines.push(paintParts(header, width, color));

  for (let r = 0; r < 7; r++) {
    // Show Mon / Wed / Fri / Sun labels for clean readability.
    const label = [0, 2, 4, 6].includes(r) ? padEndDisplay(l.daysShort[r], 5) : '     ';
    const rowParts = [subtle(label + ' '), ...grid[r].map(levelCell)];
    lines.push(paintParts(rowParts, width, color));
  }
  return lines;
}

export function renderUsageReport(
  report,
  { language = 'en', width = 110, color = true } = {}
) {
  const l = STATS_LABELS[language] || STATS_LABELS.en;
  const maxWidth = Math.max(60, Math.min(200, width || 110));
  const lines = [];
  const rule = '─'.repeat(Math.min(maxWidth, 96));

  // Header
  const subtitle = [
    `${report.range.from} → ${report.range.to}`,
    report.timezone,
    report.modelFilter ? `model~${report.modelFilter}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  lines.push(paintParts([part(`◆ ${l.title}`, 36, true), subtle(`   (${subtitle})`)], maxWidth, color));
  lines.push(paintParts([subtle(rule)], maxWidth, color));

  // Section 1: Overview Table (compact 76-col grid so it fits cleanly on 80-col terminals)
  lines.push(paintParts([part(l.overview, 36, true)], maxWidth, color));
  const overviewHeader = [
    subtle(padEndDisplay('', 10)),
    subtle(padStartDisplay(l.totalCol, 8)),
    subtle(padStartDisplay(l.cacheCol, 8)),
    subtle(padStartDisplay(l.inCol, 9)),
    subtle(padStartDisplay(l.outCol, 7)),
    subtle(padStartDisplay(l.hitCol, 7)),
    subtle(padStartDisplay(l.reqCol, 5)),
    subtle(padStartDisplay(l.costCol, 9)),
    subtle(padStartDisplay(l.savedCol, 9)),
  ];
  lines.push(paintParts(overviewHeader, maxWidth, color));

  const overviewRows = [
    [l.today, report.overview.today],
    [l.last7d, report.overview.last7Days],
    [l.thisMonth, report.overview.thisMonth],
    [l.allTime, report.overview.allTime],
  ];

  for (const [label, bucket] of overviewRows) {
    const row = [
      part(padEndDisplay(label, 10), 39, true),
      part(padStartDisplay(compactNumber(bucket.totalTokens), 8), 36, true),
      part(padStartDisplay(compactNumber(bucket.cacheReadTokens), 8), 35),
      part(padStartDisplay(compactNumber(bucket.inputTokens), 9), 39),
      part(padStartDisplay(compactNumber(bucket.outputTokens), 7), 39),
      part(padStartDisplay(formatPercentage(bucket.cacheRate), 7), bucket.cacheRate !== null ? 35 : 39, true),
      subtle(padStartDisplay(String(bucket.requests), 5)),
      part(padStartDisplay(fmtMoney(bucket.estimatedUsd), 9), 32, true),
      part(padStartDisplay(fmtMoney(bucket.cacheSavedUsd), 9), 33),
    ];
    lines.push(paintParts(row, maxWidth, color));
  }

  if (report.cliReportedCost && report.cliReportedCost.totalUsd > 0) {
    lines.push(
      paintParts(
        [
          subtle(`${l.cliCost}: `),
          part(fmtMoney(report.cliReportedCost.totalUsd), 32, true),
          subtle(` (${report.cliReportedCost.conversations} conv)`),
        ],
        maxWidth,
        color
      )
    );
  }

  lines.push('');

  // Section 2: Activity Heatmap
  lines.push(...renderHeatmap(report.heatmap || [], l, maxWidth, color));
  lines.push('');

  // Section 3: Breakdown by Date / Week / Month
  const periodTitle =
    report.groupBy === 'month' ? l.byMonth : report.groupBy === 'week' ? l.byWeek : l.byDay;
  lines.push(paintParts([part(periodTitle, 36, true)], maxWidth, color));

  if (!report.periods || report.periods.length === 0) {
    lines.push(paintParts([subtle(l.noData)], maxWidth, color));
  } else {
    const showBar = maxWidth >= 88;
    const maxPeriodTokens = report.periods.reduce((m, p) => Math.max(m, p.totalTokens), 0);
    const pHeader = [
      subtle(padEndDisplay(l.periodCol, 11)),
      subtle(padStartDisplay(l.reqCol, 5)),
      subtle(padStartDisplay(l.totalCol, 8)),
      subtle(padStartDisplay(l.cacheCol, 8)),
      subtle(padStartDisplay(l.inCol, 9)),
      subtle(padStartDisplay(l.outCol, 7)),
      subtle(padStartDisplay(l.hitCol, 7)),
      subtle(padStartDisplay(l.costCol, 9)),
      subtle(padStartDisplay(l.savedCol, 9)),
    ];
    lines.push(paintParts(pHeader, maxWidth, color));

    for (const row of report.periods) {
      const ratio = maxPeriodTokens > 0 ? row.totalTokens / maxPeriodTokens : 0;
      const parts = [
        part(padEndDisplay(row.period, 11), 39, true),
        subtle(padStartDisplay(String(row.requests), 5)),
        part(padStartDisplay(compactNumber(row.totalTokens), 8), 36, true),
        part(padStartDisplay(compactNumber(row.cacheReadTokens), 8), 35),
        part(padStartDisplay(compactNumber(row.inputTokens), 9), 39),
        part(padStartDisplay(compactNumber(row.outputTokens), 7), 39),
        part(padStartDisplay(formatPercentage(row.cacheRate), 7), row.cacheRate !== null ? 35 : 39),
        part(padStartDisplay(fmtMoney(row.estimatedUsd), 9), 32),
        part(padStartDisplay(fmtMoney(row.cacheSavedUsd), 9), 33),
      ];
      if (showBar) {
        parts.push(subtle('  '), ...renderMiniBar(ratio, 10, 36));
      }
      lines.push(paintParts(parts, maxWidth, color));
    }
  }

  lines.push('');

  // Section 4: Breakdown by Model
  lines.push(paintParts([part(l.byModel, 36, true)], maxWidth, color));
  if (!report.models || report.models.length === 0) {
    lines.push(paintParts([subtle(l.noData)], maxWidth, color));
  } else {
    const grandTotal = report.overview.selectedRange.totalTokens || 1;
    const mHeader = [
      subtle(padEndDisplay(l.modelCol, 22)),
      subtle(padStartDisplay(l.reqCol, 5)),
      subtle(padStartDisplay(l.totalCol, 8)),
      subtle(padStartDisplay(l.shareCol, 7)),
      subtle(padStartDisplay(l.cacheCol, 8)),
      subtle(padStartDisplay(l.hitCol, 7)),
      subtle(padStartDisplay(l.costCol, 9)),
      subtle(padStartDisplay(l.savedCol, 9)),
    ];
    lines.push(paintParts(mHeader, maxWidth, color));

    for (const m of report.models) {
      const sharePct = (m.totalTokens / grandTotal) * 100;
      const mParts = [
        part(padEndDisplay(m.model.slice(0, 21), 22), 39, true),
        subtle(padStartDisplay(String(m.requests), 5)),
        part(padStartDisplay(compactNumber(m.totalTokens), 8), 36, true),
        subtle(padStartDisplay(formatPercentage(sharePct), 7)),
        part(padStartDisplay(compactNumber(m.cacheReadTokens), 8), 35),
        part(padStartDisplay(formatPercentage(m.cacheRate), 7), m.cacheRate !== null ? 35 : 39),
        part(padStartDisplay(fmtMoney(m.estimatedUsd), 9), 32, true),
        part(padStartDisplay(fmtMoney(m.cacheSavedUsd), 9), 33),
      ];
      lines.push(paintParts(mParts, maxWidth, color));
    }
  }

  lines.push(paintParts([subtle(rule)], maxWidth, color));
  // Wrap footer note cleanly across lines instead of clipping at terminal width.
  const noteChunks = [];
  let current = '';
  for (const ch of l.footerNote) {
    if (displayWidth(current + ch) > maxWidth) {
      noteChunks.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  if (current) noteChunks.push(current);
  for (const chunk of noteChunks) {
    lines.push(paintParts([subtle(chunk)], maxWidth, color));
  }

  return lines.join('\n');
}

export function renderUsageReportMarkdown(report, { language = 'en' } = {}) {
  const l = STATS_LABELS[language] || STATS_LABELS.en;
  const subtitle = [
    `${report.range.from} → ${report.range.to}`,
    report.timezone,
    report.modelFilter ? `model~${report.modelFilter}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const out = [];
  out.push(`### ${l.title}`);
  out.push(`> ${subtitle}`);
  out.push('');

  // Overview table
  out.push(`#### ${l.overview}`);
  out.push(
    `| | ${l.totalTokens} | ${l.cacheRead} | ${l.uncachedIn} | ${l.output} | ${l.cacheHit} | ${l.requests} | ${l.estCost} | ${l.cacheSaved} |`
  );
  out.push('| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const [label, b] of [
    [l.today, report.overview.today],
    [l.last7d, report.overview.last7Days],
    [l.thisMonth, report.overview.thisMonth],
    [l.allTime, report.overview.allTime],
  ]) {
    out.push(
      `| **${label}** | **${compactNumber(b.totalTokens)}** | ${compactNumber(b.cacheReadTokens)} | ${compactNumber(b.inputTokens)} | ${compactNumber(b.outputTokens)} | ${formatPercentage(b.cacheRate)} | ${b.requests} | **${fmtMoney(b.estimatedUsd)}** | ${fmtMoney(b.cacheSavedUsd)} |`
    );
  }
  if (report.cliReportedCost && report.cliReportedCost.totalUsd > 0) {
    out.push('');
    out.push(
      `> ${l.cliCost}: **${fmtMoney(report.cliReportedCost.totalUsd)}** (${report.cliReportedCost.conversations} conv)`
    );
  }
  out.push('');

  // Heatmap in fenced code block (plain text, no ANSI)
  const heatmapLines = renderHeatmap(report.heatmap || [], l, 100, false);
  out.push(`#### ${l.heatmapTitle}`);
  out.push('```text');
  out.push(...heatmapLines.slice(1));
  out.push(`${l.less}  · ░ ▒ ▓ █  ${l.more}`);
  out.push('```');
  out.push('');

  // By Date / Week / Month table
  const periodTitle =
    report.groupBy === 'month' ? l.byMonth : report.groupBy === 'week' ? l.byWeek : l.byDay;
  out.push(`#### ${periodTitle}`);
  if (!report.periods || report.periods.length === 0) {
    out.push(`_${l.noData}_`);
  } else {
    out.push(
      `| ${l.periodCol} | ${l.reqCol} | ${l.totalCol} | ${l.cacheCol} | ${l.inCol} | ${l.outCol} | ${l.hitCol} | ${l.costCol} | ${l.savedCol} |`
    );
    out.push('| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const row of report.periods) {
      out.push(
        `| ${row.period} | ${row.requests} | **${compactNumber(row.totalTokens)}** | ${compactNumber(row.cacheReadTokens)} | ${compactNumber(row.inputTokens)} | ${compactNumber(row.outputTokens)} | ${formatPercentage(row.cacheRate)} | ${fmtMoney(row.estimatedUsd)} | ${fmtMoney(row.cacheSavedUsd)} |`
      );
    }
  }
  out.push('');

  // By Model table
  out.push(`#### ${l.byModel}`);
  if (!report.models || report.models.length === 0) {
    out.push(`_${l.noData}_`);
  } else {
    const grandTotal = report.overview.selectedRange.totalTokens || 1;
    out.push(
      `| ${l.modelCol} | ${l.reqCol} | ${l.totalCol} | ${l.shareCol} | ${l.cacheCol} | ${l.hitCol} | ${l.costCol} | ${l.savedCol} |`
    );
    out.push('| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const m of report.models) {
      const sharePct = (m.totalTokens / grandTotal) * 100;
      out.push(
        `| \`${m.model}\` | ${m.requests} | **${compactNumber(m.totalTokens)}** | ${formatPercentage(sharePct)} | ${compactNumber(m.cacheReadTokens)} | ${formatPercentage(m.cacheRate)} | **${fmtMoney(m.estimatedUsd)}** | ${fmtMoney(m.cacheSavedUsd)} |`
      );
    }
  }
  out.push('');
  out.push(`<sub>${l.footerNote}</sub>`);

  return out.join('\n');
}
