// @ts-check
import { shouldUseColor } from './ansi.mjs';
import { normalizeLanguage, resolveLanguage } from './i18n.mjs';
import { renderUsageReport } from './stats-render.mjs';
import { defaultBrainDir, loadPreferences, resolveDataDir, savePreferences } from './store.mjs';
import { syncUsageLedger } from './transcript-reader.mjs';
import { buildUsageReport, isValidIsoDate, resolveTimezoneSpec } from './usage-aggregator.mjs';

/**
 * @typedef {{
 *   days: number | 'all',
 *   groupBy: 'day' | 'week' | 'month',
 *   from: string | null,
 *   to: string | null,
 *   modelFilter: string | null,
 *   tz: string,
 *   language: 'en' | 'zh-CN' | 'zh-TW' | null,
 *   rebuild: boolean,
 * }} ParsedStatsOptions
 *
 * @typedef {{ kind: 'lang', target: 'en' | 'zh-CN' | 'zh-TW' | 'toggle' | null } | { kind: 'stats', opts: ParsedStatsOptions }} ParsedConsoleCommand
 */

/** @param {string} tzRaw */
function isSupportedConsoleTimezone(tzRaw) {
  try {
    resolveTimezoneSpec(tzRaw);
    return true;
  } catch {
    return false;
  }
}

/**
 * Strictly parses explicit console slash commands:
 *   `/stats [7|14|30|all] [day|week|month] [--days N|all] [--by day|week|month]`
 *          `[--from YYYY-MM-DD] [--to YYYY-MM-DD] [--model substr] [--tz local|utc+8|utc|IANA]`
 *          `[--language en|zh-CN|zh-TW] [--rebuild]`
 *   `/dstats ...` | `/dash:stats ...` | `/dashboard stats ...`
 *   `/lang [en|zh|zh-CN|tw|zh-TW|toggle]`
 *   `/dlang ...`  | `/dash:lang ...`  | `/dashboard lang ...`
 *
 * Returns `null` for any free-form natural language prompt so normal conversation is never intercepted.
 * @param {unknown} rawInput
 * @returns {ParsedConsoleCommand | null}
 */
export function parseConsoleCommand(rawInput) {
  if (typeof rawInput !== 'string') return null;
  const reqMatch = rawInput.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  const trimmed = (reqMatch ? reqMatch[1] : rawInput).trim();
  if (!trimmed.startsWith('/') || trimmed.includes('\n')) return null;

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  // Strip plugin namespace prefix inserted by agy's slash-command picker (e.g. /dash:stats).
  const head = tokens[0].toLowerCase().replace(/^\/[a-z0-9_-]+:/, '/');
  /** @type {'stats' | 'lang' | null} */
  let kind = null;
  /** @type {string[]} */
  let args = [];

  if (head === '/stats' || head === '/dstats') {
    kind = 'stats';
    args = tokens.slice(1);
  } else if (head === '/lang' || head === '/dlang') {
    kind = 'lang';
    args = tokens.slice(1);
  } else if (head === '/dashboard' && tokens.length >= 2) {
    const sub = tokens[1].toLowerCase();
    if (sub === 'stats' || sub === 'usage') {
      kind = 'stats';
      args = tokens.slice(2);
    } else if (sub === 'lang' || sub === 'language') {
      kind = 'lang';
      args = tokens.slice(2);
    } else {
      return null;
    }
  } else {
    return null;
  }

  if (kind === 'lang') {
    if (args.length === 0) return { kind: 'lang', target: null };
    if (args.length > 1) return null;
    const raw = args[0].toLowerCase();
    if (raw === 'toggle') return { kind: 'lang', target: 'toggle' };
    const mapped = normalizeLanguage(raw);
    if (!mapped) return null;
    return { kind: 'lang', target: mapped };
  }

  /** @type {ParsedStatsOptions} */
  const opts = {
    days: 14,
    groupBy: 'day',
    from: null,
    to: null,
    modelFilter: null,
    tz: 'local',
    language: null,
    rebuild: false,
  };

  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    const lower = tok.toLowerCase();
    if (lower === '--rebuild') {
      opts.rebuild = true;
    } else if (lower === '--days') {
      const val = args[++i];
      if (!val) return null;
      if (val.toLowerCase() === 'all') {
        opts.days = 'all';
      } else if (/^\d{1,4}$/.test(val)) {
        const n = Number(val);
        if (n < 1 || n > 3650) return null;
        opts.days = n;
      } else {
        return null;
      }
    } else if (lower === '--by') {
      const val = args[++i]?.toLowerCase();
      if (val !== 'day' && val !== 'week' && val !== 'month') return null;
      opts.groupBy = val;
    } else if (lower === '--from') {
      const val = args[++i];
      if (!val || !isValidIsoDate(val)) return null;
      opts.from = val;
    } else if (lower === '--to') {
      const val = args[++i];
      if (!val || !isValidIsoDate(val)) return null;
      opts.to = val;
    } else if (lower === '--model') {
      const val = args[++i];
      if (!val || val.startsWith('-')) return null;
      opts.modelFilter = val;
    } else if (lower === '--tz') {
      const val = args[++i];
      if (!val || !isSupportedConsoleTimezone(val)) return null;
      opts.tz = val;
    } else if (lower === '--language' || lower === '--lang') {
      const val = normalizeLanguage(args[++i]);
      if (!val) return null;
      opts.language = val;
    } else if (lower === 'all') {
      opts.days = 'all';
    } else if (/^\d{1,4}d?$/.test(lower)) {
      const n = Number(lower.replace(/d$/, ''));
      if (n < 1 || n > 3650) return null;
      opts.days = n;
    } else if (lower === 'day' || lower === 'week' || lower === 'month') {
      opts.groupBy = lower;
    } else if (normalizeLanguage(lower)) {
      opts.language = normalizeLanguage(lower);
    } else {
      return null;
    }
  }

  if (opts.from && opts.to && opts.from > opts.to) {
    return null;
  }

  return { kind: 'stats', opts };
}

/**
 * Note: `agy`'s Go hook unmarshaler currently panics on `systemMessage.metadata.user_markdown`
 * ("type mismatch: cannot convert string to message"). Using `errorMessage.userMessage` with
 * `terminationBehavior: "terminate"` renders immediately inline in the TUI without calling the
 * model and without polluting conversation context.
 * @param {string} text
 */
function buildInlineTerminateResponse(text) {
  return {
    injectSteps: [
      {
        errorMessage: {
          userMessage: text,
        },
      },
    ],
    terminationBehavior: 'terminate',
  };
}

/**
 * Executes a parsed `/dash:stats` or `/dash:lang` console command locally.
 * @param {ParsedConsoleCommand | null} parsed
 * @param {{ dataDir?: string, brainDir?: string, now?: number, width?: number, env?: NodeJS.ProcessEnv }} [opts]
 */
export function executeConsoleCommand(
  parsed,
  {
    dataDir = resolveDataDir(),
    brainDir = defaultBrainDir(),
    now = Date.now(),
    width = 80,
    env = process.env,
  } = {}
) {
  if (!parsed) return null;
  const color = shouldUseColor(false, env);

  if (parsed.kind === 'lang') {
    const current = loadPreferences(dataDir);
    if (!parsed.target) {
      const title = color
        ? `\x1b[0m\x1b[1;36mAntigravity Stats Language:\x1b[0m ${current.language}`
        : `Antigravity Stats Language: ${current.language}`;
      const msg =
        `${title}\n` +
        `Switch live:\n` +
        `  /dash:lang en      — English (default)\n` +
        `  /dash:lang zh      — 简体中文 (zh-CN)\n` +
        `  /dash:lang tw      — 繁體中文 (zh-TW)\n` +
        `  /dash:lang toggle  — Toggle en <-> zh-CN`;
      return buildInlineTerminateResponse(msg);
    }

    const nextLang =
      parsed.target === 'toggle'
        ? current.language === 'en'
          ? 'zh-CN'
          : 'en'
        : parsed.target;
    savePreferences(dataDir, { language: nextLang });

    const msg = color
      ? nextLang === 'zh-CN'
        ? '\x1b[0m\x1b[32m✓\x1b[0m 已切换统计语言为 \x1b[1;36m简体中文 (zh-CN)\x1b[0m，下次 /dash:stats 立即生效。'
        : nextLang === 'zh-TW'
          ? '\x1b[0m\x1b[32m✓\x1b[0m 已切換統計語言為 \x1b[1;36m繁體中文 (zh-TW)\x1b[0m，下次 /dash:stats 立即生效。'
          : '\x1b[0m\x1b[32m✓\x1b[0m Switched stats language to \x1b[1;36mEnglish (en)\x1b[0m.'
      : nextLang === 'zh-CN'
        ? '✓ 已切换统计语言为 简体中文 (zh-CN)，下次 /dash:stats 立即生效。'
        : nextLang === 'zh-TW'
          ? '✓ 已切換統計語言為 繁體中文 (zh-TW)，下次 /dash:stats 立即生效。'
          : '✓ Switched stats language to English (en).';

    return buildInlineTerminateResponse(msg);
  }

  if (parsed.kind === 'stats') {
    const prefs = loadPreferences(dataDir);
    const language = resolveLanguage(parsed.opts.language || prefs.language);
    const { ledger } = syncUsageLedger({
      dataDir,
      brainDir,
      rebuild: parsed.opts.rebuild,
      now,
    });
    const report = buildUsageReport(ledger, {
      dataDir,
      days: parsed.opts.days,
      from: parsed.opts.from,
      to: parsed.opts.to,
      groupBy: parsed.opts.groupBy,
      modelFilter: parsed.opts.modelFilter,
      tz: parsed.opts.tz,
      now,
    });
    const prefix = color ? '\x1b[0m' : '';
    const rendered = prefix + renderUsageReport(report, { language, width, color });
    return buildInlineTerminateResponse(rendered);
  }

  return null;
}
