import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConsoleCommand } from '../src/console-commands.mjs';
import { processHookPayload } from '../src/hook-handler.mjs';
import { loadPreferences } from '../src/store.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

test('hooks.json only registers PreInvocation and never PreToolUse', () => {
  const hooksConfig = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'hooks.json'), 'utf8'));
  for (const [name, spec] of Object.entries(hooksConfig)) {
    assert.deepEqual(Object.keys(spec), ['PreInvocation'], `Hook ${name} should only register PreInvocation`);
  }
});

test('parseConsoleCommand accepts strict /stats and /lang commands and ignores free-form prompts', () => {
  assert.deepEqual(parseConsoleCommand('/stats'), {
    kind: 'stats',
    opts: {
      days: 14,
      groupBy: 'day',
      from: null,
      to: null,
      modelFilter: null,
      tz: 'local',
      language: null,
      rebuild: false,
    },
  });

  assert.deepEqual(parseConsoleCommand('/stats 30 week --model neon --tz utc+8'), {
    kind: 'stats',
    opts: {
      days: 30,
      groupBy: 'week',
      from: null,
      to: null,
      modelFilter: 'neon',
      tz: 'utc+8',
      language: null,
      rebuild: false,
    },
  });

  assert.deepEqual(parseConsoleCommand('/dashboard stats --days all --by month zh'), {
    kind: 'stats',
    opts: {
      days: 'all',
      groupBy: 'month',
      from: null,
      to: null,
      modelFilter: null,
      tz: 'local',
      language: 'zh-CN',
      rebuild: false,
    },
  });

  assert.deepEqual(parseConsoleCommand('/dash:stats 30'), {
    kind: 'stats',
    opts: {
      days: 30,
      groupBy: 'day',
      from: null,
      to: null,
      modelFilter: null,
      tz: 'local',
      language: null,
      rebuild: false,
    },
  });

  assert.deepEqual(parseConsoleCommand('/dash:lang zh'), {
    kind: 'lang',
    target: 'zh-CN',
  });

  assert.deepEqual(parseConsoleCommand('/antigravity-dashboard-cli:stats 30'), {
    kind: 'stats',
    opts: {
      days: 30,
      groupBy: 'day',
      from: null,
      to: null,
      modelFilter: null,
      tz: 'local',
      language: null,
      rebuild: false,
    },
  });

  assert.deepEqual(parseConsoleCommand('/antigravity-dashboard-cli:lang zh'), {
    kind: 'lang',
    target: 'zh-CN',
  });

  assert.deepEqual(parseConsoleCommand('/lang'), { kind: 'lang', target: null });
  assert.deepEqual(parseConsoleCommand('/lang zh'), { kind: 'lang', target: 'zh-CN' });
  assert.deepEqual(parseConsoleCommand('/lang toggle'), { kind: 'lang', target: 'toggle' });

  // Natural language prompts mentioning /stats or /lang must NEVER be intercepted
  assert.equal(parseConsoleCommand('/stats 帮我加个字段'), null);
  assert.equal(parseConsoleCommand('Please check /stats for me'), null);
  assert.equal(parseConsoleCommand('/lang something invalid'), null);
  assert.equal(parseConsoleCommand('/stats\nsecond line'), null);
});

test('PreInvocation hook intercepts /stats and /lang inline with user_markdown and terminate', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cmd-'));
  try {
    const dataDir = path.join(tmp, 'data');
    const brainDir = path.join(tmp, 'brain');
    const logs = path.join(brainDir, 'c1', '.system_generated', 'logs');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(
      path.join(logs, 'transcript.jsonl'),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        model: 'gemini-4-neon-high',
        input_tokens: 10000,
        cache_read_tokens: 90000,
        output_tokens: 1000,
        created_at: '2026-11-19T10:00:00Z',
      }) + '\n'
    );

    const statsResp = processHookPayload(
      {
        hookEventName: 'PreInvocation',
        invocationNum: 1,
        conversationId: 'c1',
        lastUserInput: '/stats',
      },
      { dataDir, brainDir, now: Date.parse('2026-11-19T12:00:00Z') }
    );
    assert.equal(statsResp.terminationBehavior, 'terminate');
    assert.equal(statsResp.injectSteps.length, 1);
    const text = statsResp.injectSteps[0].errorMessage.userMessage;
    assert.match(text, /Antigravity CLI Usage & Spend Report/);
    assert.match(text, /gemini-4-neon-high/);
    assert.match(text, /2026-11-19/);

    // /lang zh switches preferences live and responds inline
    const langResp = processHookPayload(
      {
        hookEventName: 'PreInvocation',
        invocationNum: 1,
        conversationId: 'c1',
        lastUserInput: '/lang zh',
      },
      { dataDir, brainDir }
    );
    assert.equal(langResp.terminationBehavior, 'terminate');
    assert.equal(loadPreferences(dataDir).language, 'zh-CN');
    assert.match(langResp.injectSteps[0].errorMessage.userMessage, /简体中文/);

    // Works on later invocation numbers too (e.g. long conversation with namespaced command)
    const namespacedResp = processHookPayload(
      {
        hookEventName: 'PreInvocation',
        invocationNum: 42,
        conversationId: 'c1',
        lastUserInput: '/antigravity-dashboard-cli:stats 30',
      },
      { dataDir, brainDir, now: Date.parse('2026-11-19T12:00:00Z') }
    );
    assert.equal(namespacedResp.terminationBehavior, 'terminate');
    assert.match(namespacedResp.injectSteps[0].errorMessage.userMessage, /gemini-4-neon-high/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
