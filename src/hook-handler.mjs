#!/usr/bin/env node
// @ts-check
import { executeConsoleCommand, parseConsoleCommand } from './console-commands.mjs';
import { readStdinJson, resolveDataDir } from './store.mjs';

/**
 * Processes an Antigravity CLI hook payload (`PreInvocation`).
 * Always returns `{}` for non-matching events or prompts so normal chat is never blocked.
 *
 * @param {any} payload
 * @param {{ dataDir?: string, brainDir?: string, now?: number, env?: NodeJS.ProcessEnv }} [opts]
 */
export function processHookPayload(
  payload,
  { dataDir = resolveDataDir(), brainDir = undefined, now = Date.now(), env = process.env } = {}
) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};

  if (payload.hookEventName === 'PreInvocation') {
    const parsedCmd = parseConsoleCommand(payload.lastUserInput);
    if (parsedCmd) {
      const cmdResponse = executeConsoleCommand(parsedCmd, {
        dataDir,
        ...(brainDir ? { brainDir } : {}),
        now,
        env,
      });
      if (cmdResponse) return cmdResponse;
    }
  }

  return {};
}

async function main() {
  try {
    const payload = await readStdinJson({ allowEmpty: true });
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
