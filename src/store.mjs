import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SUPPORTED_LANGUAGES } from './constants.mjs';

export function resolveDataDir(explicitDir = null, env = process.env, homeDir = os.homedir()) {
  if (explicitDir) return path.resolve(explicitDir);
  if (env.AGY_DASHBOARD_DATA_DIR) return path.resolve(env.AGY_DASHBOARD_DATA_DIR);
  return path.join(homeDir, '.gemini', 'antigravity-cli', 'dashboard-cli-data');
}

export function hashKey(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex').slice(0, 20);
}

export function readJsonSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

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

export function preferencesFilePath(dataDir) {
  return path.join(dataDir, 'preferences.json');
}

export function parseTokenSizeString(value) {
  if (Number.isSafeInteger(value) && value >= 1000) return value;
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

export function readCliContextOverrides({
  env = process.env,
  homeDir = os.homedir(),
  projectDir = null,
} = {}) {
  const globalSettingsPath = path.join(homeDir, '.gemini', 'antigravity-cli', 'settings.json');
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

export function loadPreferences(dataDir) {
  const local = readJsonSafe(preferencesFilePath(dataDir), {});
  const language = SUPPORTED_LANGUAGES.includes(local?.language) ? local.language : 'en';
  const showCache = local?.showCache !== false;
  const showCost = local?.showCost === true;
  return { language, showCache, showCost };
}

export function savePreferences(dataDir, patch) {
  const current = readJsonSafe(preferencesFilePath(dataDir), {});
  const next = { ...current };
  if (patch.language !== undefined) {
    if (!SUPPORTED_LANGUAGES.includes(patch.language)) {
      throw new Error(`Unsupported language: ${patch.language}`);
    }
    next.language = patch.language;
  }
  for (const key of ['showCache', 'showCost']) {
    if (typeof patch[key] === 'boolean') next[key] = patch[key];
  }
  next.updatedAt = new Date().toISOString();
  writeJsonAtomic(preferencesFilePath(dataDir), next);
  return next;
}
