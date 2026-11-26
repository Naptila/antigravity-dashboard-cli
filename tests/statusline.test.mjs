import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { displayWidth } from '../src/ansi.mjs';
import {
  formatClockReset,
  normalizeStatusPayload,
  renderMinimalStatusLine,
} from '../src/statusline-core.mjs';
import {
  buildStatusLineCommand,
  inspectStatusLine,
  installStatusLine,
  uninstallStatusLine,
} from '../src/lifecycle.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

test('renderMinimalStatusLine matches clean minimalist single-line style with clock reset time', () => {
  // 2026-11-26 16:00 UTC+8 -> resets at 18:30 UTC+8 (2h30m later)
  const now = Date.parse('2026-11-26T08:00:00Z');
  const resetIso = '2026-11-26T10:30:00Z';

  const metrics = normalizeStatusPayload(
    {
      model: { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
      agent_state: 'idle',
      cycle_mode: 'auto',
      task_count: 1,
      subagents: [{ name: 'a', state: 'working' }, { name: 'b', state: 'working' }, { name: 'c', state: 'working' }],
      context_window: {
        context_window_size: 1_000_000,
        current_usage: { input_tokens: 38_000, cache_read_input_tokens: 342_000, cache_creation_input_tokens: 0 },
      },
      quota: {
        'gemini-5h': { remaining_fraction: 0.9, reset_time: resetIso },
        '3p-5h': { remaining_fraction: 0.18, reset_time: resetIso },
        '3p-weekly': { remaining_fraction: 0.4, reset_in_seconds: 172800 },
      },
    },
    { autoCompactOverride: '1M' }
  );

  assert.equal(metrics.context.effectiveLimit, 1_000_000);
  assert.equal(Math.round(metrics.context.usedPercentage), 38);
  assert.equal(Math.round(metrics.cachePct), 90);
  assert.equal(formatClockReset(metrics.quotas.fiveHour, now, 480), '18:30');

  // Stacked mode (default): strictly 1 minimalist line showing ONLY active Claude quota & reset times
  const stacked = renderMinimalStatusLine(metrics, {
    language: 'en',
    width: 100,
    color: false,
    stacked: true,
    showCache: false,
    now,
    tzOffsetMinutes: 480,
  });
  assert.equal(stacked, 'ctx 38% of 1000K | 5h 18% (resets 18:30) | 7d 40% (resets 11/28)');

  const withCache = renderMinimalStatusLine(metrics, {
    language: 'en',
    width: 100,
    color: false,
    stacked: true,
    showCache: true,
    now,
    tzOffsetMinutes: 480,
  });
  assert.equal(withCache, 'ctx 38% of 1000K | cache 90% | 5h 18% (resets 18:30) | 7d 40% (resets 11/28)');

  // Non-stacked mode adds the clean mode / tasks / agents second row
  const unstacked = renderMinimalStatusLine(metrics, {
    language: 'en',
    width: 100,
    color: false,
    stacked: false,
    showCache: true,
    now,
    tzOffsetMinutes: 480,
  });
  const lines = unstacked.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /▸▸ auto mode on · Claude Sonnet 4\.6 · 1 task · ← 3 agents/);

  // zh-CN formatting
  const zh = renderMinimalStatusLine(metrics, {
    language: 'zh-CN',
    width: 100,
    color: false,
    stacked: true,
    showCache: true,
    now,
    tzOffsetMinutes: 480,
  });
  assert.equal(zh, '上下文 38%/1000K | 缓存 90% | 5h 18% (18:30 重置) | 7d 40% (11/28 重置)');

  // Strict family isolation: Claude model never leaks Gemini quota even if 3p buckets are absent
  const claudeNo3p = normalizeStatusPayload({
    model: { id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6' },
    context_window: { context_window_size: 200_000, used_percentage: 20 },
    quota: { 'gemini-5h': { remaining_fraction: 0.99, reset_in_seconds: 3600 } },
  });
  assert.equal(claudeNo3p.quotas.fiveHour, null);
  assert.equal(claudeNo3p.quotas.weekly, null);

  // Gemini model never leaks 3p quota
  const geminiOnly = normalizeStatusPayload({
    model: { id: 'gemini-4-neon-high', display_name: 'Gemini 4 Neon (High)' },
    context_window: { context_window_size: 1_048_576, used_percentage: 20 },
    quota: {
      'gemini-5h': { remaining_fraction: 0.72, reset_time: resetIso },
      '3p-5h': { remaining_fraction: 0.12, reset_time: resetIso },
    },
  });
  assert.equal(geminiOnly.quotas.family, 'gemini');
  assert.equal(geminiOnly.quotas.fiveHour.remaining, 72);
  const geminiLine = renderMinimalStatusLine(geminiOnly, {
    language: 'en',
    width: 100,
    color: false,
    stacked: true,
    showCache: false,
    now,
    tzOffsetMinutes: 480,
  });
  assert.equal(geminiLine, 'ctx 41% of 512K | 5h 72% (resets 18:30)');
});

test('AGY_CLI_AUTO_COMPACT_OVERRIDE and settings.json contextWindow control compaction limit', () => {
  const mEnv = normalizeStatusPayload(
    {
      model: { id: 'gemini-4-neon-high' },
      context_window: {
        context_window_size: 1_048_576,
        current_usage: { input_tokens: 12_000, cache_read_input_tokens: 180_000, cache_creation_input_tokens: 0 },
      },
    },
    { autoCompactOverride: '512K', configuredContextWindow: 256_000 }
  );
  assert.equal(mEnv.context.effectiveLimit, 512_000);
  assert.equal(mEnv.context.basis, 'compact-env');

  // Never exceeds narrow display width
  const narrow = renderMinimalStatusLine(mEnv, { language: 'en', width: 32, color: false, stacked: true });
  assert.ok(displayWidth(narrow) <= 32);
});

test('installStatusLine installs with stack_with_default=true by default and uninstall restores cleanly', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-min-home-'));
  try {
    const cliDir = path.join(fakeHome, '.gemini', 'antigravity-cli');
    const settingsPath = path.join(cliDir, 'settings.json');
    fs.mkdirSync(cliDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ model: 'Gemini 4 Neon (High)' }));

    const installed = installStatusLine({ sourceRoot: REPO_ROOT, homeDir: fakeHome });
    assert.equal(installed.stacked, true);

    const status = inspectStatusLine({ homeDir: fakeHome });
    assert.equal(status.installed, true);
    assert.equal(status.configured, true);
    assert.equal(status.stackWithDefault, true);

    const winCmd = buildStatusLineCommand('C:\\Program Files\\node.exe', 'C:\\Users\\A B\\statusline.mjs', {
      stacked: false,
      platform: 'win32',
    });
    assert.ok(winCmd.startsWith('powershell.exe -NoProfile -NonInteractive -EncodedCommand '));
    const decoded = Buffer.from(winCmd.split(' ').at(-1), 'base64').toString('utf16le');
    assert.match(decoded, /--no-stack/);

    const uninstalled = uninstallStatusLine({ homeDir: fakeHome });
    assert.equal(uninstalled.removed, true);
    assert.equal(uninstalled.restored, true);

    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal('statusLine' in after, false);
    assert.equal(after.model, 'Gemini 4 Neon (High)');
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('bin/statusline.mjs reads stdin JSON and honors AGY_CLI_AUTO_COMPACT_OVERRIDE end-to-end', () => {
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-min-bin-'));
  try {
    const input = JSON.stringify({
      model: { id: 'gemini-4-neon-high', display_name: 'Gemini 4 Neon (High)' },
      agent_state: 'idle',
      terminal_width: 100,
      context_window: {
        context_window_size: 1_048_576,
        current_usage: { input_tokens: 16_000, cache_read_input_tokens: 144_000, cache_creation_input_tokens: 0 },
      },
      quota: {
        'gemini-5h': { remaining_fraction: 0.72, reset_in_seconds: 3600 },
        'gemini-weekly': { remaining_fraction: 0.94, reset_in_seconds: 86400 * 5 },
      },
    });
    const out = execFileSync(
      process.execPath,
      [path.join(REPO_ROOT, 'bin', 'statusline.mjs'), '--no-color', '--data-dir', tmpData],
      {
        input,
        encoding: 'utf8',
        env: { ...process.env, AGY_CLI_AUTO_COMPACT_OVERRIDE: '320K' },
      }
    ).trim();
    assert.match(out, /^ctx 50% of 320K \| cache 90% \| 5h 72% \(resets \d\d:\d\d\) \| 7d 94% \(resets \d\d\/\d\d\)$/);
  } finally {
    fs.rmSync(tmpData, { recursive: true, force: true });
  }
});
