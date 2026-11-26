#!/usr/bin/env node
// @ts-check
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldUseColor } from '../src/ansi.mjs';
import { PLUGIN_VERSION } from '../src/constants.mjs';
import { parseLanguageStrict, resolveLanguage } from '../src/i18n.mjs';
import {
  inspectStatusLine,
  installStatusLine,
  uninstallStatusLine,
} from '../src/lifecycle.mjs';
import { renderUsageReport, renderUsageReportMarkdown } from '../src/stats-render.mjs';
import { defaultBrainDir, loadPreferences, resolveDataDir, savePreferences } from '../src/store.mjs';
import { syncUsageLedger } from '../src/transcript-reader.mjs';
import { buildUsageReport, parseIsoDateStrict } from '../src/usage-aggregator.mjs';
import { buildSyntheticStatusPayload, runStatusLine } from './statusline.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SOURCE_ROOT = path.resolve(__dirname, '..');

const HELP = `Antigravity Dashboard CLI (dash)

Usage:
  node bin/cli.mjs <command> [options]

Commands:
  stats      Show cumulative tokens, cached tokens, and estimated spend by date & model
             (default command if omitted; alias: usage)
             Options: --days 14|30|all       Date window (default: 14)
                      --from YYYY-MM-DD      Start date (inclusive)
                      --to YYYY-MM-DD        End date (inclusive)
                      --by day|week|month    Grouping granularity (default: day)
                      --model <substr>       Filter by model name substring
                      --tz local|utc+8|IANA  Timezone for date grouping (default: local)
                      --rebuild              Force full rescan of brain transcripts
                      --language en|zh-CN|zh-TW
                      --width N  --no-color  --markdown (--md)  --json

  lang       Show or switch language live for both statusLine & /dash:stats (default: en)
             Usage:   node bin/cli.mjs lang [en|zh-CN|zh-TW|zh|tw|toggle]

  install    Install minimalist statusLine into ~/.gemini/antigravity-cli/settings.json
             (stacks with agy's native status bar by default; backs up prior statusLine)
             Options: --no-stack             Replace native bar instead of stacking
                      --language en|zh-CN|zh-TW
                      --no-color             Disable ANSI colors
                      --node /path/to/node   Explicit Node.js 20+ binary
  uninstall  Remove installed statusLine and restore previous settings.json entry
  status     Inspect statusLine installation state and active preferences (JSON)
  config     Update live statusLine preferences without reinstalling
             Options: --language en|zh-CN|zh-TW
                      --show-cache true|false  --show-cost true|false
  preview    Preview minimalist statusLine with synthetic data
             Options: --argon  --no-stack  --show-cache true|false  --show-cost true|false
                      --language ...  --width N  --no-color  --json
  help       Show this help
`;

/** @type {Record<string, ReadonlySet<string>>} */
const COMMAND_ALLOWED_FLAGS = {
  stats: new Set([
    'days',
    'from',
    'to',
    'by',
    'model',
    'tz',
    'rebuild',
    'language',
    'width',
    'no-color',
    'markdown',
    'json',
    'data-dir',
    'brain-dir',
    'home',
  ]),
  lang: new Set(['language', 'data-dir', 'home']),
  preview: new Set([
    'argon',
    'no-stack',
    'language',
    'width',
    'no-color',
    'json',
    'show-cache',
    'show-cost',
    'data-dir',
    'home',
  ]),
  install: new Set(['no-stack', 'language', 'no-color', 'node', 'home', 'data-dir']),
  uninstall: new Set(['home']),
  status: new Set(['home', 'data-dir']),
  config: new Set(['language', 'show-cache', 'show-cost', 'data-dir', 'home']),
};

/**
 * Validates that parsed flags and positional arguments are supported by `canonicalCmd`.
 * @param {string} displayCmd
 * @param {string} canonicalCmd
 * @param {Record<string, any>} flags
 * @param {string[]} positional
 * @param {number} [maxPositional=0]
 */
function assertCommandArgs(displayCmd, canonicalCmd, flags, positional, maxPositional = 0) {
  const allowed = COMMAND_ALLOWED_FLAGS[canonicalCmd];
  for (const key of Object.keys(flags)) {
    if (!allowed || !allowed.has(key)) {
      throw new Error(`Option --${key} is not supported by "${displayCmd}".`);
    }
  }
  if (positional.length > maxPositional) {
    throw new Error(`Unexpected positional argument "${positional[maxPositional]}" for "${displayCmd}".`);
  }
}

/** @param {string[]} args */
function parseFlags(args) {
  /** @type {Record<string, any>} */
  const flags = {};
  /** @type {string[]} */
  const positional = [];
  const valueFlags = new Set([
    '--language',
    '--width',
    '--node',
    '--home',
    '--data-dir',
    '--brain-dir',
    '--days',
    '--from',
    '--to',
    '--by',
    '--model',
    '--tz',
    '--show-cache',
    '--show-cost',
  ]);
  const boolFlags = new Set([
    '--argon',
    '--no-stack',
    '--no-color',
    '--json',
    '--markdown',
    '--md',
    '--rebuild',
    '--version',
    '-v',
    '--help',
    '-h',
  ]);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (boolFlags.has(arg)) {
      const key = arg === '--md' ? 'markdown' : arg.replace(/^--?/, '');
      flags[key] = true;
    } else if (valueFlags.has(arg)) {
      const value = args[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      flags[arg.slice(2)] = value;
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { flags, positional };
}

/**
 * @param {string} value
 * @param {string} name
 */
function parseBool(value, name) {
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`Expected true or false for --${name}`);
}

export function runCli(rawArgs = process.argv.slice(2)) {
  let command = 'stats';
  let rest = rawArgs;

  if (rawArgs.length > 0 && !rawArgs[0].startsWith('-')) {
    command = rawArgs[0];
    rest = rawArgs.slice(1);
  }

  if (command === 'version' || rawArgs.includes('--version') || rawArgs.includes('-v')) {
    process.stdout.write(`${PLUGIN_VERSION}\n`);
    return;
  }

  if (command === 'help' || rawArgs.includes('--help') || rawArgs.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }

  const { flags, positional } = parseFlags(rest);
  const dataDir = resolveDataDir(flags['data-dir'], process.env, flags.home || null);

  if (command === 'lang' || command === 'language') {
    assertCommandArgs(command, 'lang', flags, positional, 1);
    const target = positional[0] || flags.language;
    const current = loadPreferences(dataDir);
    if (!target) {
      process.stdout.write(
        `Current language: ${current.language}\n` +
          `Available: en (default), zh-CN (zh), zh-TW (tw)\n` +
          `Switch: node bin/cli.mjs lang <en|zh-CN|zh-TW|toggle>\n`
      );
      return;
    }
    const nextLang =
      String(target).trim().toLowerCase() === 'toggle'
        ? current.language === 'en'
          ? 'zh-CN'
          : 'en'
        : parseLanguageStrict(target);
    const updated = savePreferences(dataDir, { language: nextLang });
    process.stdout.write(`Language switched to: ${updated.language}\n`);
    return;
  }

  if (command === 'stats' || command === 'usage') {
    assertCommandArgs(command, 'stats', flags, positional, 0);
    const prefs = loadPreferences(dataDir);
    const language = flags.language
      ? parseLanguageStrict(flags.language)
      : resolveLanguage(prefs.language);
    const groupBy = flags.by || 'day';
    if (groupBy !== 'day' && groupBy !== 'week' && groupBy !== 'month') {
      throw new Error(`Invalid --by value "${groupBy}". Expected day, week, or month.`);
    }

    /** @type {number | 'all'} */
    let days = 14;
    if (flags.days !== undefined) {
      if (String(flags.days).toLowerCase() === 'all') {
        days = 'all';
      } else {
        const parsedDays = Number(flags.days);
        if (!Number.isInteger(parsedDays) || parsedDays < 1 || parsedDays > 3650) {
          throw new Error(`Invalid --days value: ${flags.days}`);
        }
        days = parsedDays;
      }
    }

    const from = flags.from ? parseIsoDateStrict(flags.from, 'from') : null;
    const to = flags.to ? parseIsoDateStrict(flags.to, 'to') : null;
    const brainDir = flags['brain-dir']
      ? path.resolve(flags['brain-dir'])
      : defaultBrainDir(flags.home || null);

    const { ledger } = syncUsageLedger({
      dataDir,
      brainDir,
      rebuild: Boolean(flags.rebuild),
    });

    const report = buildUsageReport(ledger, {
      dataDir,
      days,
      from,
      to,
      groupBy,
      modelFilter: flags.model || null,
      tz: flags.tz || 'local',
    });

    if (flags.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      return;
    }

    if (flags.markdown) {
      process.stdout.write(renderUsageReportMarkdown(report, { language }) + '\n');
      return;
    }

    const width = flags.width ? Number(flags.width) : process.stdout.columns || 110;
    if (!Number.isFinite(width) || width < 20 || width > 500) {
      throw new Error(`Invalid --width value: ${flags.width}`);
    }
    const output = renderUsageReport(report, {
      language,
      width,
      color: shouldUseColor(Boolean(flags['no-color'])),
    });
    process.stdout.write(output + '\n');
    return;
  }

  if (command === 'preview') {
    assertCommandArgs(command, 'preview', flags, positional, 0);
    const width = flags.width ? Number(flags.width) : undefined;
    if (width !== undefined && (!Number.isInteger(width) || width < 20 || width > 500)) {
      throw new Error(`Invalid width: ${flags.width}`);
    }
    const language = flags.language ? parseLanguageStrict(flags.language) : undefined;
    const showCache =
      flags['show-cache'] !== undefined
        ? parseBool(flags['show-cache'], 'show-cache')
        : undefined;
    const showCost =
      flags['show-cost'] !== undefined ? parseBool(flags['show-cost'], 'show-cost') : undefined;
    const sample = buildSyntheticStatusPayload(Boolean(flags.argon));
    const output = runStatusLine(sample, {
      synthetic: true,
      stacked: !flags['no-stack'],
      language,
      width,
      noColor: Boolean(flags['no-color']),
      json: Boolean(flags.json),
      showCache,
      showCost,
      dataDir,
    });
    process.stdout.write(output + '\n');
    return;
  }

  if (command === 'install') {
    assertCommandArgs(command, 'install', flags, positional, 0);
    const language = flags.language ? parseLanguageStrict(flags.language) : null;
    const res = installStatusLine({
      sourceRoot: SOURCE_ROOT,
      homeDir: flags.home,
      dataDir: flags['data-dir'],
      nodePath: flags.node,
      language,
      stacked: !flags['no-stack'],
      noColor: Boolean(flags['no-color']),
    });
    process.stdout.write(`Installed statusLine runtime: ${res.runtimeDir}\n`);
    process.stdout.write(
      `Updated settings: ${res.settingsFile} (stack_with_default: ${res.stacked})\n`
    );
    process.stdout.write(`Reopen agy (or run /statusline on) to activate.\n`);
    return;
  }

  if (command === 'uninstall') {
    assertCommandArgs(command, 'uninstall', flags, positional, 0);
    const res = uninstallStatusLine({ homeDir: flags.home });
    if (!res.removed) {
      process.stdout.write('Antigravity Dashboard CLI statusLine is not installed.\n');
    } else {
      process.stdout.write(
        res.restored
          ? 'Removed statusLine runtime and restored previous settings.json configuration.\n'
          : 'Removed statusLine runtime (settings.json was already modified externally and left untouched).\n'
      );
    }
    return;
  }

  if (command === 'status') {
    assertCommandArgs(command, 'status', flags, positional, 0);
    const info = inspectStatusLine({ homeDir: flags.home, dataDir: flags['data-dir'] });
    const preferences = loadPreferences(info.dataDir);
    process.stdout.write(JSON.stringify({ ...info, preferences }, null, 2) + '\n');
    return;
  }

  if (command === 'config') {
    assertCommandArgs(command, 'config', flags, positional, 0);
    /** @type {{ language?: string, showCache?: boolean, showCost?: boolean }} */
    const patch = {};
    if (flags.language !== undefined) patch.language = parseLanguageStrict(flags.language);
    if (flags['show-cache'] !== undefined) {
      patch.showCache = parseBool(flags['show-cache'], 'show-cache');
    }
    if (flags['show-cost'] !== undefined) {
      patch.showCost = parseBool(flags['show-cost'], 'show-cost');
    }

    if (Object.keys(patch).length === 0) {
      process.stdout.write(JSON.stringify(loadPreferences(dataDir), null, 2) + '\n');
      return;
    }
    const updated = savePreferences(dataDir, patch);
    process.stdout.write(JSON.stringify(updated, null, 2) + '\n');
    return;
  }

  throw new Error(`Unknown command: ${command}. Run \`node bin/cli.mjs help\` for usage.`);
}

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('cli.mjs') || process.argv[1].includes('agy-dashboard'));

if (isDirectRun) {
  try {
    runCli();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n`);
    process.exitCode = 1;
  }
}
