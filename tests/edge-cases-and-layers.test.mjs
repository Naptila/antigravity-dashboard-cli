import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { displayWidth, truncateDisplay, wrapDisplayText } from '../src/ansi.mjs';
import { parseConsoleCommand } from '../src/console-commands.mjs';
import { installStatusLine, uninstallStatusLine } from '../src/lifecycle.mjs';
import { estimateTokenCost, loadCustomPricing, resolveModelPricing } from '../src/pricing.mjs';
import { renderUsageReport, renderUsageReportMarkdown } from '../src/stats-render.mjs';
import {
  createEmptyUsageLedger,
  discoverTranscriptFiles,
  parsePlannerResponseEntry,
  sanitizeUsageLedger,
  syncUsageLedger,
} from '../src/transcript-reader.mjs';
import {
  buildUsageReport,
  isValidIsoDate,
  resolveTimezoneSpec,
  shiftIsoDate,
} from '../src/usage-aggregator.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

test('transcript-reader handles missing, empty, malformed, newline-less, partial-EOF, and out-of-order logs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-edge-reader-'));
  try {
    const dataDir = path.join(tmp, 'data');
    const brainDir = path.join(tmp, 'brain');

    // 1. Missing brainDir returns empty safely
    assert.deepEqual(discoverTranscriptFiles(path.join(tmp, 'nonexistent')), []);
    const emptySync = syncUsageLedger({ dataDir, brainDir: path.join(tmp, 'nonexistent') });
    assert.equal(emptySync.ledger.records.length, 0);

    // 2. Empty file, corrupt lines, nested usage object, and final line WITHOUT trailing newline
    const convLogs = path.join(brainDir, 'conv-edge', '.system_generated', 'logs');
    const emptyLogs = path.join(brainDir, 'conv-empty', '.system_generated', 'logs');
    fs.mkdirSync(convLogs, { recursive: true });
    fs.mkdirSync(emptyLogs, { recursive: true });
    fs.writeFileSync(path.join(emptyLogs, 'transcript.jsonl'), '');

    const transcriptFile = path.join(convLogs, 'transcript.jsonl');
    const line1 = JSON.stringify({
      step_index: 5,
      type: 'PLANNER_RESPONSE',
      model: 'gemini-4-carbon-medium',
      usage: {
        input_tokens: 4000,
        cache_read_input_tokens: 36000,
        cache_creation_input_tokens: 1000,
        output_tokens: 500,
      },
      created_at: '2026-11-26T07:30:00Z',
    });
    const corruptLine = '{"type":"PLANNER_RESPONSE", broken json...';
    const nonPlannerLine = JSON.stringify({ step_index: 2, type: 'USER_REQUEST', text: 'hi' });
    // Out-of-order step_index (3 after 5) WITH NO TRAILING NEWLINE:
    const lineNoNewline = JSON.stringify({
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      model: 'claude-sonnet-4-6',
      input_tokens: 2000,
      cache_read_tokens: 8000,
      cache_write_tokens: 500,
      output_tokens: 300,
      created_at: '2026-11-26T08:00:00Z',
    });

    fs.writeFileSync(transcriptFile, [line1, corruptLine, nonPlannerLine, lineNoNewline].join('\n'));
    const sync1 = syncUsageLedger({ dataDir, brainDir });
    assert.equal(sync1.ledger.records.length, 2);

    // 3. Simulate an in-flight partial write at EOF (incomplete JSON without '\n'), followed by completion
    const partialHalf = '\n{"step_index":6,"type":"PLANNER_RESPONSE","model":"gemini-4-neon-high",';
    fs.appendFileSync(transcriptFile, partialHalf);
    const statMid = fs.statSync(transcriptFile);
    fs.utimesSync(transcriptFile, statMid.atime, new Date(statMid.mtimeMs + 1000));

    const syncMid = syncUsageLedger({ dataDir, brainDir });
    // Partial line must NOT be committed or skipped permanently
    assert.equal(syncMid.ledger.records.length, 2);

    const restHalf = '"input_tokens":1500,"cache_read_tokens":8500,"output_tokens":250,"created_at":"2026-11-26T08:05:00Z"}\n';
    fs.appendFileSync(transcriptFile, restHalf);
    const statDone = fs.statSync(transcriptFile);
    fs.utimesSync(transcriptFile, statDone.atime, new Date(statDone.mtimeMs + 2000));

    const syncDone = syncUsageLedger({ dataDir, brainDir });
    assert.equal(syncDone.ledger.records.length, 3);

    // 4. Truncated/compacted transcript resets cursor while deduplicating existing steps
    fs.writeFileSync(transcriptFile, line1 + '\n');
    const statTrunc = fs.statSync(transcriptFile);
    fs.utimesSync(transcriptFile, statTrunc.atime, new Date(statTrunc.mtimeMs + 3000));
    const syncTrunc = syncUsageLedger({ dataDir, brainDir });
    assert.equal(syncTrunc.ledger.records.length, 3);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('usage-aggregator handles IANA DST transitions, anchored --to windows, date validation, and corrupt ledger sanitization', () => {
  // Real calendar validation
  assert.equal(isValidIsoDate('2026-02-28'), true);
  assert.equal(isValidIsoDate('2026-02-29'), false); // 2026 is not a leap year
  assert.equal(isValidIsoDate('2024-02-29'), true);
  assert.equal(isValidIsoDate('2026-13-01'), false);

  // Pure calendar shifting across US DST fall-back (2026-11-01 is 25 hours in America/New_York)
  assert.equal(shiftIsoDate('2026-11-05', -6).isoDate, '2026-10-30');

  const nySpec = resolveTimezoneSpec('America/New_York', Date.parse('2026-11-26T12:00:00Z'));
  assert.equal(nySpec.mode, 'iana');
  assert.equal(nySpec.label, 'America/New_York');

  // 2026-10-15T04:30:00Z is 2026-10-15 00:30 EDT (UTC-4), NOT 2026-10-14 23:30 EST (UTC-5)!
  const ledger = sanitizeUsageLedger({
    schema: 1,
    models: ['gemini-4-carbon-medium'],
    files: {},
    records: [
      [Math.floor(Date.parse('2026-10-15T04:30:00Z') / 1000), 'conv1', 1, 0, 1000, 9000, 500, 200],
      // Malformed tuples must be safely ignored without NaN poisoning:
      null,
      ['bad'],
      [1700000000, 'conv1', 2, 0, 0, 0, 0, 0],
    ],
  });
  assert.equal(ledger.records.length, 1);

  // Anchored --days 7 --to 2026-10-18 even when `now` is 2026-11-26
  const report = buildUsageReport(ledger, {
    days: 7,
    to: '2026-10-18',
    tz: 'America/New_York',
    now: Date.parse('2026-11-26T16:00:00Z'),
  });
  assert.equal(report.range.from, '2026-10-12');
  assert.equal(report.range.to, '2026-10-18');
  assert.equal(report.periods.length, 1);
  assert.equal(report.periods[0].period, '2026-10-15');
  assert.equal(report.periods[0].totalTokens, 10700);
  assert.equal(report.periods[0].cacheWriteTokens, 500);
  // Cache rate = 9000 / (1000 + 9000 + 500) = 85.714285...%
  assert.ok(Math.abs(report.periods[0].cacheRate - (9000 / 10500) * 100) < 1e-6);

  // Inverted range throws descriptive error
  assert.throws(
    () => buildUsageReport(createEmptyUsageLedger(), { from: '2026-11-20', to: '2026-11-10' }),
    /cannot be after/
  );
});

test('pricing, console-commands, markdown renderer, display helpers, and standalone installed runtime handle edge cases', () => {
  // Prototype key safety in pricing
  assert.equal(resolveModelPricing('constructor', {}), null);
  assert.equal(resolveModelPricing('toString', {}), null);
  const protoEst = estimateTokenCost('__proto__', { inputTokens: 1000, outputTokens: 1000 }, {});
  assert.equal(protoEst.known, false);
  assert.equal(protoEst.estimatedUsd, 0);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-edge-ui-'));
  try {
    fs.writeFileSync(
      path.join(tmp, 'pricing.json'),
      JSON.stringify({ __proto__: { input: 99, output: 99 }, constructor: { input: 99, output: 99 } })
    );
    const custom = loadCustomPricing(tmp);
    assert.equal(Object.keys(custom).length, 0);

    // Console command rejects impossible calendar dates and inverted ranges
    assert.equal(parseConsoleCommand('/stats --from 2026-02-29'), null);
    assert.equal(parseConsoleCommand('/stats --from 2026-11-20 --to 2026-11-10'), null);
    assert.ok(parseConsoleCommand('/stats --tz Asia/Shanghai'));

    // CJK display truncation & word wrapping
    const clipped = truncateDisplay('测试超长模型名称一二三四五六七八九十', 12);
    assert.ok(displayWidth(clipped) <= 12);
    const wrapped = wrapDisplayText('Note: Est. Cost uses public API reference rates in pricing.json.', 24);
    assert.ok(wrapped.every(line => displayWidth(line) <= 24));

    // Markdown & empty report rendering
    const emptyReport = buildUsageReport(createEmptyUsageLedger(), {
      now: Date.parse('2026-11-26T08:00:00Z'),
      tz: 'utc+8',
    });
    const ansiText = renderUsageReport(emptyReport, { language: 'zh-TW', width: 80, color: false });
    assert.match(ansiText, /Antigravity CLI Token 用量與花費統計/);
    const mdText = renderUsageReportMarkdown(emptyReport, { language: 'en' });
    assert.match(mdText, /### Antigravity CLI Usage & Spend Report/);
    assert.match(mdText, /#### Activity Heatmap \(Last 12 Weeks\)/);

    // CLI --markdown & AGY_BRAIN_DIR isolation smoke test
    const cliPath = path.join(REPO_ROOT, 'bin', 'cli.mjs');
    const mdCliOut = execFileSync(
      process.execPath,
      [cliPath, 'stats', '--markdown', '--data-dir', path.join(tmp, 'd'), '--brain-dir', path.join(tmp, 'b')],
      { encoding: 'utf8' }
    );
    assert.match(mdCliOut, /### Antigravity CLI Usage & Spend Report/);

    // Verify copied standalone statusLine runtime executes cleanly from isolated fakeHome
    const fakeHome = path.join(tmp, 'home');
    fs.mkdirSync(path.join(fakeHome, '.gemini', 'antigravity-cli'), { recursive: true });
    const installed = installStatusLine({ sourceRoot: REPO_ROOT, homeDir: fakeHome });
    const copiedBin = path.join(installed.runtimeDir, 'bin', 'statusline.mjs');
    const previewOut = execFileSync(
      process.execPath,
      [copiedBin, '--preview', '--no-color', '--data-dir', path.join(tmp, 'd')],
      { encoding: 'utf8' }
    ).trim();
    assert.match(previewOut, /^ctx \d+% of 512K \| cache \d+%/);
    uninstallStatusLine({ homeDir: fakeHome });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('parsePlannerResponseEntry sanitizes negative/non-numeric counts and resolves timestamps', () => {
  assert.equal(parsePlannerResponseEntry(null), null);
  assert.equal(parsePlannerResponseEntry({ type: 'USER_REQUEST' }), null);
  assert.equal(
    parsePlannerResponseEntry({ type: 'PLANNER_RESPONSE', input_tokens: -5, output_tokens: 0 }),
    null
  );

  const valid = parsePlannerResponseEntry(
    {
      type: 'PLANNER_RESPONSE',
      step_index: 0,
      model: 'gemini-4-carbon-medium',
      input_tokens: '1200',
      cache_read_tokens: 4800,
      output_tokens: 300,
      created_at: 1764144000000,
    },
    0
  );
  assert.deepEqual(valid, {
    stepIndex: 0,
    model: 'gemini-4-carbon-medium',
    tsSec: 1764144000,
    inputTokens: 1200,
    cacheReadTokens: 4800,
    cacheWriteTokens: 0,
    outputTokens: 300,
  });
});
