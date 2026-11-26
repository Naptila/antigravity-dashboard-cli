// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CLI_DIR_SEGMENTS,
  DEFAULT_BRAIN_DIR_NAME,
  DEFAULT_DATA_DIR_NAME,
  DEFAULT_LANGUAGE,
  MAX_STDIN_BYTES,
  SUPPORTED_LANGUAGES,
} from './constants.mjs';

/**
 * @typedef {{ language: 'en' | 'zh-CN' | 'zh-TW', showCache: boolean, showCost: boolean }} DashboardPreferences
 */

/**
 * Resolves the Antigravity CLI configuration base directory (`~/.gemini/antigravity-cli`).
 * Explicit `homeDir` overrides take precedence over `AGY_CLI_HOME`.
 * @param {{ homeDir?: string | null, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {string}
 */
export function resolveCliBaseDir({ homeDir = null, env = process.env } = {}) {
  if (homeDir) {
    return path.join(path.resolve(homeDir), ...CLI_DIR_SEGMENTS);
  }
  if (env?.AGY_CLI_HOME) {
    return path.resolve(env.AGY_CLI_HOME);
  }
  return path.join(os.homedir(), ...CLI_DIR_SEGMENTS);
}

/**
 * Resolves the plugin data directory (`preferences.json`, `usage-v1.json`, `pricing.json`).
 * @param {string | null} [explicitDir=null]
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @param {string | null} [homeDir=null]
 * @returns {string}
 */
export function resolveDataDir(explicitDir = null, env = process.env, homeDir = null) {
  if (explicitDir) return path.resolve(explicitDir);
  if (env?.AGY_DASHBOARD_DATA_DIR) return path.resolve(env.AGY_DASHBOARD_DATA_DIR);
  return path.join(resolveCliBaseDir({ homeDir, env }), DEFAULT_DATA_DIR_NAME);
}

/**
 * Resolves the default `brain/` directory containing local conversation transcripts.
 * @param {string | null} [homeDir=null]
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string}
 */
export function defaultBrainDir(homeDir = null, env = process.env) {
  if (homeDir) {
    return path.join(resolveCliBaseDir({ homeDir, env }), DEFAULT_BRAIN_DIR_NAME);
  }
  if (env?.AGY_BRAIN_DIR) {
    return path.resolve(env.AGY_BRAIN_DIR);
  }
  return path.join(resolveCliBaseDir({ env }), DEFAULT_BRAIN_DIR_NAME);
}

/**
 * Computes a compact 20-hex-character SHA-256 digest for indexing conversation keys.
 * @param {unknown} raw
 * @returns {string}
 */
export function hashKey(raw) {
  return crypto.createHash('sha256').update(String(raw ?? '')).digest('hex').slice(0, 20);
}

/**
 * Reads bounded JSON input from a readable stream (defaults to `process.stdin`).
 * @param {{ stream?: AsyncIterable<Buffer | string>, maxBytes?: number, allowEmpty?: boolean }} [opts]
 * @returns {Promise<any>}
 */
export async function readStdinJson({
  stream = process.stdin,
  maxBytes = MAX_STDIN_BYTES,
  allowEmpty = false,
} = {}) {
  let size = 0;
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    size += buf.length;
    if (size > maxBytes) {
      throw new Error(`Input exceeds maximum size (${maxBytes} bytes)`);
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '').trim();
  if (!text) {
    if (allowEmpty) return {};
    throw new Error('Empty JSON input');
  }
  return JSON.parse(text);
}

/**
 * Safely reads and parses a JSON object file, returning `fallback` on missing/corrupt/array files.
 * @template T
 * @param {string} filePath
 * @param {T} [fallback=null]
 * @returns {any | T}
 */
export function readJsonSafe(filePath, fallback = /** @type {any} */ (null)) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Atomically writes JSON to `filePath` via a `0o600` temp file + `fsync` + `rename`.
 * @param {string} filePath
 * @param {unknown} value
 */
export function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  );
  try {
    const serialized = JSON.stringify(value, null, 2) + '\n';
    const fd = fs.openSync(tmpPath, 'w', 0o600);
    try {
      fs.writeSync(fd, serialized, 0, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup failure
    }
  }
}

/**
 * @param {string} dataDir
 * @returns {string}
 */
export function preferencesFilePath(dataDir) {
  return path.join(dataDir, 'preferences.json');
}

/**
 * Parses human-readable token window sizes (`"512K"`, `"1M"`, `256000`, `"auto (512000)"`).
 * @param {unknown} value
 * @returns {number | null}
 */
export function parseTokenSizeString(value) {
  if (Number.isSafeInteger(value) && /** @type {number} */ (value) >= 1000) {
    return /** @type {number} */ (value);
  }
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  if (!s || s === 'default' || s === 'auto') return null;
  const paren = s.match(/\((\d{4,})\)/);
  if (paren) {
    const exact = Number(paren[1]);
    if (Number.isSafeInteger(exact) && exact >= 1000) return exact;
  }
  const match = s.match(/^(\d+(?:\.\d+)?)\s*([km])?$/);
  if (!match) return null;
  const num = Number(match[1]);
  if (!Number.isFinite(num) || num <= 0) return null;
  if (match[2] === 'm') return Math.round(num * 1_000_000);
  if (match[2] === 'k') return Math.round(num * 1_000);
  return num >= 1000 ? Math.round(num) : null;
}

/**
 * Parses `AGY_CLI_AUTO_COMPACT_OVERRIDE` values (`"512K"`, `"80%"`, `"off"`, `0`).
 * @param {unknown} value
 * @param {number | null} [capacity=null]
 * @returns {{ disabled: boolean, tokens: number | null } | null}
 */
export function parseAutoCompactOverride(value, capacity = null) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (!s || s === 'default' || s === 'auto') return null;
    if (['0', 'off', 'false', 'none', 'disable', 'disabled'].includes(s)) {
      return { disabled: true, tokens: null };
    }
    const pctMatch = s.match(/^(\d+(?:\.\d+)?)\s*%$/);
    if (pctMatch) {
      const pct = Number(pctMatch[1]);
      if (Number.isFinite(pct) && pct > 0 && pct <= 100 && capacity) {
        return { disabled: false, tokens: Math.round((pct / 100) * capacity) };
      }
      return null;
    }
  } else if (value === 0 || value === false) {
    return { disabled: true, tokens: null };
  }
  const tokens = parseTokenSizeString(value);
  return tokens ? { disabled: false, tokens } : null;
}

/**
 * Reads compaction overrides from environment, project `.antigravity/settings.json`,
 * and global `settings.json`.
 * @param {{ env?: NodeJS.ProcessEnv, homeDir?: string | null, projectDir?: string | null }} [opts]
 * @returns {{ autoCompactOverrideRaw: unknown, configuredContextWindow: number | null }}
 */
export function readCliContextOverrides({
  env = process.env,
  homeDir = null,
  projectDir = null,
} = {}) {
  const globalSettingsPath = path.join(resolveCliBaseDir({ homeDir, env }), 'settings.json');
  const globalSettings = readJsonSafe(globalSettingsPath, null);
  const projectSettings =
    projectDir && typeof projectDir === 'string'
      ? readJsonSafe(path.join(projectDir, '.antigravity', 'settings.json'), null)
      : null;

  const rawEnvOverride =
    env?.AGY_CLI_AUTO_COMPACT_OVERRIDE ??
    projectSettings?.env?.AGY_CLI_AUTO_COMPACT_OVERRIDE ??
    globalSettings?.env?.AGY_CLI_AUTO_COMPACT_OVERRIDE ??
    null;

  const configuredContextWindow =
    parseTokenSizeString(projectSettings?.contextWindow) ??
    parseTokenSizeString(globalSettings?.contextWindow) ??
    null;

  return {
    autoCompactOverrideRaw: rawEnvOverride,
    configuredContextWindow,
  };
}

/**
 * Normalizes a raw preferences object into validated boolean and language fields.
 * @param {any} raw
 * @returns {DashboardPreferences}
 */
function normalizePreferencesObject(raw) {
  const language = SUPPORTED_LANGUAGES.includes(raw?.language)
    ? raw.language
    : DEFAULT_LANGUAGE;
  const showCache = raw?.showCache !== false;
  const showCost = raw?.showCost === true;
  return { language, showCache, showCost };
}

/**
 * Loads normalized dashboard preferences from `<dataDir>/preferences.json`.
 * @param {string} dataDir
 * @returns {DashboardPreferences}
 */
export function loadPreferences(dataDir) {
  const local = readJsonSafe(preferencesFilePath(dataDir), {});
  return normalizePreferencesObject(local);
}

/**
 * Updates and atomically persists dashboard preferences in `<dataDir>/preferences.json`.
 * @param {string} dataDir
 * @param {{ language?: string, showCache?: boolean, showCost?: boolean }} patch
 * @returns {DashboardPreferences & { updatedAt: string }}
 */
export function savePreferences(dataDir, patch = {}) {
  const current = readJsonSafe(preferencesFilePath(dataDir), {});
  const next = { ...current };
  if (patch.language !== undefined) {
    if (!SUPPORTED_LANGUAGES.includes(/** @type {any} */ (patch.language))) {
      throw new Error(`Unsupported language: ${patch.language}`);
    }
    next.language = patch.language;
  }
  if (typeof patch.showCache === 'boolean') next.showCache = patch.showCache;
  if (typeof patch.showCost === 'boolean') next.showCost = patch.showCost;

  const normalized = normalizePreferencesObject(next);
  const record = {
    ...next,
    ...normalized,
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(preferencesFilePath(dataDir), record);
  return { ...normalized, updatedAt: record.updatedAt };
}
