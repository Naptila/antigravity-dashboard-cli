// @ts-check
import { DEFAULT_LANGUAGE, LANGUAGE_ALIASES, SUPPORTED_LANGUAGES } from './constants.mjs';

/**
 * Normalizes a language identifier or alias (`en`, `zh`, `zh-CN`, `tw`, `zh-TW`)
 * to a supported canonical language code, or returns `null` if unrecognized.
 * @param {unknown} raw
 * @returns {'en' | 'zh-CN' | 'zh-TW' | null}
 */
export function normalizeLanguage(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (SUPPORTED_LANGUAGES.includes(/** @type {any} */ (trimmed))) {
    return /** @type {'en' | 'zh-CN' | 'zh-TW'} */ (trimmed);
  }
  const key = trimmed.toLowerCase();
  return Object.hasOwn(LANGUAGE_ALIASES, key) ? LANGUAGE_ALIASES[key] : null;
}

/**
 * Parses a language input strictly, throwing a descriptive Error if unsupported.
 * @param {unknown} raw
 * @returns {'en' | 'zh-CN' | 'zh-TW'}
 */
export function parseLanguageStrict(raw) {
  const normalized = normalizeLanguage(raw);
  if (!normalized) {
    throw new Error(`Invalid language "${String(raw ?? '')}". Use en, zh-CN (zh), or zh-TW (tw).`);
  }
  return normalized;
}

/**
 * Resolves a language input with a safe default fallback (`'en'`).
 * @param {unknown} raw
 * @param {'en' | 'zh-CN' | 'zh-TW'} [fallback=DEFAULT_LANGUAGE]
 * @returns {'en' | 'zh-CN' | 'zh-TW'}
 */
export function resolveLanguage(raw, fallback = DEFAULT_LANGUAGE) {
  return normalizeLanguage(raw) || fallback;
}

/**
 * Formats non-negative token counts into compact human-readable strings (`1.2K`, `3.4M`).
 * @param {unknown} value
 * @returns {string}
 */
export function compactNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '--';
  /** @type {Array<[number, string, number, string]>} */
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

/**
 * Formats a finite percentage with at most 1 decimal place.
 * @param {unknown} value
 * @returns {string}
 */
export function formatPercentage(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '--';
  return `${Number(value.toFixed(1))}%`;
}

/**
 * Formats a non-negative USD value concisely (`$0.00`, `<$0.01`, `$1.25`, `$14.2`, `$120`).
 * @param {unknown} usd
 * @returns {string | null}
 */
export function formatUsd(usd) {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) return null;
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  if (usd < 10) return `$${usd.toFixed(2)}`;
  if (usd < 100) return `$${usd.toFixed(1)}`;
  return `$${Math.round(usd)}`;
}
