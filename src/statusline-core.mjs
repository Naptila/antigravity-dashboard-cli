// @ts-check
import { cleanText, displayWidth, paintParts, part, plainText, subtle } from './ansi.mjs';
import { formatUsd } from './i18n.mjs';
import { parseAutoCompactOverride } from './store.mjs';

/**
 * @typedef {{
 *   id: string,
 *   disabled: boolean,
 *   remaining: number | null,
 *   resetInSeconds: number | null,
 *   resetTime: number | null,
 * }} QuotaBucket
 *
 * @typedef {{
 *   model: string | null,
 *   modelId: string | null,
 *   effort: string | null,
 *   state: string | null,
 *   cycleMode: string | null,
 *   taskCount: number,
 *   subagentCount: number,
 *   width: number,
 *   context: {
 *     usedPercentage: number | null,
 *     rawPercentage: number | null,
 *     usedTokens: number | null,
 *     effectiveLimit: number | null,
 *     capacity: number | null,
 *     basis: string,
 *   },
 *   cachePct: number | null,
 *   costUsd: number | null,
 *   quotas: {
 *     family: string | null,
 *     fiveHour: QuotaBucket | null,
 *     weekly: QuotaBucket | null,
 *     argonWeekly: QuotaBucket | null,
 *   },
 * }} StatusLineMetrics
 */

const BUSY_STATES = new Set(['thinking', 'working', 'running', 'tool_use', 'initializing']);

/** @param {unknown} value */
const asObject = value =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};

/** @param {unknown} value */
const asNonNegNumber = value =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** @param {unknown} value */
const asNonNegInt = value =>
  Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0
    ? /** @type {number} */ (value)
    : null;

const LABELS = {
  en: {
    ctx: 'ctx',
    of: 'of',
    cache: 'cache',
    resets: 'resets',
    modeOn: (/** @type {string} */ mode) => `${mode} mode on`,
    task: (/** @type {number} */ n) => (n === 1 ? '1 task' : `${n} tasks`),
    agent: (/** @type {number} */ n) => (n === 1 ? '1 agent' : `${n} agents`),
  },
  'zh-CN': {
    ctx: '上下文',
    of: '/',
    cache: '缓存',
    resets: '重置',
    modeOn: (/** @type {string} */ mode) => `${mode} 模式`,
    task: (/** @type {number} */ n) => `${n} 任务`,
    agent: (/** @type {number} */ n) => `${n} 子代理`,
  },
  'zh-TW': {
    ctx: '上下文',
    of: '/',
    cache: '快取',
    resets: '重設',
    modeOn: (/** @type {string} */ mode) => `${mode} 模式`,
    task: (/** @type {number} */ n) => `${n} 任務`,
    agent: (/** @type {number} */ n) => `${n} 子代理`,
  },
};

/**
 * Formats a context ceiling in thousands (`512K`, `1000K`).
 * @param {unknown} tokens
 * @returns {string | null}
 */
export function formatLimitK(tokens) {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return null;
  if (tokens >= 1000) {
    const k = Math.round(tokens / 1000);
    return `${k}K`;
  }
  return String(Math.round(tokens));
}

/**
 * Formats a quota reset timestamp into a local wall-clock time (`18:30` or `12/03`).
 * @param {QuotaBucket | null | undefined} quota
 * @param {number} [now=Date.now()]
 * @param {number | null} [tzOffsetMinutes=null]
 * @param {{ dateOnlyIfFar?: boolean }} [opts]
 * @returns {string | null}
 */
export function formatClockReset(
  quota,
  now = Date.now(),
  tzOffsetMinutes = null,
  { dateOnlyIfFar = false } = {}
) {
  if (!quota || quota.disabled) return null;
  let targetMs = quota.resetTime;
  if (targetMs === null || !Number.isFinite(targetMs)) {
    if (quota.resetInSeconds !== null && Number.isFinite(quota.resetInSeconds)) {
      targetMs = now + quota.resetInSeconds * 1000;
    } else {
      return null;
    }
  }
  const offset = tzOffsetMinutes !== null ? tzOffsetMinutes : -new Date(targetMs).getTimezoneOffset();
  const shiftedTarget = new Date(targetMs + offset * 60_000);
  const hh = String(shiftedTarget.getUTCHours()).padStart(2, '0');
  const mm = String(shiftedTarget.getUTCMinutes()).padStart(2, '0');
  const diffSec = (targetMs - now) / 1000;
  if (diffSec > 86_400) {
    const mon = String(shiftedTarget.getUTCMonth() + 1).padStart(2, '0');
    const day = String(shiftedTarget.getUTCDate()).padStart(2, '0');
    return dateOnlyIfFar ? `${mon}/${day}` : `${mon}/${day} ${hh}:${mm}`;
  }
  return `${hh}:${mm}`;
}

/**
 * Selects quota buckets strictly matching the active model's billing family.
 * @param {unknown} rawQuotaMap
 * @param {string | null} modelId
 * @param {string | null} modelName
 */
function selectActiveQuotas(rawQuotaMap, modelId, modelName) {
  const entries = Object.entries(asObject(rawQuotaMap));
  if (entries.length === 0) return { family: null, fiveHour: null, weekly: null, argonWeekly: null };

  /**
   * @param {string} key
   * @param {unknown} raw
   * @returns {QuotaBucket}
   */
  const parseBucket = (key, raw) => {
    const value = asObject(raw);
    const fraction = asNonNegNumber(value.remaining_fraction);
    const resetMs = typeof value.reset_time === 'string' ? Date.parse(value.reset_time) : NaN;
    return {
      id: cleanText(key, 64),
      disabled: value.disabled === true,
      remaining: value.disabled !== true && fraction !== null && fraction <= 1 ? fraction * 100 : null,
      resetInSeconds: asNonNegNumber(value.reset_in_seconds),
      resetTime: Number.isFinite(resetMs) ? resetMs : null,
    };
  };

  const map = new Map(entries.map(([k, v]) => [k, parseBucket(k, v)]));
  const idLower = String(modelId || '').toLowerCase();
  const nameLower = String(modelName || '').toLowerCase();
  const identity = `${idLower} ${nameLower}`;

  const isClaude = /\bclaude\b/.test(identity);
  const isGpt = /\b(?:gpt|o[134](?:-|$))/.test(identity);
  const is3p = isClaude || isGpt;
  const isArgon = /(?:^|[^a-z])argon(?:$|[^a-z])/.test(identity);
  const isGemini = /\bgemini\b|\borchestrator\b/.test(identity) || isArgon;

  // Strict family isolation: Claude/GPT models NEVER show Gemini quotas, and vice versa.
  if (is3p) {
    return {
      family: isClaude ? 'claude' : 'gpt',
      fiveHour: map.get('3p-5h') || null,
      weekly: map.get('3p-weekly') || null,
      argonWeekly: null,
    };
  }

  if (isGemini) {
    if (isArgon && map.has('gemini-argon-wtu-weekly')) {
      return {
        family: 'argon',
        fiveHour: map.get('gemini-5h') || null,
        weekly: null,
        argonWeekly: map.get('gemini-argon-wtu-weekly') || null,
      };
    }
    return {
      family: 'gemini',
      fiveHour: map.get('gemini-5h') || null,
      weekly: map.get('gemini-weekly') || null,
      argonWeekly: null,
    };
  }

  // Unknown/unidentified model fallback
  if (map.has('gemini-5h') || map.has('gemini-weekly')) {
    return {
      family: 'gemini',
      fiveHour: map.get('gemini-5h') || null,
      weekly: map.get('gemini-weekly') || null,
      argonWeekly: null,
    };
  }
  if (map.has('3p-5h') || map.has('3p-weekly')) {
    return {
      family: '3p',
      fiveHour: map.get('3p-5h') || null,
      weekly: map.get('3p-weekly') || null,
      argonWeekly: null,
    };
  }

  const all = [...map.values()];
  return {
    family: null,
    fiveHour: all.find(q => /5h/i.test(q.id)) || null,
    weekly: all.find(q => /week|7d/i.test(q.id)) || null,
    argonWeekly: null,
  };
}

/**
 * Normalizes a raw `agy` statusLine JSON payload into validated `StatusLineMetrics`.
 * @param {unknown} payload
 * @param {{ autoCompactOverride?: unknown, configuredContextWindow?: number | null }} [opts]
 * @returns {StatusLineMetrics}
 */
export function normalizeStatusPayload(
  payload,
  { autoCompactOverride = null, configuredContextWindow = null } = {}
) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid statusLine payload');
  }
  const root = /** @type {Record<string, any>} */ (payload);

  const context = asObject(root.context_window);
  const usage = asObject(context.current_usage);
  const model = asObject(root.model);
  const cost = asObject(root.cost);

  const capacity = asNonNegInt(context.context_window_size) || null;
  const rawUsedPct = asNonNegNumber(context.used_percentage);
  const rawRemainingPct = asNonNegNumber(context.remaining_percentage);
  const rawPct =
    rawUsedPct ?? (rawRemainingPct !== null && rawRemainingPct <= 100 ? 100 - rawRemainingPct : null);

  const input = asNonNegInt(usage.input_tokens);
  const cacheRead = asNonNegInt(usage.cache_read_input_tokens);
  const cacheWrite = asNonNegInt(usage.cache_creation_input_tokens) ?? 0;

  let usedTokens = null;
  if (input !== null && cacheRead !== null && input + cacheRead + cacheWrite > 0) {
    usedTokens = input + cacheRead + cacheWrite;
  } else if (rawPct !== null && capacity) {
    usedTokens = Math.round((rawPct / 100) * capacity);
  }

  const hostCompactionLimit =
    asNonNegInt(context.compaction_threshold) ||
    asNonNegInt(context.auto_compact_threshold) ||
    asNonNegInt(context.checkpoint_threshold) ||
    asNonNegInt(context.effective_context_window_size) ||
    asNonNegInt(context.max_tokens_before_compaction) ||
    null;

  const parsedEnvOverride = parseAutoCompactOverride(autoCompactOverride, capacity);
  let effectiveLimit = capacity;
  let basis = 'raw';

  if (hostCompactionLimit) {
    effectiveLimit = hostCompactionLimit;
    basis = 'compact-host';
  } else if (parsedEnvOverride?.disabled) {
    effectiveLimit = capacity;
    basis = 'raw';
  } else if (parsedEnvOverride?.tokens) {
    effectiveLimit = capacity ? Math.min(parsedEnvOverride.tokens, capacity) : parsedEnvOverride.tokens;
    basis = 'compact-env';
  } else if (Number.isSafeInteger(configuredContextWindow) && /** @type {number} */ (configuredContextWindow) >= 1000) {
    effectiveLimit = capacity
      ? Math.min(/** @type {number} */ (configuredContextWindow), capacity)
      : /** @type {number} */ (configuredContextWindow);
    basis = 'compact-settings';
  } else if (capacity) {
    let heuristic = capacity >= 500_000 ? 512_000 : Math.round(capacity * 0.8);
    if (usedTokens !== null && usedTokens > heuristic) heuristic = capacity;
    effectiveLimit = heuristic;
    basis = heuristic === capacity ? 'raw' : 'compact-auto';
  }

  let usedPercentage = rawPct;
  if (usedTokens !== null && effectiveLimit && effectiveLimit > 0) {
    usedPercentage = Math.min(100, (usedTokens / effectiveLimit) * 100);
  }

  const state = typeof root.agent_state === 'string' ? cleanText(root.agent_state, 24) : null;
  let cachePct = null;
  if (input !== null && cacheRead !== null) {
    const denom = input + cacheRead + cacheWrite;
    if (denom > 0 && !(cacheRead === 0 && state !== null && BUSY_STATES.has(state))) {
      cachePct = (cacheRead / denom) * 100;
    }
  }

  const modelId = cleanText(model.id || '', 80) || null;
  const modelName = cleanText(model.display_name || model.id || '', 80) || null;
  const effort = cleanText(model.effort || '', 24).toLowerCase() || null;

  const subagents = Array.isArray(root.subagents) ? root.subagents : [];
  const activeSubagents = subagents.filter(item => {
    const st = String(item?.state || item?.status || '').toLowerCase();
    return !['idle', 'done', 'completed', 'stopped', 'failed', 'error'].includes(st);
  }).length;

  return {
    model: modelName,
    modelId,
    effort,
    state,
    cycleMode: cleanText(root.cycle_mode || '', 24) || null,
    taskCount: asNonNegInt(root.task_count) ?? 0,
    subagentCount: activeSubagents || subagents.length,
    width:
      Number.isInteger(root.terminal_width) && root.terminal_width > 0
        ? Math.min(500, root.terminal_width)
        : 100,
    context: {
      usedPercentage,
      rawPercentage: rawPct,
      usedTokens,
      effectiveLimit,
      capacity,
      basis,
    },
    cachePct,
    costUsd: asNonNegNumber(cost.total_usd),
    quotas: selectActiveQuotas(root.quota, modelId, modelName),
  };
}

/** @param {unknown} value */
function pctInt(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '--';
  return `${Math.round(value)}%`;
}

/** @param {number | null} remaining */
function quotaColor(remaining) {
  if (remaining === null || !Number.isFinite(remaining)) return 39;
  if (remaining < 15) return 31;
  if (remaining < 30) return 33;
  return 39;
}

/** @param {number | null} usedPct */
function ctxColor(usedPct) {
  if (usedPct === null || !Number.isFinite(usedPct)) return 39;
  if (usedPct >= 90) return 31;
  if (usedPct >= 60) return 33;
  return 39;
}

/**
 * Renders the minimalist statusLine:
 *   `ctx 38% of 512K | cache 94% | 5h 72% (resets 18:30) | 7d 94% (resets 12/03)`
 *
 * Keeps default text calm & muted; applies surgical color accents only on warnings/modes.
 *
 * @param {StatusLineMetrics} metrics
 * @param {{
 *   language?: string,
 *   width?: number,
 *   color?: boolean,
 *   stacked?: boolean,
 *   showCache?: boolean,
 *   showCost?: boolean,
 *   now?: number,
 *   tzOffsetMinutes?: number | null,
 * }} [opts]
 * @returns {string}
 */
export function renderMinimalStatusLine(
  metrics,
  {
    language = 'en',
    width = metrics.width,
    color = true,
    stacked = true,
    showCache = true,
    showCost = false,
    now = Date.now(),
    tzOffsetMinutes = null,
  } = {}
) {
  const l = LABELS[/** @type {keyof typeof LABELS} */ (language)] || LABELS.en;
  const maxWidth = Math.max(20, Math.min(500, width || 100));
  const isZh = language === 'zh-CN' || language === 'zh-TW';

  /**
   * @param {{
   *   includeReset: boolean,
   *   includeWeeklyReset: boolean,
   *   includeCache: boolean,
   *   includeCost: boolean,
   *   includeLimit: boolean,
   * }} cfg
   */
  const buildRow1 = ({ includeReset, includeWeeklyReset, includeCache, includeCost, includeLimit }) => {
    const segments = [];

    // 1. Context segment: "ctx 38% of 512K"
    const used = metrics.context.usedPercentage;
    const limitLabel = formatLimitK(metrics.context.effectiveLimit);
    const cCode = ctxColor(used);
    const ctxSeg = [
      subtle(`${l.ctx} `),
      cCode === 39 ? subtle(pctInt(used)) : part(pctInt(used), cCode, cCode === 31),
    ];
    if (includeLimit && limitLabel) {
      ctxSeg.push(subtle(isZh ? `/${limitLabel}` : ` ${l.of} ${limitLabel}`));
    }
    segments.push(ctxSeg);

    // 2. Cache hit segment (compact, optional): "cache 94%"
    if (includeCache && metrics.cachePct !== null) {
      segments.push([subtle(`${l.cache} ${pctInt(metrics.cachePct)}`)]);
    }

    // 3. Active model's 5h quota: "5h 72% (resets 18:30)"
    const q5 = metrics.quotas.fiveHour;
    if (q5 && !q5.disabled && q5.remaining !== null) {
      const qCode = quotaColor(q5.remaining);
      const seg = [
        subtle('5h '),
        qCode === 39 ? subtle(pctInt(q5.remaining)) : part(pctInt(q5.remaining), qCode, qCode === 31),
      ];
      if (includeReset) {
        const clock = formatClockReset(q5, now, tzOffsetMinutes);
        if (clock) {
          seg.push(subtle(isZh ? ` (${clock} ${l.resets})` : ` (${l.resets} ${clock})`));
        }
      }
      segments.push(seg);
    }

    // 4. Active model's 7d quota (or Argon 7d when active): "7d 94% (resets 12/03)"
    const q7 = metrics.quotas.argonWeekly || metrics.quotas.weekly;
    if (q7 && !q7.disabled && q7.remaining !== null) {
      const wCode = quotaColor(q7.remaining);
      const seg = [
        subtle('7d '),
        wCode === 39 ? subtle(pctInt(q7.remaining)) : part(pctInt(q7.remaining), wCode, wCode === 31),
      ];
      if (includeWeeklyReset) {
        const clock = formatClockReset(q7, now, tzOffsetMinutes, { dateOnlyIfFar: true });
        if (clock) {
          seg.push(subtle(isZh ? ` (${clock} ${l.resets})` : ` (${l.resets} ${clock})`));
        }
      }
      segments.push(seg);
    }

    // 5. Optional session cost: "$0.18"
    if (includeCost && metrics.costUsd !== null) {
      const usd = formatUsd(metrics.costUsd);
      if (usd) segments.push([subtle(usd)]);
    }

    const row = [];
    for (let i = 0; i < segments.length; i++) {
      if (i > 0) row.push(subtle(' | '));
      row.push(...segments[i]);
    }
    return row;
  };

  const attempts = [
    { includeReset: true, includeWeeklyReset: true, includeCache: showCache, includeCost: showCost, includeLimit: true },
    { includeReset: true, includeWeeklyReset: false, includeCache: showCache, includeCost: showCost, includeLimit: true },
    { includeReset: true, includeWeeklyReset: false, includeCache: showCache, includeCost: false, includeLimit: true },
    { includeReset: true, includeWeeklyReset: false, includeCache: false, includeCost: false, includeLimit: true },
    { includeReset: false, includeWeeklyReset: false, includeCache: false, includeCost: false, includeLimit: true },
    { includeReset: false, includeWeeklyReset: false, includeCache: false, includeCost: false, includeLimit: false },
  ];

  let chosenRow1 = buildRow1(attempts[attempts.length - 1]);
  for (const cfg of attempts) {
    const candidate = buildRow1(cfg);
    if (displayWidth(plainText(candidate)) <= maxWidth) {
      chosenRow1 = candidate;
      break;
    }
  }

  const lines = [paintParts(chosenRow1, maxWidth, color)];

  // Only render the subtle mode/tasks/agents line when NOT stacked with agy's built-in status bar.
  if (!stacked) {
    const meta = [];
    if (metrics.cycleMode && metrics.cycleMode !== 'default') {
      meta.push([part(`▸▸ ${l.modeOn(metrics.cycleMode)}`, 33, true)]);
    }
    if (metrics.model) {
      meta.push([subtle(metrics.model)]);
    }
    if (metrics.taskCount > 0) {
      meta.push([part(l.task(metrics.taskCount), 36)]);
    }
    if (metrics.subagentCount > 0) {
      meta.push([subtle(`← ${l.agent(metrics.subagentCount)}`)]);
    }
    if (meta.length > 0) {
      const row2 = [];
      for (let i = 0; i < meta.length; i++) {
        if (i > 0) row2.push(subtle(' · '));
        row2.push(...meta[i]);
      }
      lines.push(paintParts(row2, maxWidth, color));
    }
  }

  return lines.join('\n');
}
