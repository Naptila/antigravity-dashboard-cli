// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { cleanText } from './ansi.mjs';
import {
  MAX_LINE_BYTES,
  TRANSCRIPT_CHUNK_BYTES,
  TRANSCRIPT_REL_SEGMENTS,
  USAGE_LEDGER_SCHEMA,
} from './constants.mjs';
import { defaultBrainDir, hashKey, readJsonSafe, writeJsonAtomic } from './store.mjs';

export { USAGE_LEDGER_SCHEMA };

/**
 * Compact 8-element tuple:
 * `[tsSec, convHash, stepIndex, modelIdx, inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens]`
 * @typedef {[number, string, number, number, number, number, number, number]} LedgerRecordTuple
 *
 * @typedef {{
 *   byteOffset: number,
 *   size: number,
 *   mtimeMs: number,
 *   lastStepIndex: number,
 *   cliCostUsd: number | null,
 *   cliSubagentUsd: number | null,
 * }} LedgerFileCursor
 *
 * @typedef {{
 *   schema: number,
 *   updatedAt: string | null,
 *   models: string[],
 *   files: Record<string, LedgerFileCursor>,
 *   records: LedgerRecordTuple[],
 * }} UsageLedger
 *
 * @typedef {{
 *   convId: string,
 *   convHash: string,
 *   transcriptPath: string,
 *   stat?: fs.Stats,
 * }} DiscoveredTranscript
 */

/**
 * @param {string} dataDir
 * @returns {string}
 */
export function usageLedgerFilePath(dataDir) {
  return path.join(dataDir, 'usage-v1.json');
}

/**
 * Creates a fresh, empty v1 usage ledger.
 * @returns {UsageLedger}
 */
export function createEmptyUsageLedger() {
  return {
    schema: USAGE_LEDGER_SCHEMA,
    updatedAt: null,
    models: [],
    files: Object.create(null),
    records: [],
  };
}

/**
 * Coerces a token count field (number or digit string) to a non-negative safe integer.
 * @param {unknown} value
 * @returns {number}
 */
export function toNonNegSafeInt(value) {
  if (Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0) {
    return /** @type {number} */ (value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  return 0;
}

/**
 * Creates a default per-conversation cursor entry.
 * @returns {LedgerFileCursor}
 */
function createEmptyFileCursor() {
  return {
    byteOffset: 0,
    size: 0,
    mtimeMs: 0,
    lastStepIndex: -1,
    cliCostUsd: null,
    cliSubagentUsd: null,
  };
}

/**
 * Sanitizes a raw deserialized ledger object from disk, dropping malformed tuples
 * so corrupted or partially edited cache files never cause crashes or `NaN` totals.
 * @param {any} raw
 * @returns {UsageLedger}
 */
export function sanitizeUsageLedger(raw) {
  if (!raw || typeof raw !== 'object' || raw.schema !== USAGE_LEDGER_SCHEMA || !Array.isArray(raw.records)) {
    return createEmptyUsageLedger();
  }

  const models = Array.isArray(raw.models)
    ? raw.models.map((/** @type {unknown} */ m) => cleanText(typeof m === 'string' ? m : 'unknown', 80) || 'unknown')
    : [];

  /** @type {Record<string, LedgerFileCursor>} */
  const files = Object.create(null);
  if (raw.files && typeof raw.files === 'object' && !Array.isArray(raw.files)) {
    for (const [key, val] of Object.entries(raw.files)) {
      if (!key || !val || typeof val !== 'object' || Array.isArray(val)) continue;
      files[key] = {
        byteOffset: toNonNegSafeInt(val.byteOffset),
        size: toNonNegSafeInt(val.size),
        mtimeMs: typeof val.mtimeMs === 'number' && Number.isFinite(val.mtimeMs) && val.mtimeMs >= 0 ? val.mtimeMs : 0,
        lastStepIndex: Number.isSafeInteger(val.lastStepIndex) ? val.lastStepIndex : -1,
        cliCostUsd:
          typeof val.cliCostUsd === 'number' && Number.isFinite(val.cliCostUsd) && val.cliCostUsd >= 0
            ? val.cliCostUsd
            : null,
        cliSubagentUsd:
          typeof val.cliSubagentUsd === 'number' && Number.isFinite(val.cliSubagentUsd) && val.cliSubagentUsd >= 0
            ? val.cliSubagentUsd
            : null,
      };
    }
  }

  /** @type {LedgerRecordTuple[]} */
  const records = [];
  for (const rec of raw.records) {
    if (!Array.isArray(rec) || rec.length < 8) continue;
    const tsSec = toNonNegSafeInt(rec[0]);
    const convHash = typeof rec[1] === 'string' && rec[1] ? rec[1] : 'unknown';
    const stepIndex = Number.isSafeInteger(rec[2]) && rec[2] >= 0 ? rec[2] : 0;
    const modelIdx = Number.isSafeInteger(rec[3]) && rec[3] >= 0 && rec[3] < models.length ? rec[3] : -1;
    const input = toNonNegSafeInt(rec[4]);
    const cacheRead = toNonNegSafeInt(rec[5]);
    const cacheWrite = toNonNegSafeInt(rec[6]);
    const output = toNonNegSafeInt(rec[7]);
    if (input + cacheRead + cacheWrite + output === 0) continue;

    let resolvedModelIdx = modelIdx;
    if (resolvedModelIdx === -1) {
      resolvedModelIdx = models.indexOf('unknown');
      if (resolvedModelIdx === -1) {
        resolvedModelIdx = models.length;
        models.push('unknown');
      }
    }
    records.push([tsSec, convHash, stepIndex, resolvedModelIdx, input, cacheRead, cacheWrite, output]);
  }

  return {
    schema: USAGE_LEDGER_SCHEMA,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    models,
    files,
    records,
  };
}

/**
 * Interns a cleaned model name into `ledger.models` and returns its compact index.
 * @param {UsageLedger} ledger
 * @param {unknown} modelName
 * @returns {number}
 */
function internModel(ledger, modelName) {
  const clean = cleanText(typeof modelName === 'string' ? modelName : 'unknown', 80) || 'unknown';
  let idx = ledger.models.indexOf(clean);
  if (idx === -1) {
    idx = ledger.models.length;
    ledger.models.push(clean);
  }
  return idx;
}

/**
 * Parses timestamp fields (`ISO-8601` string, epoch ms, or epoch seconds) into epoch seconds.
 * @param {unknown} createdAt
 * @param {number} fallbackMs
 * @returns {number}
 */
function parseEntryTimestampSec(createdAt, fallbackMs) {
  if (typeof createdAt === 'string' && createdAt.trim()) {
    const parsedMs = Date.parse(createdAt);
    if (Number.isFinite(parsedMs) && parsedMs >= 0) {
      return Math.floor(parsedMs / 1000);
    }
  } else if (typeof createdAt === 'number' && Number.isFinite(createdAt) && createdAt > 0) {
    return createdAt >= 1e11 ? Math.floor(createdAt / 1000) : Math.floor(createdAt);
  }
  return Number.isFinite(fallbackMs) && fallbackMs > 0 ? Math.floor(fallbackMs / 1000) : 0;
}

/**
 * Extracts normalized token usage from a single `PLANNER_RESPONSE` JSON entry,
 * supporting both top-level transcript fields and nested `usage` objects.
 * Returns `null` for non-`PLANNER_RESPONSE` or zero-token entries.
 *
 * @param {unknown} entry
 * @param {number} [fallbackMs=0]
 * @returns {{
 *   stepIndex: number | null,
 *   model: string,
 *   tsSec: number,
 *   inputTokens: number,
 *   cacheReadTokens: number,
 *   cacheWriteTokens: number,
 *   outputTokens: number,
 * } | null}
 */
export function parsePlannerResponseEntry(entry, fallbackMs = 0) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const obj = /** @type {Record<string, any>} */ (entry);
  if (obj.type !== 'PLANNER_RESPONSE') return null;

  const usage = obj.usage && typeof obj.usage === 'object' && !Array.isArray(obj.usage) ? obj.usage : null;

  const inputTokens = toNonNegSafeInt(obj.input_tokens ?? usage?.input_tokens);
  const cacheReadTokens = toNonNegSafeInt(
    obj.cache_read_tokens ??
      obj.cache_read_input_tokens ??
      obj.cached_tokens ??
      usage?.cache_read_tokens ??
      usage?.cache_read_input_tokens
  );
  const cacheWriteTokens = toNonNegSafeInt(
    obj.cache_creation_tokens ??
      obj.cache_write_tokens ??
      obj.cache_creation_input_tokens ??
      usage?.cache_creation_tokens ??
      usage?.cache_write_tokens ??
      usage?.cache_creation_input_tokens
  );
  const outputTokens = toNonNegSafeInt(obj.output_tokens ?? usage?.output_tokens);

  if (inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens === 0) {
    return null;
  }

  const rawStep = obj.step_index;
  const stepIndex = Number.isSafeInteger(rawStep) && rawStep >= 0 ? rawStep : null;
  const rawModel = typeof obj.model === 'string' ? obj.model : obj.model?.id || obj.model?.display_name || 'unknown';
  const model = cleanText(rawModel, 80) || 'unknown';
  const tsSec = parseEntryTimestampSec(obj.created_at ?? obj.timestamp, fallbackMs);

  return {
    stepIndex,
    model,
    tsSec,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
  };
}

/**
 * Appends a single parsed JSONL line into `ledger` if it represents an unseen `PLANNER_RESPONSE`.
 * @param {UsageLedger} ledger
 * @param {string} convHash
 * @param {LedgerFileCursor} fileState
 * @param {Set<number>} seenSteps
 * @param {string} rawLine
 * @param {number} mtimeMs
 * @param {{ requireValidJson?: boolean }} [opts]
 * @returns {{ parsedJson: boolean, added: boolean }}
 */
function ingestTranscriptLine(
  ledger,
  convHash,
  fileState,
  seenSteps,
  rawLine,
  mtimeMs,
  { requireValidJson = false } = {}
) {
  const trimmed = rawLine.replace(/^\uFEFF/, '').trim();
  if (!trimmed) return { parsedJson: true, added: false };

  if (!trimmed.includes('"PLANNER_RESPONSE"')) {
    if (!requireValidJson) return { parsedJson: true, added: false };
    try {
      JSON.parse(trimmed);
      return { parsedJson: true, added: false };
    } catch {
      return { parsedJson: false, added: false };
    }
  }

  let parsedObj;
  try {
    parsedObj = JSON.parse(trimmed);
  } catch {
    return { parsedJson: false, added: false };
  }

  const normalized = parsePlannerResponseEntry(parsedObj, mtimeMs);
  if (!normalized) return { parsedJson: true, added: false };

  const stepIndex =
    normalized.stepIndex !== null ? normalized.stepIndex : fileState.lastStepIndex + 1;

  if (seenSteps.has(stepIndex)) {
    return { parsedJson: true, added: false };
  }
  seenSteps.add(stepIndex);

  const modelIdx = internModel(ledger, normalized.model);
  ledger.records.push([
    normalized.tsSec,
    convHash,
    stepIndex,
    modelIdx,
    normalized.inputTokens,
    normalized.cacheReadTokens,
    normalized.cacheWriteTokens,
    normalized.outputTokens,
  ]);
  if (stepIndex > fileState.lastStepIndex) {
    fileState.lastStepIndex = stepIndex;
  }
  return { parsedJson: true, added: true };
}

/**
 * Incrementally scans unread tail bytes from a single `transcript.jsonl` file into `ledger`.
 * - Streams in 4 MiB chunks with `Buffer` slicing so split multi-byte UTF-8 sequences never corrupt.
 * - Commits trailing newline-less EOF lines only when they form complete JSON, leaving partial
 *   in-flight writes uncommitted so the next sync re-reads them cleanly.
 *
 * @param {UsageLedger} ledger
 * @param {string} convHash
 * @param {string} transcriptPath
 * @param {fs.Stats | null} [preStat=null]
 * @returns {boolean}
 */
export function scanSingleTranscriptIntoLedger(ledger, convHash, transcriptPath, preStat = null) {
  let stat = preStat;
  if (!stat) {
    try {
      stat = fs.statSync(transcriptPath, { throwIfNoEntry: false }) || null;
    } catch {
      return false;
    }
  }
  if (!stat || !stat.isFile()) return false;

  const prev = ledger.files[convHash] || createEmptyFileCursor();
  if (stat.size === 0) {
    if (prev.size !== 0 || prev.byteOffset !== 0) {
      ledger.files[convHash] = { ...prev, byteOffset: 0, size: 0, mtimeMs: stat.mtimeMs };
      return true;
    }
    return false;
  }

  if (stat.size === prev.size && stat.mtimeMs === prev.mtimeMs && prev.byteOffset === stat.size) {
    return false;
  }
  if (stat.size === prev.size && stat.mtimeMs === prev.mtimeMs && prev.byteOffset > 0) {
    return false;
  }

  const fileState =
    stat.size < prev.byteOffset
      ? { ...prev, byteOffset: 0, lastStepIndex: -1 }
      : { ...prev };

  const startOffset = fileState.byteOffset;
  const bytesRemaining = stat.size - startOffset;
  if (bytesRemaining <= 0) {
    fileState.size = stat.size;
    fileState.mtimeMs = stat.mtimeMs;
    ledger.files[convHash] = fileState;
    return fileState.size !== prev.size || fileState.mtimeMs !== prev.mtimeMs;
  }

  /** @type {Set<number>} */
  const seenSteps = new Set();
  for (const rec of ledger.records) {
    if (rec[1] === convHash) seenSteps.add(rec[2]);
  }

  let fd;
  let offset = startOffset;
  /** @type {Buffer} */
  let leftoverBuf = Buffer.alloc(0);
  let leftoverOverflowed = false;
  let lastValidOffset = startOffset;
  let addedAny = false;

  try {
    fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.allocUnsafe(Math.min(TRANSCRIPT_CHUNK_BYTES, bytesRemaining));

    while (offset < stat.size) {
      const toRead = Math.min(buf.length, stat.size - offset);
      const bytesRead = fs.readSync(fd, buf, 0, toRead, offset);
      if (bytesRead <= 0) break;

      const slice = buf.subarray(0, bytesRead);
      const lastNewline = slice.lastIndexOf(0x0a);

      if (lastNewline === -1) {
        if (!leftoverOverflowed) {
          if (leftoverBuf.length + slice.length <= MAX_LINE_BYTES) {
            leftoverBuf = leftoverBuf.length === 0 ? Buffer.from(slice) : Buffer.concat([leftoverBuf, slice]);
          } else {
            leftoverBuf = Buffer.alloc(0);
            leftoverOverflowed = true;
          }
        }
        offset += bytesRead;
        continue;
      }

      const firstNewline = slice.indexOf(0x0a);
      let completedText;
      if (leftoverOverflowed) {
        // Drop only the oversized line before `firstNewline`, keeping subsequent lines in this chunk.
        completedText =
          firstNewline < lastNewline
            ? slice.subarray(firstNewline + 1, lastNewline).toString('utf8')
            : '';
        leftoverOverflowed = false;
      } else if (leftoverBuf.length > 0) {
        completedText = Buffer.concat([leftoverBuf, slice.subarray(0, lastNewline)]).toString('utf8');
      } else {
        completedText = slice.subarray(0, lastNewline).toString('utf8');
      }

      const tailSlice = slice.subarray(lastNewline + 1);
      leftoverBuf = tailSlice.length > 0 ? Buffer.from(tailSlice) : Buffer.alloc(0);
      lastValidOffset = offset + lastNewline + 1;
      offset += bytesRead;

      if (completedText) {
        const lines = completedText.split('\n');
        for (const rawLine of lines) {
          const res = ingestTranscriptLine(ledger, convHash, fileState, seenSteps, rawLine, stat.mtimeMs);
          if (res.added) addedAny = true;
        }
      }
    }

    // Handle trailing line at EOF when the transcript does not end with '\n'.
    if (!leftoverOverflowed && leftoverBuf.length > 0) {
      const trailingLine = leftoverBuf.toString('utf8');
      const res = ingestTranscriptLine(ledger, convHash, fileState, seenSteps, trailingLine, stat.mtimeMs, {
        requireValidJson: true,
      });
      if (res.parsedJson) {
        lastValidOffset = offset;
        if (res.added) addedAny = true;
      }
    } else if (leftoverOverflowed) {
      lastValidOffset = offset;
    }
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close errors
      }
    }
  }

  fileState.byteOffset = lastValidOffset;
  fileState.size = stat.size;
  fileState.mtimeMs = stat.mtimeMs;
  ledger.files[convHash] = fileState;
  return (
    addedAny ||
    fileState.byteOffset !== prev.byteOffset ||
    fileState.size !== prev.size ||
    fileState.mtimeMs !== prev.mtimeMs
  );
}

/**
 * Discovers regular `transcript.jsonl` files under `<brainDir>/<convId>/.system_generated/logs/`.
 * Captures `fs.Stats` during discovery so `syncUsageLedger` avoids duplicate `statSync` syscalls.
 * @param {string} brainDir
 * @returns {DiscoveredTranscript[]}
 */
export function discoverTranscriptFiles(brainDir) {
  /** @type {DiscoveredTranscript[]} */
  const found = [];
  if (!brainDir) return found;

  let entries;
  try {
    entries = fs.readdirSync(brainDir, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const dirent of entries) {
    if (!dirent.isDirectory()) continue;
    const convId = dirent.name;
    const transcriptPath = path.join(brainDir, convId, ...TRANSCRIPT_REL_SEGMENTS);
    try {
      const stat = fs.statSync(transcriptPath, { throwIfNoEntry: false });
      if (stat && stat.isFile()) {
        found.push({ convId, convHash: hashKey(convId), transcriptPath, stat });
      }
    } catch {
      // skip inaccessible directories
    }
  }
  return found;
}

/**
 * Incrementally synchronizes all local Antigravity CLI brain transcripts into `usage-v1.json`.
 * Previously recorded conversations are preserved even if later deleted from disk.
 *
 * @param {{
 *   dataDir: string,
 *   brainDir?: string,
 *   extraTranscripts?: Array<{ convId?: string, transcriptPath: string }>,
 *   rebuild?: boolean,
 *   now?: number,
 * }} opts
 * @returns {{ ledger: UsageLedger, scannedConversations: number, changed: boolean }}
 */
export function syncUsageLedger({
  dataDir,
  brainDir = defaultBrainDir(),
  extraTranscripts = [],
  rebuild = false,
  now = Date.now(),
} = /** @type {any} */ ({})) {
  const ledgerPath = dataDir ? usageLedgerFilePath(dataDir) : null;
  const ledger = rebuild
    ? createEmptyUsageLedger()
    : sanitizeUsageLedger(ledgerPath ? readJsonSafe(ledgerPath) : null);

  const targets = discoverTranscriptFiles(brainDir);
  const seenHashes = new Set(targets.map(t => t.convHash));

  if (Array.isArray(extraTranscripts)) {
    for (const extra of extraTranscripts) {
      if (!extra?.transcriptPath) continue;
      const convHash = hashKey(extra.convId || extra.transcriptPath);
      if (!seenHashes.has(convHash)) {
        seenHashes.add(convHash);
        targets.push({
          convId: extra.convId || convHash,
          convHash,
          transcriptPath: extra.transcriptPath,
        });
      }
    }
  }

  let changed = Boolean(rebuild);
  for (const target of targets) {
    if (scanSingleTranscriptIntoLedger(ledger, target.convHash, target.transcriptPath, target.stat || null)) {
      changed = true;
    }
  }

  if (changed && ledgerPath) {
    ledger.updatedAt = new Date(now).toISOString();
    try {
      writeJsonAtomic(ledgerPath, ledger);
    } catch {
      // allow read-only reporting when dataDir is not writable
    }
  }

  return { ledger, scannedConversations: targets.length, changed };
}

/**
 * Records official CLI-reported session cost into the ledger so spend persists across sessions.
 * @param {string} dataDir
 * @param {string} convId
 * @param {{ totalUsd?: number | null, subagentUsd?: number | null }} [costs]
 * @param {number} [now=Date.now()]
 * @returns {boolean}
 */
export function recordObservedCliCost(
  dataDir,
  convId,
  { totalUsd = null, subagentUsd = null } = {},
  now = Date.now()
) {
  if (!dataDir || !convId || (totalUsd === null && subagentUsd === null)) return false;
  const ledgerPath = usageLedgerFilePath(dataDir);
  const ledger = sanitizeUsageLedger(readJsonSafe(ledgerPath));
  const convHash = hashKey(convId);
  const prev = ledger.files[convHash] || createEmptyFileCursor();

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
