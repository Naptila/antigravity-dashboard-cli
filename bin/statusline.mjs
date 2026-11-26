#!/usr/bin/env node
// @ts-check
import { shouldUseColor } from '../src/ansi.mjs';
import { parseLanguageStrict, resolveLanguage } from '../src/i18n.mjs';
import { normalizeStatusPayload, renderMinimalStatusLine } from '../src/statusline-core.mjs';
import {
  loadPreferences,
  readCliContextOverrides,
  readStdinJson,
  resolveDataDir,
} from '../src/store.mjs';

const HELP = `Antigravity CLI Minimal StatusLine (Node.js 20+)
Reads official Antigravity CLI statusLine JSON from stdin and renders a clean minimalist bar.

Options:
  --preview                 Render synthetic preview (no state written)
  --preview-argon           Render synthetic Argon preview
  --no-stack                Include second metadata row (when not stacked with built-in bar)
  --language en|zh-CN|zh-TW Override language preference (aliases: zh, tw)
  --show-cache true|false   Override cache segment visibility
  --show-cost true|false    Override session cost segment visibility
  --width 20..500           Override terminal width
  --data-dir <path>         Override preferences directory
  --no-color                Disable ANSI colors
  --json                    Print normalized, whitelisted metrics JSON
  --help                    Show this help
`;

/**
 * @param {string | undefined} value
 * @param {string} flag
 */
function parseBoolArg(value, flag) {
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`Expected true or false for ${flag}`);
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, any>} */
  const opts = { stacked: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--preview') opts.preview = true;
    else if (arg === '--preview-argon') opts.previewArgon = true;
    else if (arg === '--no-stack') opts.stacked = false;
    else if (arg === '--no-color') opts.noColor = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--language') {
      const value = argv[++i];
      opts.language = parseLanguageStrict(value);
    } else if (arg === '--show-cache') {
      opts.showCache = parseBoolArg(argv[++i], '--show-cache');
    } else if (arg === '--show-cost') {
      opts.showCost = parseBoolArg(argv[++i], '--show-cost');
    } else if (arg === '--width') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 20 || value > 500) {
        throw new Error(`Invalid width: ${value}`);
      }
      opts.width = value;
    } else if (arg === '--data-dir') {
      const value = argv[++i];
      if (!value) throw new Error('Missing value for --data-dir');
      opts.dataDir = value;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

/**
 * Builds synthetic `agy` statusLine payload for `--preview` / `--preview-argon`.
 * @param {boolean} [argon=false]
 * @param {number} [now=Date.now()]
 */
export function buildSyntheticStatusPayload(argon = false, now = Date.now()) {
  /** @type {Record<string, any>} */
  const payload = {
    version: '1.5.11',
    model: {
      id: argon ? 'gemini-4-argon-high' : 'gemini-4-neon-high',
      display_name: argon ? 'Gemini 4 Argon (High)' : 'Gemini 4 Neon (High)',
      effort: 'high',
    },
    agent_state: 'idle',
    cycle_mode: 'auto',
    task_count: 1,
    subagents: [
      { name: 'researcher', state: 'working' },
      { name: 'coder', state: 'working' },
      { name: 'verifier', state: 'working' },
    ],
    terminal_width: 100,
    context_window: {
      used_percentage: 18.6,
      context_window_size: 1048576,
      current_usage: {
        input_tokens: 11200,
        cache_read_input_tokens: 183400,
        cache_creation_input_tokens: 0,
        output_tokens: 612,
      },
    },
    cost: { total_usd: 0.18, estimated: true },
    quota: {
      'gemini-5h': {
        remaining_fraction: 0.72,
        reset_in_seconds: 8100,
        reset_time: new Date(now + 8100 * 1000).toISOString(),
      },
      'gemini-weekly': {
        remaining_fraction: 0.94,
        reset_in_seconds: 560580,
        reset_time: new Date(now + 560580 * 1000).toISOString(),
      },
      '3p-5h': {
        remaining_fraction: 0.18,
        reset_in_seconds: 5400,
        reset_time: new Date(now + 5400 * 1000).toISOString(),
      },
      '3p-weekly': {
        remaining_fraction: 0.4,
        reset_in_seconds: 172800,
        reset_time: new Date(now + 172800 * 1000).toISOString(),
      },
    },
  };
  if (argon) {
    payload.quota['gemini-argon-wtu-weekly'] = {
      remaining_fraction: 0.41,
      reset_in_seconds: 345600,
      reset_time: new Date(now + 345600 * 1000).toISOString(),
    };
  }
  return payload;
}

/**
 * Normalizes and renders a statusLine payload.
 * @param {any} payload
 * @param {{
 *   synthetic?: boolean,
 *   stacked?: boolean,
 *   language?: string,
 *   width?: number,
 *   noColor?: boolean,
 *   json?: boolean,
 *   showCache?: boolean,
 *   showCost?: boolean,
 *   dataDir?: string,
 *   env?: NodeJS.ProcessEnv,
 * }} [opts]
 * @param {number} [now=Date.now()]
 * @returns {string}
 */
export function runStatusLine(payload, opts = {}, now = Date.now()) {
  const env = opts.env || process.env;
  const dataDir = resolveDataDir(opts.dataDir || null, env);
  const prefs = loadPreferences(dataDir);
  const language = resolveLanguage(opts.language || prefs.language);
  const projectDir = payload?.workspace?.project_dir || payload?.cwd || null;
  const overrides = opts.synthetic
    ? { autoCompactOverrideRaw: null, configuredContextWindow: null }
    : readCliContextOverrides({ env, projectDir });

  const metrics = normalizeStatusPayload(payload, {
    autoCompactOverride: overrides.autoCompactOverrideRaw,
    configuredContextWindow: overrides.configuredContextWindow,
  });

  if (opts.json) return JSON.stringify(metrics);

  return renderMinimalStatusLine(metrics, {
    language,
    width: opts.width || metrics.width,
    color: shouldUseColor(Boolean(opts.noColor), env),
    stacked: opts.stacked !== false,
    showCache: typeof opts.showCache === 'boolean' ? opts.showCache : prefs.showCache,
    showCost: typeof opts.showCost === 'boolean' ? opts.showCost : prefs.showCost,
    now,
  });
}

async function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      process.stdout.write(HELP);
      return;
    }
    const payload =
      opts.preview || opts.previewArgon
        ? buildSyntheticStatusPayload(Boolean(opts.previewArgon))
        : await readStdinJson({ allowEmpty: false });
    const output = runStatusLine(payload, {
      ...opts,
      synthetic: Boolean(opts.preview || opts.previewArgon),
    });
    process.stdout.write(output + '\n');
  } catch {
    process.stdout.write('ctx --\n');
    process.exitCode = 1;
  }
}

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('statusline.mjs') || process.argv[1].includes('statusline.mjs'));
if (isDirectRun) {
  main();
}
