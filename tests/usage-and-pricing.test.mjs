import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { estimateTokenCost, loadCustomPricing } from '../src/pricing.mjs';
import {
  buildUsageReport,
  syncUsageLedger,
} from '../src/usage-ledger.mjs';
import { renderUsageReport, renderUsageReportMarkdown } from '../src/stats-render.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

test('estimateTokenCost computes reference API spend, cache savings, and custom pricing overrides', () => {
  const neon = estimateTokenCost('gemini-4-neon-high', {
    inputTokens: 1_000_000,
    cacheReadTokens: 2_000_000,
    cacheWriteTokens: 0,
    outputTokens: 500_000,
  });
  assert.equal(neon.known, true);
  assert.equal(neon.tier, 'gemini-neon');
  // 1M * 1.25 + 2M * 0.125 + 0.5M * 10.0 = 1.25 + 0.25 + 5.0 = 6.50
  assert.ok(Math.abs(neon.estimatedUsd - 6.5) < 1e-6);
  // Cache saved = 2M * (1.25 - 0.125) = 2.25
  assert.ok(Math.abs(neon.cacheSavedUsd - 2.25) < 1e-6);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-price-'));
  try {
    fs.writeFileSync(
      path.join(tmp, 'pricing.json'),
      JSON.stringify({
        models: {
          'my-custom-model': { input: 4, cacheRead: 0.4, output: 20 },
        },
      })
    );
    const custom = loadCustomPricing(tmp);
    const est = estimateTokenCost(
      'my-custom-model-v2',
      { inputTokens: 500_000, cacheReadTokens: 1_000_000, outputTokens: 100_000 },
      custom
    );
    assert.equal(est.known, true);
    // 0.5*4 + 1.0*0.4 + 0.1*20 = 2 + 0.4 + 2 = 4.4
    assert.ok(Math.abs(est.estimatedUsd - 4.4) < 1e-6);
    assert.ok(Math.abs(est.cacheSavedUsd - 3.6) < 1e-6);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('syncUsageLedger scans multi-day transcripts incrementally, preserves deleted chats, and groups by date/week/month/tz', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ledger-'));
  try {
    const dataDir = path.join(tmp, 'data');
    const brainDir = path.join(tmp, 'brain');
    const conv1Logs = path.join(brainDir, 'conv-1', '.system_generated', 'logs');
    const conv2Logs = path.join(brainDir, 'conv-2', '.system_generated', 'logs');
    fs.mkdirSync(conv1Logs, { recursive: true });
    fs.mkdirSync(conv2Logs, { recursive: true });

    // 2026-11-18T17:00:00Z is 2026-11-18 in UTC, but 2026-11-19 01:00 in UTC+8!
    fs.writeFileSync(
      path.join(conv1Logs, 'transcript.jsonl'),
      [
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          model: 'gemini-4-neon-high',
          input_tokens: 10000,
          cache_read_tokens: 90000,
          output_tokens: 2000,
          created_at: '2026-11-18T10:00:00Z',
        }),
        JSON.stringify({
          step_index: 2,
          type: 'PLANNER_RESPONSE',
          model: 'claude-sonnet-4-6',
          input_tokens: 5000,
          cache_read_tokens: 45000,
          output_tokens: 1000,
          created_at: '2026-11-18T17:00:00Z',
        }),
      ].join('\n') + '\n'
    );

    fs.writeFileSync(
      path.join(conv2Logs, 'transcript.jsonl'),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        model: 'gemini-4-neon-high',
        input_tokens: 20000,
        cache_read_tokens: 180000,
        output_tokens: 4000,
        created_at: '2026-11-19T08:00:00Z',
      }) + '\n'
    );

    const firstSync = syncUsageLedger({ dataDir, brainDir });
    assert.equal(firstSync.scannedConversations, 2);
    assert.equal(firstSync.ledger.records.length, 3);

    // Deleting conv-2 from disk must NOT erase already-recorded usage from usage-v1.json
    fs.rmSync(path.join(brainDir, 'conv-2'), { recursive: true, force: true });
    const secondSync = syncUsageLedger({ dataDir, brainDir });
    assert.equal(secondSync.ledger.records.length, 3);

    const now = Date.parse('2026-11-19T10:00:00Z');
    const reportUtc8 = buildUsageReport(secondSync.ledger, {
      dataDir,
      days: 7,
      groupBy: 'day',
      tz: 'utc+8',
      now,
    });
    assert.equal(reportUtc8.timezone, 'UTC+8');
    assert.equal(reportUtc8.periods.length, 2);
    assert.equal(reportUtc8.periods[0].period, '2026-11-18');
    assert.equal(reportUtc8.periods[0].requests, 1);
    assert.equal(reportUtc8.periods[1].period, '2026-11-19');
    assert.equal(reportUtc8.periods[1].requests, 2);
    assert.equal('cliReportedCost' in reportUtc8, false);
    assert.equal(reportUtc8.models.length, 2);
    assert.equal(reportUtc8.models[0].model, 'gemini-4-neon-high');
    assert.ok(reportUtc8.overview.allTime.estimatedUsd > 0);
    assert.ok(reportUtc8.overview.allTime.cacheSavedUsd > 0);

    // Same ledger in UTC places 17:00Z on 2026-11-18
    const reportUtc = buildUsageReport(secondSync.ledger, {
      dataDir,
      days: 7,
      groupBy: 'day',
      tz: 'utc',
      now,
    });
    assert.equal(reportUtc.periods[0].period, '2026-11-18');
    assert.equal(reportUtc.periods[0].requests, 2);
    assert.equal(reportUtc.periods[1].period, '2026-11-19');
    assert.equal(reportUtc.periods[1].requests, 1);

    // Render check in EN & zh-CN
    const renderedEn = renderUsageReport(reportUtc8, { language: 'en', width: 110, color: false });
    assert.match(renderedEn, /Antigravity CLI Usage & Spend Report/);
    assert.match(renderedEn, /2026-11-19/);
    assert.match(renderedEn, /gemini-4-neon-high/);

    const renderedZh = renderUsageReport(reportUtc8, { language: 'zh-CN', width: 110, color: false });
    assert.match(renderedZh, /Antigravity CLI Token 用量与花销统计/);
    assert.match(renderedZh, /按日期统计/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('bin/cli.mjs lang defaults to en and toggles live', () => {
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-lang-'));
  try {
    const cli = path.join(REPO_ROOT, 'bin', 'cli.mjs');
    const initial = execFileSync(process.execPath, [cli, 'lang', '--data-dir', tmpData], { encoding: 'utf8' });
    assert.match(initial, /Current language: en/);

    const switchedZh = execFileSync(process.execPath, [cli, 'lang', 'zh', '--data-dir', tmpData], {
      encoding: 'utf8',
    });
    assert.match(switchedZh, /Language switched to: zh-CN/);

    const toggled = execFileSync(process.execPath, [cli, 'lang', 'toggle', '--data-dir', tmpData], {
      encoding: 'utf8',
    });
    assert.match(toggled, /Language switched to: en/);

    // preview supports --show-cost override without mutating preferences.json
    const prevDefault = execFileSync(
      process.execPath,
      [cli, 'preview', '--no-color', '--data-dir', tmpData],
      { encoding: 'utf8' }
    ).trim();
    assert.doesNotMatch(prevDefault, /\|\s*\$0\.18$/);

    const prevWithCost = execFileSync(
      process.execPath,
      [cli, 'preview', '--show-cost', 'true', '--no-color', '--data-dir', tmpData],
      { encoding: 'utf8' }
    ).trim();
    assert.match(prevWithCost, /\|\s*\$0\.18$/);

    // Unsupported per-subcommand flags fail fast instead of silently no-oping
    assert.throws(
      () =>
        execFileSync(process.execPath, [cli, 'stats', '--show-cost', 'false', '--data-dir', tmpData], {
          encoding: 'utf8',
          stdio: 'pipe',
        }),
      /Option --show-cost is not supported by "stats"/
    );
    assert.throws(
      () =>
        execFileSync(process.execPath, [cli, 'install', '--show-cost', 'true'], {
          encoding: 'utf8',
          stdio: 'pipe',
        }),
      /Option --show-cost is not supported by "install"/
    );
  } finally {
    fs.rmSync(tmpData, { recursive: true, force: true });
  }
});

test('stats renders -- instead of $0.00 when models have no matching pricing rule (pricedRequests === 0)', () => {
  const unpricedReport = buildUsageReport(
    {
      schema: 1,
      models: ['custom-unpriced-model'],
      files: {},
      records: [
        [Math.floor(Date.parse('2026-11-26T08:00:00Z') / 1000), 'conv1', 1, 0, 5000, 15000, 0, 1000],
      ],
    },
    { tz: 'utc', now: Date.parse('2026-11-26T10:00:00Z') }
  );
  assert.equal(unpricedReport.overview.allTime.pricedRequests, 0);
  assert.equal(unpricedReport.models[0].pricedRequests, 0);

  const ansiPlain = renderUsageReport(unpricedReport, { language: 'en', width: 110, color: false });
  assert.doesNotMatch(ansiPlain, /\$0\.00/);
  assert.match(ansiPlain, /custom-unpriced-model\s+1\s+21K\s+100%\s+15K\s+75%\s+--\s+--/);

  const md = renderUsageReportMarkdown(unpricedReport, { language: 'en' });
  assert.doesNotMatch(md, /\$0\.00/);
  assert.match(md, /\| `custom-unpriced-model` \| 1 \| \*\*21K\*\* \| 100% \| 15K \| 75% \| \*\*--\*\* \| -- \|/);
});
