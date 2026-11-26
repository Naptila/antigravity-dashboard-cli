#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldUseColor } from '../src/ansi.mjs';
import {
  inspectStatusLine,
  installStatusLine,
  uninstallStatusLine,
} from '../src/lifecycle.mjs';
import { renderUsageReport } from '../src/stats-render.mjs';
import { loadPreferences, resolveDataDir, savePreferences } from '../src/store.mjs';
import { buildUsageReport, defaultBrainDir, syncUsageLedger } from '../src/usage-ledger.mjs';
import { buildSyntheticStatusPayload, runStatusLine } from './statusline.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SOURCE_ROOT = path.resolve(__dirname, '..');

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
                      --tz local|utc+8|utc   Timezone for date grouping (default: local)
                      --rebuild              Force full rescan of brain transcripts
                      --language en|zh-CN|zh-TW
                      --width N  --no-color  --json

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
             Options: --argon  --no-stack  --language ...  --width N  --no-color  --json
  help       Show this help
`;

function normalizeLanguageInput(raw) {
  if (!raw) return null;
  const mapped = LANGUAGE_ALIASES[String(raw).trim().toLowerCase()];
  if (!mapped) {
    throw new Error(`Unsupported language "${raw}". Use en, zh-CN (zh), or zh-TW (tw).`);
  }
  return mapped;
}

function parseFlags(args) {
  const flags = {};
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
    '--rebuild',
    '--help',
    '-h',
  ]);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (boolFlags.has(arg)) {
      flags[arg.replace(/^--?/, '')] = true;
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

function parseBool(value, name) {
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`Expected true or false for --${name}`);
}

function parseIsoDate(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid date for --${name}: "${value}". Expected YYYY-MM-DD.`);
  }
  return value;
}

function main() {
  const rawArgs = process.argv.slice(2);
  let command = 'stats';
  let rest = rawArgs;

  if (rawArgs.length > 0 && !rawArgs[0].startsWith('-')) {
    command = rawArgs[0];
    rest = rawArgs.slice(1);
  }

  if (command === 'help' || rawArgs.includes('--help') || rawArgs.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }

  const { flags, positional } = parseFlags(rest);
  const dataDir = resolveDataDir(flags['data-dir']);

  if (command === 'lang' || command === 'language') {
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
        : normalizeLanguageInput(target);
    const updated = savePreferences(dataDir, { language: nextLang });
    process.stdout.write(`Language switched to: ${updated.language}\n`);
    return;
  }

  if (command === 'stats' || command === 'usage') {
    const prefs = loadPreferences(dataDir);
    const language = flags.language ? normalizeLanguageInput(flags.language) : prefs.language;
    const groupBy = flags.by || 'day';
    if (!['day', 'week', 'month'].includes(groupBy)) {
      throw new Error(`Invalid --by value "${groupBy}". Expected day, week, or month.`);
    }

    let days = 14;
    if (flags.days !== undefined) {
      if (flags.days.toLowerCase() === 'all') {
        days = 'all';
      } else {
        const parsedDays = Number(flags.days);
        if (!Number.isInteger(parsedDays) || parsedDays < 1 || parsedDays > 3650) {
          throw new Error(`Invalid --days value: ${flags.days}`);
        }
        days = parsedDays;
      }
    }

    const from = flags.from ? parseIsoDate(flags.from, 'from') : null;
    const to = flags.to ? parseIsoDate(flags.to, 'to') : null;
    const brainDir = flags['brain-dir'] || defaultBrainDir(flags.home);

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

    const width = flags.width ? Number(flags.width) : process.stdout.columns || 110;
    const output = renderUsageReport(report, {
      language,
      width,
      color: shouldUseColor(Boolean(flags['no-color'])),
    });
    process.stdout.write(output + '\n');
    return;
  }

  if (command === 'preview') {
    const width = flags.width ? Number(flags.width) : undefined;
    if (width !== undefined && (!Number.isInteger(width) || width < 20 || width > 500)) {
      throw new Error(`Invalid width: ${flags.width}`);
    }
    const language = flags.language ? normalizeLanguageInput(flags.language) : undefined;
    const sample = buildSyntheticStatusPayload(Boolean(flags.argon));
    const output = runStatusLine(sample, {
      synthetic: true,
      stacked: !flags['no-stack'],
      language,
      width,
      noColor: Boolean(flags['no-color']),
      json: Boolean(flags.json),
      dataDir: flags['data-dir'],
    });
    process.stdout.write(output + '\n');
    return;
  }

  if (command === 'install') {
    const language = flags.language ? normalizeLanguageInput(flags.language) : null;
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
    process.stdout.write(`Updated settings: ${res.settingsFile} (stack_with_default: ${res.stacked})\n`);
    process.stdout.write(`Reopen agy (or run /statusline on) to activate.\n`);
    return;
  }

  if (command === 'uninstall') {
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
    const info = inspectStatusLine({ homeDir: flags.home, dataDir: flags['data-dir'] });
    const preferences = loadPreferences(info.dataDir);
    process.stdout.write(JSON.stringify({ ...info, preferences }, null, 2) + '\n');
    return;
  }

  if (command === 'config') {
    const patch = {};
    if (flags.language !== undefined) patch.language = normalizeLanguageInput(flags.language);
    if (flags['show-cache'] !== undefined) patch.showCache = parseBool(flags['show-cache'], 'show-cache');
    if (flags['show-cost'] !== undefined) patch.showCost = parseBool(flags['show-cost'], 'show-cost');

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

try {
  main();
} catch (err) {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exitCode = 1;
}
