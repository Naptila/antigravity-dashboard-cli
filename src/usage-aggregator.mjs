// @ts-check
import { estimateTokenCost, loadCustomPricing } from './pricing.mjs';
import { sanitizeUsageLedger, toNonNegSafeInt } from './transcript-reader.mjs';

/**
 * @typedef {{
 *   year: number,
 *   month: number,
 *   day: number,
 *   dayOfWeek: number,
 *   isoDate: string,
 *   isoMonth: string,
 * }} CalendarDateParts
 *
 * @typedef {{
 *   mode: 'local' | 'offset' | 'iana',
 *   label: string,
 *   offsetMinutes: number,
 *   timeZone: string | null,
 * }} TimezoneSpec
 *
 * @typedef {{
 *   requests: number,
 *   conversations: number,
 *   inputTokens: number,
 *   cacheReadTokens: number,
 *   cacheWriteTokens: number,
 *   outputTokens: number,
 *   totalTokens: number,
 *   cacheRate: number | null,
 *   estimatedUsd: number,
 *   cacheSavedUsd: number,
 *   pricedRequests: number,
 * }} AggregatedBucket
 *
 * @typedef {{
 *   generatedAt: string,
 *   timezone: string,
 *   groupBy: 'day' | 'week' | 'month',
 *   range: { from: string, to: string },
 *   modelFilter: string | null,
 *   overview: {
 *     today: AggregatedBucket,
 *     last7Days: AggregatedBucket,
 *     thisMonth: AggregatedBucket,
 *     allTime: AggregatedBucket,
 *     selectedRange: AggregatedBucket,
 *   },
 *   cliReportedCost: { totalUsd: number, conversations: number },
 *   periods: Array<AggregatedBucket & { period: string }>,
 *   models: Array<AggregatedBucket & { model: string }>,
 *   heatmap: Array<{ date: string, dayOfWeek: number, totalTokens: number }>,
 * }} UsageReport
 */

/** @type {Map<string, Intl.DateTimeFormat>} */
const ianaFormatterCache = new Map();

/**
 * Returns a cached `Intl.DateTimeFormat` for an IANA timezone, or throws on invalid identifiers.
 * @param {string} timeZone
 * @returns {Intl.DateTimeFormat}
 */
function getIanaFormatter(timeZone) {
  let fmt = ianaFormatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    ianaFormatterCache.set(timeZone, fmt);
  }
  return fmt;
}

/**
 * Formats a fixed UTC offset in minutes into `UTC`, `UTC+8`, `UTC-5:30`, etc.
 * @param {number} offsetMinutes
 * @returns {string}
 */
export function formatOffsetLabel(offsetMinutes) {
  if (!Number.isFinite(offsetMinutes) || offsetMinutes === 0) return 'UTC';
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(Math.trunc(offsetMinutes));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m > 0 ? `UTC${sign}${h}:${String(m).padStart(2, '0')}` : `UTC${sign}${h}`;
}

/**
 * Computes the instant UTC offset in minutes for an IANA timezone at `tsMs`.
 * @param {string} timeZone
 * @param {number} tsMs
 * @returns {number}
 */
function ianaOffsetMinutesAt(timeZone, tsMs) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  /** @type {Record<string, number>} */
  const map = {};
  for (const p of dtf.formatToParts(new Date(tsMs))) {
    if (p.type !== 'literal') map[p.type] = Number(p.value);
  }
  const asUtc = Date.UTC(map.year, map.month - 1, map.day, map.hour, map.minute, map.second);
  const truncatedTs = Math.floor(tsMs / 1000) * 1000;
  return Math.round((asUtc - truncatedTs) / 60_000);
}

/**
 * Resolves a timezone string (`'local'`, `'utc'`, `'utc+8'`, `'utc-05:30'`, or IANA `'Asia/Shanghai'`)
 * into a structured `TimezoneSpec`.
 * @param {string} [tz='local']
 * @param {number} [now=Date.now()]
 * @returns {TimezoneSpec}
 */
export function resolveTimezoneSpec(tz = 'local', now = Date.now()) {
  if (!tz || String(tz).trim().toLowerCase() === 'local') {
    const offsetMinutes = -new Date(now).getTimezoneOffset();
    return {
      mode: 'local',
      label: formatOffsetLabel(offsetMinutes),
      offsetMinutes,
      timeZone: null,
    };
  }

  const trimmed = String(tz).trim();
  const lower = trimmed.toLowerCase();
  if (lower === 'utc' || lower === 'z' || lower === 'gmt') {
    return { mode: 'offset', label: 'UTC', offsetMinutes: 0, timeZone: null };
  }

  const match = lower.match(/^(?:utc|gmt)?([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (match) {
    const sign = match[1] === '-' ? -1 : 1;
    const hours = Number(match[2]);
    const mins = Number(match[3] || 0);
    if (hours > 14 || mins >= 60 || (hours === 14 && mins > 0)) {
      throw new Error(`Invalid timezone offset: ${tz}`);
    }
    const offsetMinutes = sign * (hours * 60 + mins);
    return {
      mode: 'offset',
      label: formatOffsetLabel(offsetMinutes),
      offsetMinutes,
      timeZone: null,
    };
  }

  // Try IANA timezone (e.g. "Asia/Shanghai", "America/New_York").
  if (/^[A-Za-z_][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+$/.test(trimmed)) {
    try {
      const fmt = getIanaFormatter(trimmed);
      // Canonicalize capitalization if available via resolvedOptions
      const canonical = fmt.resolvedOptions().timeZone || trimmed;
      const offsetMinutes = ianaOffsetMinutesAt(canonical, now);
      return {
        mode: 'iana',
        label: canonical,
        offsetMinutes,
        timeZone: canonical,
      };
    } catch {
      // fall through to descriptive error below
    }
  }

  throw new Error(
    `Invalid timezone "${tz}". Use local, utc, utc+8 / utc-5, or an IANA zone (e.g. Asia/Shanghai).`
  );
}

/**
 * Resolves a timezone string into its UTC offset in minutes at `now`.
 * @param {string} [tz='local']
 * @param {number} [now=Date.now()]
 * @returns {number}
 */
export function resolveTimezoneOffsetMinutes(tz = 'local', now = Date.now()) {
  return resolveTimezoneSpec(tz, now).offsetMinutes;
}

/**
 * Builds `CalendarDateParts` from verified UTC calendar year, month (1..12), and day (1..31).
 * @param {number} year
 * @param {number} month
 * @param {number} day
 * @returns {CalendarDateParts}
 */
function buildCalendarParts(year, month, day) {
  const utc = new Date(Date.UTC(year, month - 1, day));
  const y = utc.getUTCFullYear();
  const m = utc.getUTCMonth() + 1;
  const d = utc.getUTCDate();
  const dayOfWeek = utc.getUTCDay(); // 0=Sun .. 6=Sat
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return {
    year: y,
    month: m,
    day: d,
    dayOfWeek,
    isoDate: `${String(y).padStart(4, '0')}-${mm}-${dd}`,
    isoMonth: `${String(y).padStart(4, '0')}-${mm}`,
  };
}

/**
 * Checks whether `value` is a real `YYYY-MM-DD` calendar date (rejecting e.g. `2026-02-29`).
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const parts = buildCalendarParts(year, month, day);
  return parts.isoDate === value;
}

/**
 * Validates and returns an ISO `YYYY-MM-DD` date string, throwing on invalid format or date.
 * @param {unknown} value
 * @param {string} [flagName='date']
 * @returns {string}
 */
export function parseIsoDateStrict(value, flagName = 'date') {
  if (!isValidIsoDate(value)) {
    throw new Error(`Invalid date for --${flagName}: "${String(value ?? '')}". Expected valid YYYY-MM-DD.`);
  }
  return /** @type {string} */ (value);
}

/**
 * Shifts an ISO `YYYY-MM-DD` calendar date by `deltaDays` using pure UTC calendar math,
 * avoiding 23h/25h Daylight Saving Time drift.
 * @param {string} isoDate
 * @param {number} deltaDays
 * @returns {CalendarDateParts}
 */
export function shiftIsoDate(isoDate, deltaDays) {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  const day = Number(isoDate.slice(8, 10));
  return buildCalendarParts(year, month, day + deltaDays);
}

/**
 * Extracts calendar date parts for `tsMs` in `tzSpec`, respecting per-timestamp DST rules
 * for `'local'` and `'iana'` modes.
 * @param {number} tsMs
 * @param {TimezoneSpec} tzSpec
 * @returns {CalendarDateParts}
 */
export function datePartsInZone(tsMs, tzSpec) {
  const safeMs = Number.isFinite(tsMs) ? tsMs : 0;

  if (tzSpec.mode === 'local') {
    const d = new Date(safeMs);
    return buildCalendarParts(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }

  if (tzSpec.mode === 'iana' && tzSpec.timeZone) {
    const fmt = getIanaFormatter(tzSpec.timeZone);
    let year = 1970;
    let month = 1;
    let day = 1;
    for (const part of fmt.formatToParts(new Date(safeMs))) {
      if (part.type === 'year') year = Number(part.value);
      else if (part.type === 'month') month = Number(part.value);
      else if (part.type === 'day') day = Number(part.value);
    }
    return buildCalendarParts(year, month, day);
  }

  const shifted = new Date(safeMs + tzSpec.offsetMinutes * 60_000);
  return buildCalendarParts(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate()
  );
}

/**
 * Computes ISO-8601 week key (`YYYY-Www`, Monday-first) from calendar date components.
 * @param {number} year
 * @param {number} month
 * @param {number} day
 * @returns {string}
 */
export function isoWeekKeyFromDate(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function createAccumulator() {
  return {
    requests: 0,
    /** @type {Set<string>} */
    conversations: new Set(),
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedUsd: 0,
    cacheSavedUsd: 0,
    pricedRequests: 0,
  };
}

/**
 * @param {ReturnType<typeof createAccumulator>} acc
 * @param {string} convHash
 * @param {number} input
 * @param {number} cacheRead
 * @param {number} cacheWrite
 * @param {number} output
 * @param {import('./pricing.mjs').TokenCostEstimate} cost
 */
function addToAccumulator(acc, convHash, input, cacheRead, cacheWrite, output, cost) {
  acc.requests += 1;
  acc.conversations.add(convHash);
  acc.inputTokens += input;
  acc.cacheReadTokens += cacheRead;
  acc.cacheWriteTokens += cacheWrite;
  acc.outputTokens += output;
  acc.totalTokens += input + cacheRead + cacheWrite + output;
  if (cost.known) {
    acc.estimatedUsd += cost.estimatedUsd;
    acc.cacheSavedUsd += cost.cacheSavedUsd;
    acc.pricedRequests += 1;
  }
}

/**
 * @param {ReturnType<typeof createAccumulator>} acc
 * @returns {AggregatedBucket}
 */
function finalizeAccumulator(acc) {
  const denom = acc.inputTokens + acc.cacheReadTokens + acc.cacheWriteTokens;
  return {
    requests: acc.requests,
    conversations: acc.conversations.size,
    inputTokens: acc.inputTokens,
    cacheReadTokens: acc.cacheReadTokens,
    cacheWriteTokens: acc.cacheWriteTokens,
    outputTokens: acc.outputTokens,
    totalTokens: acc.totalTokens,
    cacheRate: denom > 0 ? (acc.cacheReadTokens / denom) * 100 : null,
    estimatedUsd: Number(acc.estimatedUsd.toFixed(6)),
    cacheSavedUsd: Number(acc.cacheSavedUsd.toFixed(6)),
    pricedRequests: acc.pricedRequests,
  };
}

/**
 * Aggregates a `UsageLedger` into multi-window overview totals, period buckets (`day`/`week`/`month`),
 * model breakdowns, and an 84-day activity heatmap.
 *
 * @param {any} rawLedger
 * @param {{
 *   dataDir?: string | null,
 *   customRates?: Record<string, import('./pricing.mjs').PricingRate> | null,
 *   days?: number | 'all',
 *   from?: string | null,
 *   to?: string | null,
 *   groupBy?: 'day' | 'week' | 'month',
 *   modelFilter?: string | null,
 *   tz?: string,
 *   now?: number,
 * }} [opts]
 * @returns {UsageReport}
 */
export function buildUsageReport(
  rawLedger,
  {
    dataDir = null,
    customRates = null,
    days = 14,
    from = null,
    to = null,
    groupBy = 'day',
    modelFilter = null,
    tz = 'local',
    now = Date.now(),
  } = {}
) {
  if (!['day', 'week', 'month'].includes(groupBy)) {
    throw new Error(`Invalid groupBy "${groupBy}". Expected day, week, or month.`);
  }

  const safeNow = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  const tzSpec = resolveTimezoneSpec(tz, safeNow);
  const rates = customRates ?? (dataDir ? loadCustomPricing(dataDir) : {});
  const ledger = sanitizeUsageLedger(rawLedger);

  const todayParts = datePartsInZone(safeNow, tzSpec);
  const todayIso = todayParts.isoDate;
  const thisMonthIso = todayParts.isoMonth;
  const sevenDaysAgoIso = shiftIsoDate(todayIso, -6).isoDate;

  const validatedFrom = from ? parseIsoDateStrict(from, 'from') : null;
  const validatedTo = to ? parseIsoDateStrict(to, 'to') : null;

  const rangeTo = validatedTo || todayIso;
  let rangeFrom = validatedFrom;
  if (!rangeFrom && days !== 'all') {
    if (!Number.isInteger(days) || /** @type {number} */ (days) < 1 || /** @type {number} */ (days) > 3650) {
      throw new Error(`Invalid days window: ${String(days)}`);
    }
    rangeFrom = shiftIsoDate(rangeTo, -(/** @type {number} */ (days) - 1)).isoDate;
  }

  if (rangeFrom && rangeFrom > rangeTo) {
    throw new Error(`Invalid date range: --from (${rangeFrom}) cannot be after --to (${rangeTo}).`);
  }

  const filterNeedle = modelFilter ? String(modelFilter).trim().toLowerCase() : null;

  const todayAcc = createAccumulator();
  const week7Acc = createAccumulator();
  const monthAcc = createAccumulator();
  const allTimeAcc = createAccumulator();
  const rangeAcc = createAccumulator();

  /** @type {Map<string, ReturnType<typeof createAccumulator>>} */
  const periodMap = new Map();
  /** @type {Map<string, ReturnType<typeof createAccumulator>>} */
  const modelMap = new Map();
  /** @type {Map<string, number>} */
  const heatmapMap = new Map();

  for (const rec of ledger.records) {
    const [tsSec, convHash, , modelIdx, rawIn, rawCacheRead, rawCacheWrite, rawOut] = rec;
    const input = toNonNegSafeInt(rawIn);
    const cacheRead = toNonNegSafeInt(rawCacheRead);
    const cacheWrite = toNonNegSafeInt(rawCacheWrite);
    const output = toNonNegSafeInt(rawOut);
    if (input + cacheRead + cacheWrite + output === 0) continue;

    const modelName = ledger.models[modelIdx] || 'unknown';
    if (filterNeedle && !modelName.toLowerCase().includes(filterNeedle)) continue;

    const tsMs = toNonNegSafeInt(tsSec) * 1000;
    const parts = datePartsInZone(tsMs, tzSpec);
    const cost = estimateTokenCost(
      modelName,
      {
        inputTokens: input,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        outputTokens: output,
      },
      rates
    );

    addToAccumulator(allTimeAcc, convHash, input, cacheRead, cacheWrite, output, cost);
    if (parts.isoDate === todayIso) {
      addToAccumulator(todayAcc, convHash, input, cacheRead, cacheWrite, output, cost);
    }
    if (parts.isoDate >= sevenDaysAgoIso && parts.isoDate <= todayIso) {
      addToAccumulator(week7Acc, convHash, input, cacheRead, cacheWrite, output, cost);
    }
    if (parts.isoMonth === thisMonthIso) {
      addToAccumulator(monthAcc, convHash, input, cacheRead, cacheWrite, output, cost);
    }

    heatmapMap.set(
      parts.isoDate,
      (heatmapMap.get(parts.isoDate) || 0) + input + cacheRead + cacheWrite + output
    );

    if (rangeFrom && parts.isoDate < rangeFrom) continue;
    if (rangeTo && parts.isoDate > rangeTo) continue;

    addToAccumulator(rangeAcc, convHash, input, cacheRead, cacheWrite, output, cost);

    const periodKey =
      groupBy === 'month'
        ? parts.isoMonth
        : groupBy === 'week'
          ? isoWeekKeyFromDate(parts.year, parts.month, parts.day)
          : parts.isoDate;

    let pAcc = periodMap.get(periodKey);
    if (!pAcc) {
      pAcc = createAccumulator();
      periodMap.set(periodKey, pAcc);
    }
    addToAccumulator(pAcc, convHash, input, cacheRead, cacheWrite, output, cost);

    let mAcc = modelMap.get(modelName);
    if (!mAcc) {
      mAcc = createAccumulator();
      modelMap.set(modelName, mAcc);
    }
    addToAccumulator(mAcc, convHash, input, cacheRead, cacheWrite, output, cost);
  }

  let cliReportedUsd = 0;
  let cliReportedConversations = 0;
  for (const meta of Object.values(ledger.files)) {
    if (typeof meta?.cliCostUsd === 'number' && Number.isFinite(meta.cliCostUsd) && meta.cliCostUsd > 0) {
      cliReportedUsd += meta.cliCostUsd;
      cliReportedConversations += 1;
    }
  }

  const periods = [...periodMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([period, acc]) => ({ period, ...finalizeAccumulator(acc) }));

  const models = [...modelMap.entries()]
    .map(([model, acc]) => ({ model, ...finalizeAccumulator(acc) }))
    .sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model));

  // Build 12-week (84-day) calendar heatmap ending on `todayIso` without DST drift.
  const heatmapDays = [];
  for (let i = 83; i >= 0; i--) {
    const p = shiftIsoDate(todayIso, -i);
    heatmapDays.push({
      date: p.isoDate,
      dayOfWeek: p.dayOfWeek,
      totalTokens: heatmapMap.get(p.isoDate) || 0,
    });
  }

  return {
    generatedAt: new Date(safeNow).toISOString(),
    timezone: tzSpec.label,
    groupBy,
    range: { from: rangeFrom || 'all', to: rangeTo },
    modelFilter: filterNeedle,
    overview: {
      today: finalizeAccumulator(todayAcc),
      last7Days: finalizeAccumulator(week7Acc),
      thisMonth: finalizeAccumulator(monthAcc),
      allTime: finalizeAccumulator(allTimeAcc),
      selectedRange: finalizeAccumulator(rangeAcc),
    },
    cliReportedCost: {
      totalUsd: Number(cliReportedUsd.toFixed(6)),
      conversations: cliReportedConversations,
    },
    periods,
    models,
    heatmap: heatmapDays,
  };
}
