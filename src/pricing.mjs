import path from 'node:path';
import { readJsonSafe } from './store.mjs';

/**
 * Reference API pricing in USD per 1,000,000 tokens.
 * Subscription tiers (Pro / Enterprise) consume quota rather than direct per-token billing;
 * these rates provide transparent API-equivalent cost and cache-savings estimates.
 * Users can override or extend rules in `$DATA_DIR/pricing.json`.
 */
export const DEFAULT_PRICING_RULES = [
  // Gemini 4 / 3 / 2.5 flagship & reasoning tiers (Pro / Neon / Argon / Carbon / Ultra)
  {
    id: 'gemini-argon',
    pattern: /gemini.*argon/i,
    input: 2.5,
    cacheRead: 0.25,
    cacheWrite: 2.5,
    output: 15.0,
  },
  {
    id: 'gemini-carbon',
    pattern: /gemini.*carbon/i,
    input: 2.0,
    cacheRead: 0.2,
    cacheWrite: 2.0,
    output: 12.0,
  },
  {
    id: 'gemini-neon',
    pattern: /gemini.*neon/i,
    input: 1.25,
    cacheRead: 0.125,
    cacheWrite: 1.25,
    output: 10.0,
  },
  {
    id: 'gemini-pro',
    pattern: /gemini.*pro/i,
    input: 1.25,
    cacheRead: 0.125,
    cacheWrite: 1.25,
    output: 10.0,
  },
  // Gemini fast / lightweight tiers (Flash / Hydrogen / Lite)
  {
    id: 'gemini-flash-lite',
    pattern: /gemini.*flash.*lite/i,
    input: 0.1,
    cacheRead: 0.01,
    cacheWrite: 0.1,
    output: 0.4,
  },
  {
    id: 'gemini-hydrogen',
    pattern: /gemini.*hydrogen/i,
    input: 0.3,
    cacheRead: 0.03,
    cacheWrite: 0.3,
    output: 2.5,
  },
  {
    id: 'gemini-flash',
    pattern: /gemini.*flash/i,
    input: 0.3,
    cacheRead: 0.03,
    cacheWrite: 0.3,
    output: 2.5,
  },
  // Anthropic Claude models
  {
    id: 'claude-opus',
    pattern: /claude.*opus/i,
    input: 15.0,
    cacheRead: 1.5,
    cacheWrite: 18.75,
    output: 75.0,
  },
  {
    id: 'claude-sonnet',
    pattern: /claude.*sonnet/i,
    input: 3.0,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    output: 15.0,
  },
  {
    id: 'claude-haiku',
    pattern: /claude.*haiku/i,
    input: 0.8,
    cacheRead: 0.08,
    cacheWrite: 1.0,
    output: 4.0,
  },
  // OpenAI / 3P models
  {
    id: 'gpt-oss',
    pattern: /gpt-oss/i,
    input: 0.15,
    cacheRead: 0.03,
    cacheWrite: 0.15,
    output: 0.6,
  },
  {
    id: 'gpt-5',
    pattern: /gpt-5/i,
    input: 1.25,
    cacheRead: 0.125,
    cacheWrite: 1.25,
    output: 10.0,
  },
  {
    id: 'gpt-4o-mini',
    pattern: /gpt-4o-mini/i,
    input: 0.15,
    cacheRead: 0.075,
    cacheWrite: 0.15,
    output: 0.6,
  },
  {
    id: 'gpt-4o',
    pattern: /gpt-4o/i,
    input: 2.5,
    cacheRead: 1.25,
    cacheWrite: 2.5,
    output: 10.0,
  },
  {
    id: 'o-series',
    pattern: /\bo[134](?:-|$)/i,
    input: 2.0,
    cacheRead: 0.5,
    cacheWrite: 2.0,
    output: 8.0,
  },
];

export function pricingFilePath(dataDir) {
  return path.join(dataDir, 'pricing.json');
}

export function loadCustomPricing(dataDir) {
  const data = readJsonSafe(pricingFilePath(dataDir), null);
  if (!data || typeof data !== 'object') return {};
  const rates = data.models && typeof data.models === 'object' ? data.models : data;
  const cleaned = {};
  for (const [key, val] of Object.entries(rates)) {
    if (!val || typeof val !== 'object') continue;
    const input = Number(val.input);
    const output = Number(val.output);
    const cacheRead = val.cacheRead !== undefined ? Number(val.cacheRead) : input * 0.1;
    const cacheWrite = val.cacheWrite !== undefined ? Number(val.cacheWrite) : input;
    if (
      Number.isFinite(input) &&
      input >= 0 &&
      Number.isFinite(output) &&
      output >= 0 &&
      Number.isFinite(cacheRead) &&
      cacheRead >= 0 &&
      Number.isFinite(cacheWrite) &&
      cacheWrite >= 0
    ) {
      cleaned[key.toLowerCase()] = { id: key, input, cacheRead, cacheWrite, output };
    }
  }
  return cleaned;
}

export function resolveModelPricing(modelName, customRates = {}) {
  const normalized = String(modelName || '').trim().toLowerCase();
  if (!normalized) return null;

  // Exact match in user overrides first, then substring match.
  if (customRates[normalized]) return customRates[normalized];
  for (const [key, rate] of Object.entries(customRates)) {
    if (normalized.includes(key)) return rate;
  }

  for (const rule of DEFAULT_PRICING_RULES) {
    if (rule.pattern.test(normalized)) {
      return {
        id: rule.id,
        input: rule.input,
        cacheRead: rule.cacheRead,
        cacheWrite: rule.cacheWrite,
        output: rule.output,
      };
    }
  }
  return null;
}

export function estimateTokenCost(
  modelName,
  { inputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0, outputTokens = 0 },
  customRates = {}
) {
  const rate = resolveModelPricing(modelName, customRates);
  if (!rate) {
    return {
      known: false,
      tier: null,
      estimatedUsd: 0,
      uncachedInputUsd: 0,
      cacheReadUsd: 0,
      cacheWriteUsd: 0,
      outputUsd: 0,
      cacheSavedUsd: 0,
    };
  }

  const perM = 1_000_000;
  const uncachedInputUsd = (inputTokens / perM) * rate.input;
  const cacheReadUsd = (cacheReadTokens / perM) * rate.cacheRead;
  const cacheWriteUsd = (cacheWriteTokens / perM) * rate.cacheWrite;
  const outputUsd = (outputTokens / perM) * rate.output;
  const estimatedUsd = uncachedInputUsd + cacheReadUsd + cacheWriteUsd + outputUsd;
  const cacheSavedUsd = Math.max(0, (cacheReadTokens / perM) * (rate.input - rate.cacheRead));

  return {
    known: true,
    tier: rate.id,
    estimatedUsd,
    uncachedInputUsd,
    cacheReadUsd,
    cacheWriteUsd,
    outputUsd,
    cacheSavedUsd,
  };
}
