export const LABELS = {
  en: {
    context: 'Context',
    shortContext: 'Ctx',
    cache: 'Cache',
    shortCache: 'Hit',
    read: 'read',
    sess: 'sess',
    speed: 'eff',
    tokPerSec: 'tok/s',
    capacity: 'Cap',
    input: 'In',
    output: 'Out',
    created: 'Write',
    left: 'left',
    quota: 'Quota',
    week: 'week',
    disabled: 'Unavailable',
    unknown: 'Unknown',
    idle: 'Ready',
    thinking: 'Thinking',
    working: 'Working',
    running: 'Running',
    tool_use: 'Tool',
    initializing: 'Starting',
    agents: 'Agents',
    agent: 'Agent',
    tasks: 'Tasks',
    modelTime: 'Model',
    toolTime: 'Tool',
    sandbox: 'Sandbox',
    safe: 'safe',
    paceEst: 'est',
    effortLow: 'Low',
    effortMedium: 'Med',
    effortHigh: 'High',
    effortXhigh: 'XHigh',
    effortMax: 'Max',
    effortThinking: 'Thinking',
  },
  'zh-CN': {
    context: '上下文',
    shortContext: '上下文',
    cache: '缓存',
    shortCache: '缓存',
    read: '读取',
    sess: '会话',
    speed: '有效',
    tokPerSec: 'tok/s',
    capacity: '容量',
    input: '输入',
    output: '输出',
    created: '写入',
    left: '剩余',
    quota: '额度',
    week: '周',
    disabled: '不可用',
    unknown: '未知',
    idle: '就绪',
    thinking: '思考中',
    working: '生成中',
    running: '运行中',
    tool_use: '工具中',
    initializing: '启动中',
    agents: '子代理',
    agent: '子代理',
    tasks: '任务',
    modelTime: '模型',
    toolTime: '工具',
    sandbox: '沙箱',
    safe: '充裕',
    paceEst: '预计',
    effortLow: '低',
    effortMedium: '中',
    effortHigh: '高',
    effortXhigh: '极高',
    effortMax: '最大',
    effortThinking: '思考',
  },
  'zh-TW': {
    context: '上下文',
    shortContext: '上下文',
    cache: '快取',
    shortCache: '快取',
    read: '讀取',
    sess: '工作階段',
    speed: '有效',
    tokPerSec: 'tok/s',
    capacity: '容量',
    input: '輸入',
    output: '輸出',
    created: '寫入',
    left: '剩餘',
    quota: '配額',
    week: '週',
    disabled: '無法使用',
    unknown: '未知',
    idle: '就緒',
    thinking: '思考中',
    working: '生成中',
    running: '執行中',
    tool_use: '工具中',
    initializing: '啟動中',
    agents: '子代理',
    agent: '子代理',
    tasks: '任務',
    modelTime: '模型',
    toolTime: '工具',
    sandbox: '沙盒',
    safe: '充裕',
    paceEst: '預計',
    effortLow: '低',
    effortMedium: '中',
    effortHigh: '高',
    effortXhigh: '極高',
    effortMax: '最大',
    effortThinking: '思考',
  },
};

export function getLabels(language) {
  return LABELS[language] || LABELS.en;
}

export function compactNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '--';
  const units = [
    [1e12, 'T', 0, ''],
    [1e9, 'B', 1e12, 'T'],
    [1e6, 'M', 1e9, 'B'],
    [1e3, 'K', 1e6, 'M'],
  ];
  for (const [base, suffix, nextBase, nextSuffix] of units) {
    if (value >= base) {
      const rounded = Number((value / base).toFixed(1));
      if (nextBase && rounded * base >= nextBase) return `1${nextSuffix}`;
      return `${rounded}${suffix}`;
    }
  }
  return String(Math.round(value));
}

export function formatPercentage(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '--';
  return `${Number(value.toFixed(1))}%`;
}

export function formatSpeed(tps) {
  if (typeof tps !== 'number' || !Number.isFinite(tps) || tps <= 0) return '--';
  if (tps >= 100) return `${Math.round(tps)}`;
  return `${Number(tps.toFixed(1))}`;
}

export function formatDurationMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '--';
  const seconds = ms / 1000;
  if (seconds < 10) return `${Number(seconds.toFixed(1))}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return s === 60 ? `${m + 1}m` : `${m}m${s > 0 ? `${s}s` : ''}`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h${m}m`;
}

export function formatSecondsCompact(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return '<1m';
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return h > 0 ? `${d}d${h}h` : `${d}d`;
}

export function formatCountdown(quota, now = Date.now()) {
  const seconds =
    quota.resetTime !== null && Number.isFinite(quota.resetTime)
      ? Math.max(0, (quota.resetTime - now) / 1000)
      : quota.resetInSeconds;
  if (seconds === null || seconds === undefined) return null;
  return formatSecondsCompact(seconds);
}

export function formatUsd(usd) {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) return null;
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  if (usd < 10) return `$${usd.toFixed(2)}`;
  if (usd < 100) return `$${usd.toFixed(1)}`;
  return `$${Math.round(usd)}`;
}
