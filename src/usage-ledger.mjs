import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanText } from './ansi.mjs';
import { estimateTokenCost, loadCustomPricing } from './pricing.mjs';
import { hashKey, readJsonSafe, writeJsonAtomic } from './store.mjs';

export const USAGE_LEDGER_SCHEMA = 1;

export function usageLedgerFilePath(dataDir) {
  return path.join(dataDir, 'usage-v1.json');
}

export function defaultBrainDir(homeDir = os.homedir()) {
  return path.join(homeDir, '.gemini', 'antigravity-cli', 'brain');
}

export function createEmptyUsageLedger() {
  return {
    schema: USAGE_LEDGER_SCHEMA,
    updatedAt: null,
    models: [], // model string table to keep records compact
    files: {}, // convHash -> { byteOffset, size, mtimeMs, lastStepIndex, cliCostUsd, cliSubagentUsd }
    // Compact records: [tsSec, convHash, stepIndex, modelIdx, input, cacheRead, cacheWrite, output]
    records: [],
  };
}

function nonNegInt(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function internModel(ledger, modelName) {
  const clean = cleanText(modelName || 'unknown', 80) || 'unknown';
  let idx = ledger.models.indexOf(clean);
  if (idx === -1) {
    idx = ledger.models.length;
    ledger.models.push(clean);
  }
  return idx;
}

function scanSingleTranscriptIntoLedger(ledger, convHash, transcriptPath) {
  let stat;
  try {
    stat = fs.statSync(transcriptPath);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size === 0) return false;

  const prev = ledger.files[convHash] || {
    byteOffset: 0,
    size: 0,
    mtimeMs: 0,
    lastStepIndex: -1,
    cliCostUsd: null,
    cliSubagentUsd: null,
  };

  if (stat.size === prev.size && stat.mtimeMs === prev.mtimeMs) {
    return false;
  }

  const fileState =
    stat.size < prev.byteOffset
      ? { ...prev, byteOffset: 0, lastStepIndex: -1 }
      : { ...prev };

  // Build existing stepIndex set for this conversation only if re-scanning from 0.
  let seenSteps = null;
  if (fileState.byteOffset === 0) {
    seenSteps = new Set();
    for (const rec of ledger.records) {
      if (rec[1] === convHash) seenSteps.add(rec[2]);
    }
  }

  const startOffset = fileState.byteOffset;
  const bytesRemaining = stat.size - startOffset;
  if (bytesRemaining <= 0) {
    fileState.size = stat.size;
    fileState.mtimeMs = stat.mtimeMs;
    ledger.files[convHash] = fileState;
    return false;
  }

  // Stream in 4 MiB chunks so arbitrarily large transcripts never spike memory.
  const chunkSize = 4 * 1024 * 1024;
  let fd;
  let offset = startOffset;
  let leftover = '';
  let lastValidOffset = startOffset;
  let addedAny = false;

  try {
    fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.allocUnsafe(Math.min(chunkSize, bytesRemaining));
    while (offset < stat.size) {
      const toRead = Math.min(buf.length, stat.size - offset);
      const bytesRead = fs.readSync(fd, buf, 0, toRead, offset);
      if (bytesRead <= 0) break;

      const slice = buf.subarray(0, bytesRead);
      const lastNewline = slice.lastIndexOf(0x0a);
      if (lastNewline === -1) {
        // Incomplete line spanning chunk; accumulate up to safety cap (2 MiB).
        if (leftover.length < 2 * 1024 * 1024) {
          leftover += slice.toString('utf8');
        }
        offset += bytesRead;
        continue;
      }

      const text = leftover + slice.subarray(0, lastNewline).toString('utf8');
      leftover = slice.subarray(lastNewline + 1).toString('utf8');
      lastValidOffset = offset + lastNewline + 1;
      offset += bytesRead;

      const lines = text.split('\n');
      for (const rawLine of lines) {
        if (!rawLine || !rawLine.includes('"PLANNER_RESPONSE"')) continue;
        let entry;
        try {
          entry = JSON.parse(rawLine);
        } catch {
          continue;
        }
        if (!entry || entry.type !== 'PLANNER_RESPONSE') continue;

        const stepIndex = Number.isSafeInteger(entry.step_index)
          ? entry.step_index
          : fileState.lastStepIndex + 1;

        if (seenSteps) {
          if (seenSteps.has(stepIndex)) continue;
          seenSteps.add(stepIndex);
        } else if (stepIndex <= fileState.lastStepIndex) {
          continue;
        }

        const inputTokens = nonNegInt(entry.input_tokens);
        const cacheReadTokens = nonNegInt(entry.cache_read_tokens);
        const cacheWriteTokens = nonNegInt(entry.cache_creation_tokens ?? entry.cache_write_tokens);
        const outputTokens = nonNegInt(entry.output_tokens);
        if (inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens === 0) continue;

        const parsedMs =
          typeof entry.created_at === 'string' ? Date.parse(entry.created_at) : NaN;
        const tsSec = Number.isFinite(parsedMs)
          ? Math.floor(parsedMs / 1000)
          : Math.floor(stat.mtimeMs / 1000);

        const modelIdx = internModel(ledger, entry.model);
        ledger.records.push([
          tsSec,
          convHash,
          stepIndex,
          modelIdx,
          inputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          outputTokens,
        ]);
        if (stepIndex > fileState.lastStepIndex) fileState.lastStepIndex = stepIndex;
        addedAny = true;
      }
    }
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }

  fileState.byteOffset = lastValidOffset;
  fileState.size = stat.size;
  fileState.mtimeMs = stat.mtimeMs;
  ledger.files[convHash] = fileState;
  return addedAny || fileState.size !== prev.size || fileState.mtimeMs !== prev.mtimeMs;
}

export function discoverTranscriptFiles(brainDir) {
  const found = [];
  if (!brainDir || !fs.existsSync(brainDir)) return found;
  let entries;
  try {
    entries = fs.readdirSync(brainDir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const dirent of entries) {
    if (!dirent.isDirectory()) continue;
    const convId = dirent.name;
    const transcriptPath = path.join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
    if (fs.existsSync(transcriptPath)) {
      found.push({ convId, convHash: hashKey(convId), transcriptPath });
    }
  }
  return found;
}

/**
 * Incrementally synchronizes all local Antigravity CLI brain transcripts into usage-v1.json.
 * Previously recorded chats are preserved even if deleted from disk.
 */
export function syncUsageLedger({
  dataDir,
  brainDir = defaultBrainDir(),
  extraTranscripts = [],
  rebuild = false,
  now = Date.now(),
} = {}) {
  const ledgerPath = usageLedgerFilePath(dataDir);
  let ledger = rebuild ? createEmptyUsageLedger() : readJsonSafe(ledgerPath);
  if (!ledger || ledger.schema !== USAGE_LEDGER_SCHEMA || !Array.isArray(ledger.records)) {
    ledger = createEmptyUsageLedger();
  }

  const targets = discoverTranscriptFiles(brainDir);
  const seenHashes = new Set(targets.map(t => t.convHash));
  for (const extra of extraTranscripts) {
    if (!extra?.transcriptPath) continue;
    const convHash = hashKey(extra.convId || extra.transcriptPath);
    if (!seenHashes.has(convHash)) {
      seenHashes.add(convHash);
      targets.push({ convId: extra.convId || convHash, convHash, transcriptPath: extra.transcriptPath });
    }
  }

  let changed = rebuild;
  for (const target of targets) {
    if (scanSingleTranscriptIntoLedger(ledger, target.convHash, target.transcriptPath)) {
      changed = true;
    }
  }

  if (changed) {
    ledger.updatedAt = new Date(now).toISOString();
    try {
      writeJsonAtomic(ledgerPath, ledger);
    } catch {
      // allow read-only reporting if dataDir is not writable
    }
  }

  return { ledger, scannedConversations: targets.length, changed };
}

/**
 * Records official CLI-reported session cost into the ledger so spend persists across sessions.
 */
export function recordObservedCliCost(dataDir, convId, { totalUsd = null, subagentUsd = null } = {}, now = Date.now()) {
  if (!convId || (totalUsd === null && subagentUsd === null)) return false;
  const ledgerPath = usageLedgerFilePath(dataDir);
  let ledger = readJsonSafe(ledgerPath);
  if (!ledger || ledger.schema !== USAGE_LEDGER_SCHEMA || !Array.isArray(ledger.records)) {
    ledger = createEmptyUsageLedger();
  }
  const convHash = hashKey(convId);
  const prev = ledger.files[convHash] || {
    byteOffset: 0,
    size: 0,
    mtimeMs: 0,
    lastStepIndex: -1,
    cliCostUsd: null,
    cliSubagentUsd: null,
  };

  const nextTotal =
    typeof totalUsd === 'number' && Number.isFinite(totalUsd) && totalUsd >= 0
      ? Math.max(prev.cliCostUsd ?? 0, totalUsd)
      : prev.cliCostUsd;
  const nextSub =
    typeof subagentUsd === 'number' && Number.isFinite(subagentUsd) && subagentUsd >= 0
      ? Math.max(prev.cliSubagentUsd ?? 0, subagentUsd)
      : prev.cliSubagentUsd;

  if (nextTotal === prev.cliCostUsd && nextSub === prev.cliSubagentUsd) return false;

  ledger.files[convHash] = {
    ...prev,
    cliCostUsd: nextTotal,
    cliSubagentUsd: nextSub,
  };
  ledger.updatedAt = new Date(now).toISOString();
  writeJsonAtomic(ledgerPath, ledger);
  return true;
}

// --- Date & timezone helpers ---

export function resolveTimezoneOffsetMinutes(tz = 'local', now = Date.now()) {
  if (!tz || tz === 'local') {
    return -new Date(now).getTimezoneOffset();
  }
  const lower = String(tz).trim().toLowerCase();
  if (lower === 'utc' || lower === 'z' || lower === 'gmt') return 0;
  const match = lower.match(/^(?:utc|gmt)?([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) {
    throw new Error(`Invalid timezone "${tz}". Use local, utc, or utc+8 / utc-5.`);
  }
  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number(match[2]);
  const mins = Number(match[3] || 0);
  if (hours > 14 || mins >= 60) throw new Error(`Invalid timezone offset: ${tz}`);
  return sign * (hours * 60 + mins);
}

export function formatOffsetLabel(offsetMinutes) {
  if (offsetMinutes === 0) return 'UTC';
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m > 0 ? `UTC${sign}${h}:${String(m).padStart(2, '0')}` : `UTC${sign}${h}`;
}

function datePartsInOffset(tsMs, offsetMinutes) {
  const shifted = new Date(tsMs + offsetMinutes * 60_000);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  const dayOfWeek = shifted.getUTCDay(); // 0=Sun .. 6=Sat
  return {
    year,
    month,
    day,
    dayOfWeek,
    isoDate: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    isoMonth: `${year}-${String(month).padStart(2, '0')}`,
  };
}

function isoWeekKey(tsMs, offsetMinutes) {
  const shifted = new Date(tsMs + offsetMinutes * 60_000);
  const d = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
  // ISO week date: Thursday decides the week-year; weeks start Monday.
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function createAccumulator() {
  return {
    requests: 0,
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

function addToAccumulator(acc, rec, cost) {
  const [, convHash, , , input, cacheRead, cacheWrite, output] = rec;
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

export function buildUsageReport(
  ledger,
  {
    dataDir = null,
    days = 14, // number or 'all'
    from = null, // YYYY-MM-DD
    to = null, // YYYY-MM-DD
    groupBy = 'day', // 'day' | 'week' | 'month'
    modelFilter = null,
    tz = 'local',
    now = Date.now(),
  } = {}
) {
  const offsetMinutes = resolveTimezoneOffsetMinutes(tz, now);
  const customRates = dataDir ? loadCustomPricing(dataDir) : {};
  const todayParts = datePartsInOffset(now, offsetMinutes);
  const todayIso = todayParts.isoDate;
  const thisMonthIso = todayParts.isoMonth;
  const sevenDaysAgoIso = datePartsInOffset(now - 6 * 86_400_000, offsetMinutes).isoDate;

  let rangeFrom = from;
  let rangeTo = to || todayIso;
  if (!rangeFrom && days !== 'all' && Number.isInteger(days) && days > 0) {
    rangeFrom = datePartsInOffset(now - (days - 1) * 86_400_000, offsetMinutes).isoDate;
  }

  const filterNeedle = modelFilter ? String(modelFilter).trim().toLowerCase() : null;

  const todayAcc = createAccumulator();
  const week7Acc = createAccumulator();
  const monthAcc = createAccumulator();
  const allTimeAcc = createAccumulator();
  const rangeAcc = createAccumulator();

  const periodMap = new Map();
  const modelMap = new Map();
  const heatmapMap = new Map(); // isoDate -> totalTokens

  for (const rec of ledger.records || []) {
    const [tsSec, , , modelIdx, input, cacheRead, cacheWrite, output] = rec;
    const modelName = ledger.models?.[modelIdx] || 'unknown';
    if (filterNeedle && !modelName.toLowerCase().includes(filterNeedle)) continue;

    const tsMs = tsSec * 1000;
    const parts = datePartsInOffset(tsMs, offsetMinutes);
    const cost = estimateTokenCost(
      modelName,
      { inputTokens: input, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, outputTokens: output },
      customRates
    );

    addToAccumulator(allTimeAcc, rec, cost);
    if (parts.isoDate === todayIso) addToAccumulator(todayAcc, rec, cost);
    if (parts.isoDate >= sevenDaysAgoIso && parts.isoDate <= todayIso) {
      addToAccumulator(week7Acc, rec, cost);
    }
    if (parts.isoMonth === thisMonthIso) addToAccumulator(monthAcc, rec, cost);

    heatmapMap.set(parts.isoDate, (heatmapMap.get(parts.isoDate) || 0) + input + cacheRead + cacheWrite + output);

    if (rangeFrom && parts.isoDate < rangeFrom) continue;
    if (rangeTo && parts.isoDate > rangeTo) continue;

    addToAccumulator(rangeAcc, rec, cost);

    const periodKey =
      groupBy === 'month'
        ? parts.isoMonth
        : groupBy === 'week'
          ? isoWeekKey(tsMs, offsetMinutes)
          : parts.isoDate;
    if (!periodMap.has(periodKey)) periodMap.set(periodKey, createAccumulator());
    addToAccumulator(periodMap.get(periodKey), rec, cost);

    if (!modelMap.has(modelName)) modelMap.set(modelName, createAccumulator());
    addToAccumulator(modelMap.get(modelName), rec, cost);
  }

  // Sum official CLI-reported session costs recorded across conversations (if any).
  let cliReportedUsd = 0;
  let cliReportedConversations = 0;
  for (const meta of Object.values(ledger.files || {})) {
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

  // Build 12-week (84-day) heatmap ending on the Sunday of the current week (or today).
  const heatmapDays = [];
  for (let i = 83; i >= 0; i--) {
    const p = datePartsInOffset(now - i * 86_400_000, offsetMinutes);
    heatmapDays.push({
      date: p.isoDate,
      dayOfWeek: p.dayOfWeek,
      totalTokens: heatmapMap.get(p.isoDate) || 0,
    });
  }

  return {
    generatedAt: new Date(now).toISOString(),
    timezone: formatOffsetLabel(offsetMinutes),
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
