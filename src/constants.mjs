// @ts-check

export const INSTALL_NAME = 'antigravity-dashboard-cli';
export const PLUGIN_VERSION = '0.1.1';
export const INSTALL_SCHEMA_VERSION = 1;
export const USAGE_LEDGER_SCHEMA = 1;

export const DEFAULT_LANGUAGE = 'en';
export const SUPPORTED_LANGUAGES = Object.freeze(['en', 'zh-CN', 'zh-TW']);

/** @type {Readonly<Record<string, 'en' | 'zh-CN' | 'zh-TW'>>} */
export const LANGUAGE_ALIASES = Object.freeze({
  en: 'en',
  english: 'en',
  zh: 'zh-CN',
  cn: 'zh-CN',
  'zh-cn': 'zh-CN',
  zh_cn: 'zh-CN',
  tw: 'zh-TW',
  'zh-tw': 'zh-TW',
  zh_tw: 'zh-TW',
});

export const MAX_STDIN_BYTES = 512 * 1024;
export const TRANSCRIPT_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_LINE_BYTES = 2 * 1024 * 1024;

export const CLI_DIR_SEGMENTS = Object.freeze(['.gemini', 'antigravity-cli']);
export const DEFAULT_DATA_DIR_NAME = 'dashboard-cli-data';
export const DEFAULT_BRAIN_DIR_NAME = 'brain';
export const TRANSCRIPT_REL_SEGMENTS = Object.freeze([
  '.system_generated',
  'logs',
  'transcript.jsonl',
]);

export const STATUSLINE_RUNTIME_FILES = Object.freeze([
  'package.json',
  'bin/statusline.mjs',
  'src/constants.mjs',
  'src/i18n.mjs',
  'src/ansi.mjs',
  'src/store.mjs',
  'src/statusline-core.mjs',
]);
