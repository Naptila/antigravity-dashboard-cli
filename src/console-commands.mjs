import { renderUsageReport } from './stats-render.mjs';
import { loadPreferences, resolveDataDir, savePreferences } from './store.mjs';
import { buildUsageReport, defaultBrainDir, syncUsageLedger } from './usage-ledger.mjs';

const LANGUAGE_ALIASES = {
  en: 'en',
  english: 'en',
  zh: 'zh-CN',
  cn: 'zh-CN',
  'zh-cn': 'zh-CN',
  'zh_cn': 'zh-CN',
  tw: 'zh-TW',
  'zh-tw': 'zh-TW',
  'zh_tw': 'zh-TW',
};

function normalizeLang(raw) {
  if (!raw) return null;
  return LANGUAGE_ALIASES[String(raw).trim().toLowerCase()] || null;
}

/**
 * Strictly parses explicit console slash commands:
 *   /stats [7|14|30|all] [day|week|month] [--days N|all] [--by day|week|month]
 *          [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--model substr] [--tz local|utc+8|utc]
 *          [--language en|zh-CN|zh-TW] [--rebuild]
 *   /dstats ... (alias)
 *   /dashboard stats ...
 *   /lang [en|zh|zh-CN|tw|zh-TW|toggle]
 *   /dlang ... (alias)
 *   /dashboard lang ...
 *
 * Returns null for any free-form natural language prompt so normal conversation is never intercepted.
 */
export function parseConsoleCommand(rawInput) {
  if (typeof rawInput !== 'string') return null;
  // Extract <USER_REQUEST>...</USER_REQUEST> if wrapped, otherwise use raw text.
  const reqMatch = rawInput.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  const trimmed = (reqMatch ? reqMatch[1] : rawInput).trim();
  if (!trimmed.startsWith('/') || trimmed.includes('\n')) return null;

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  // Strip plugin namespace prefix inserted by agy's slash-command picker (e.g. /antigravity-dashboard-cli:stats).
  const head = tokens[0].toLowerCase().replace(/^\/[a-z0-9_-]+:/, '/');
  let kind = null;
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
    const mapped = normalizeLang(raw);
    if (!mapped) return null;
    return { kind: 'lang', target: mapped };
  }

  // Parse strict /stats arguments; reject unknown/natural-language words.
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
      if (val.toLowerCase() === 'all') opts.days = 'all';
      else if (/^\d{1,4}$/.test(val) && Number(val) >= 1) opts.days = Number(val);
      else return null;
    } else if (lower === '--by') {
      const val = args[++i]?.toLowerCase();
      if (!['day', 'week', 'month'].includes(val)) return null;
      opts.groupBy = val;
    } else if (lower === '--from') {
      const val = args[++i];
      if (!val || !/^\d{4}-\d{2}-\d{2}$/.test(val)) return null;
      opts.from = val;
    } else if (lower === '--to') {
      const val = args[++i];
      if (!val || !/^\d{4}-\d{2}-\d{2}$/.test(val)) return null;
      opts.to = val;
    } else if (lower === '--model') {
      const val = args[++i];
      if (!val || val.startsWith('-')) return null;
      opts.modelFilter = val;
    } else if (lower === '--tz') {
      const val = args[++i];
      if (!val || !/^(?:local|utc|gmt|(?:utc|gmt)?[+-]\d{1,2}(?::?\d{2})?)$/i.test(val)) return null;
      opts.tz = val;
    } else if (lower === '--language' || lower === '--lang') {
      const val = normalizeLang(args[++i]);
      if (!val) return null;
      opts.language = val;
    } else if (lower === 'all') {
      opts.days = 'all';
    } else if (/^\d{1,4}d?$/.test(lower)) {
      const n = Number(lower.replace(/d$/, ''));
      if (n < 1 || n > 3650) return null;
      opts.days = n;
    } else if (['day', 'week', 'month'].includes(lower)) {
      opts.groupBy = lower;
    } else if (normalizeLang(lower)) {
      opts.language = normalizeLang(lower);
    } else {
      // Unrecognized natural language word: do not intercept.
      return null;
    }
  }

  return { kind: 'stats', opts };
}

function buildInlineTerminateResponse(text) {
  // Note: agy's Go hook unmarshaler currently panics on systemMessage.metadata.user_markdown
  // ("type mismatch: cannot convert string to message"). Using errorMessage.userMessage with
  // terminationBehavior:"terminate" renders immediately inline in the TUI without calling the
  // model and without polluting the model's conversation context.
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

export function executeConsoleCommand(
  parsed,
  { dataDir = resolveDataDir(), brainDir = defaultBrainDir(), now = Date.now() } = {}
) {
  if (!parsed) return null;

  if (parsed.kind === 'lang') {
    const current = loadPreferences(dataDir);
    if (!parsed.target) {
      const msg =
        `\x1b[0m\x1b[1;36mAntigravity Stats Language:\x1b[0m ${current.language}\n` +
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
    const msg =
      nextLang === 'zh-CN'
        ? '\x1b[0m\x1b[32m✓\x1b[0m 已切换统计语言为 \x1b[1;36m简体中文 (zh-CN)\x1b[0m，下次 /dash:stats 立即生效。'
        : nextLang === 'zh-TW'
          ? '\x1b[0m\x1b[32m✓\x1b[0m 已切換統計語言為 \x1b[1;36m繁體中文 (zh-TW)\x1b[0m，下次 /dash:stats 立即生效。'
          : '\x1b[0m\x1b[32m✓\x1b[0m Switched stats language to \x1b[1;36mEnglish (en)\x1b[0m.';

    return buildInlineTerminateResponse(msg);
  }

  if (parsed.kind === 'stats') {
    const prefs = loadPreferences(dataDir);
    const language = parsed.opts.language || prefs.language || 'en';
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
    const rendered = '\x1b[0m' + renderUsageReport(report, { language, width: 80, color: true });
    return buildInlineTerminateResponse(rendered);
  }

  return null;
}
