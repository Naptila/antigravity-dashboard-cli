#!/usr/bin/env node
import { executeConsoleCommand, parseConsoleCommand } from './console-commands.mjs';
import { MAX_STDIN_BYTES } from './constants.mjs';
import { resolveDataDir } from './store.mjs';

async function readStdinJson() {
  let size = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_STDIN_BYTES) throw new Error('Hook payload exceeds limit');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '').trim();
  if (!text) return {};
  return JSON.parse(text);
}

export function processHookPayload(
  payload,
  { dataDir = resolveDataDir(), brainDir = undefined, now = Date.now() } = {}
) {
  if (!payload || typeof payload !== 'object') return {};

  if (payload.hookEventName === 'PreInvocation') {
    const parsedCmd = parseConsoleCommand(payload.lastUserInput);
    if (parsedCmd) {
      const cmdResponse = executeConsoleCommand(parsedCmd, {
        dataDir,
        ...(brainDir ? { brainDir } : {}),
        now,
      });
      if (cmdResponse) return cmdResponse;
    }
  }

  return {};
}

async function main() {
  try {
    const payload = await readStdinJson();
    const response = processHookPayload(payload);
    process.stdout.write(JSON.stringify(response) + '\n');
  } catch {
    process.stdout.write('{}\n');
  }
}

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('hook-handler.mjs') || process.argv[1].includes('hook-handler.mjs'));
if (isDirectRun) {
  main();
}
