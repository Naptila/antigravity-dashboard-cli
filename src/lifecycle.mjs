// @ts-check
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  INSTALL_NAME,
  INSTALL_SCHEMA_VERSION,
  STATUSLINE_RUNTIME_FILES,
  SUPPORTED_LANGUAGES,
} from './constants.mjs';
import { resolveCliBaseDir, resolveDataDir, savePreferences, writeJsonAtomic } from './store.mjs';

/**
 * Resolves installation, backup, settings, and lockfile paths for the CLI runtime.
 * @param {string} [homeDir=os.homedir()]
 * @param {NodeJS.ProcessEnv} [env=process.env]
 */
export function getCliPaths(homeDir = os.homedir(), env = process.env) {
  const base = resolveCliBaseDir({ homeDir, env });
  return {
    base,
    settingsFile: path.join(base, 'settings.json'),
    runtimeDir: path.join(base, INSTALL_NAME),
    backupFile: path.join(base, `.${INSTALL_NAME}-install.json`),
    lockFile: path.join(base, `.${INSTALL_NAME}.lock`),
  };
}

/** @param {string} targetPath */
function assertNotSymlinkOrJunction(targetPath) {
  let lstat;
  try {
    lstat = fs.lstatSync(targetPath);
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return;
    throw err;
  }
  if (lstat.isSymbolicLink()) {
    throw new Error(`Refusing to operate on symbolic link: ${targetPath}`);
  }
  const real = fs.realpathSync(targetPath);
  const abs = path.resolve(targetPath);
  if (real !== abs) {
    throw new Error(`Path resolves through a symlink or junction: ${targetPath}`);
  }
}

/**
 * Parses a JSON settings `Buffer` (or `null` if file does not exist) into a plain object.
 * @param {Buffer | null} rawBytes
 * @param {string} label
 * @returns {Record<string, any>}
 */
function parseSettingsBuffer(rawBytes, label = 'CLI settings.json') {
  if (!rawBytes) return {};
  const parsed = JSON.parse(rawBytes.toString('utf8').replace(/^\uFEFF/, ''));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed;
}

/** @param {string} filePath */
function readSettingsBytesAndObject(filePath, label = 'CLI settings.json') {
  if (!fs.existsSync(filePath)) {
    return { bytes: null, data: /** @type {Record<string, any>} */ ({}) };
  }
  const bytes = fs.readFileSync(filePath);
  return { bytes, data: parseSettingsBuffer(bytes, label) };
}

/**
 * @template T
 * @param {string} baseDir
 * @param {string} lockFile
 * @param {() => T} fn
 * @returns {T}
 */
function withLifecycleLock(baseDir, lockFile, fn) {
  assertNotSymlinkOrJunction(baseDir);
  fs.mkdirSync(baseDir, { recursive: true });
  let fd;
  try {
    fd = fs.openSync(lockFile, 'wx', 0o600);
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'EEXIST') {
      throw new Error(
        `Another lifecycle operation is active (lock exists: ${lockFile}). Remove it manually if a previous run crashed.`
      );
    }
    throw err;
  }
  try {
    fs.closeSync(fd);
    return fn();
  } finally {
    try {
      fs.unlinkSync(lockFile);
    } catch {
      // ignore
    }
  }
}

/** @param {string} value */
function shellQuotePosix(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Builds the OS-appropriate `statusLine` shell command string.
 * @param {string} nodePath
 * @param {string} scriptPath
 * @param {{ stacked?: boolean, noColor?: boolean, platform?: string }} [opts]
 * @returns {string}
 */
export function buildStatusLineCommand(
  nodePath,
  scriptPath,
  { stacked = true, noColor = false, platform = process.platform } = {}
) {
  const args = [];
  if (!stacked) args.push('--no-stack');
  if (noColor) args.push('--no-color');

  if (platform === 'win32') {
    for (const value of [nodePath, scriptPath]) {
      if (/[\r\n\x00]/.test(String(value))) {
        throw new Error('Node or script path contains invalid control characters.');
      }
    }
    const psQuote = (/** @type {string} */ value) => `'${String(value).replace(/'/g, "''")}'`;
    const invocation = [psQuote(nodePath), psQuote(scriptPath), ...args].join(' ');
    const psScript =
      '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); ' +
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ' +
      `& ${invocation}; exit $LASTEXITCODE`;
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
  }

  return [shellQuotePosix(nodePath), shellQuotePosix(scriptPath), ...args].join(' ');
}

/**
 * Verifies that the target Node.js executable is version 20 or newer.
 * @param {string | null} [explicitNode=null]
 * @returns {string}
 */
export function resolveNodeExecutable(explicitNode = null) {
  const candidate = explicitNode || process.execPath;
  const output = execFileSync(candidate, ['--version'], { encoding: 'utf8' }).trim();
  const major = Number.parseInt(output.replace(/^v/, '').split('.')[0], 10);
  if (!Number.isFinite(major) || major < 20) {
    throw new Error(`Node.js 20+ is required (found ${output}).`);
  }
  return fs.realpathSync(candidate);
}

/**
 * @param {any} current
 * @param {any} backupState
 * @returns {boolean}
 */
function ownsStatusLine(current, backupState) {
  if (!backupState || backupState.name !== INSTALL_NAME || backupState.schema !== INSTALL_SCHEMA_VERSION) {
    return false;
  }
  if (!current || typeof current !== 'object' || current.type !== 'command' || typeof current.command !== 'string') {
    return false;
  }
  const knownCommands = Array.isArray(backupState.commands)
    ? backupState.commands
    : backupState.command
      ? [backupState.command]
      : [];
  return knownCommands.includes(current.command);
}

/**
 * @param {string} sourceRoot
 * @param {string} runtimeDir
 */
function copyRuntimeFiles(sourceRoot, runtimeDir) {
  fs.mkdirSync(runtimeDir, { recursive: true });
  writeJsonAtomic(path.join(runtimeDir, 'installation.json'), {
    name: INSTALL_NAME,
    schema: INSTALL_SCHEMA_VERSION,
    installedAt: new Date().toISOString(),
  });
  for (const rel of STATUSLINE_RUNTIME_FILES) {
    const src = path.join(sourceRoot, rel);
    const dst = path.join(runtimeDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

/** @param {string} runtimeDir */
function verifyRuntimeRoot(runtimeDir) {
  assertNotSymlinkOrJunction(runtimeDir);
  if (!fs.existsSync(runtimeDir)) return;
  const { data: marker } = readSettingsBytesAndObject(
    path.join(runtimeDir, 'installation.json'),
    'installation.json'
  );
  if (marker.name !== INSTALL_NAME) {
    throw new Error(`Destination ${runtimeDir} is not owned by ${INSTALL_NAME}; refusing to overwrite.`);
  }
}

/**
 * Installs the standalone `statusLine` runtime and updates `settings.json` atomically.
 * @param {{
 *   sourceRoot: string,
 *   homeDir?: string,
 *   dataDir?: string | null,
 *   nodePath?: string | null,
 *   language?: string | null,
 *   stacked?: boolean,
 *   noColor?: boolean,
 *   platform?: string,
 * }} opts
 */
export function installStatusLine({
  sourceRoot,
  homeDir = os.homedir(),
  dataDir = null,
  nodePath = null,
  language = null,
  stacked = true,
  noColor = false,
  platform = process.platform,
} = /** @type {any} */ ({})) {
  if (!sourceRoot) {
    throw new Error('sourceRoot is required for installStatusLine.');
  }
  if (language && !SUPPORTED_LANGUAGES.includes(/** @type {any} */ (language))) {
    throw new Error(`Invalid language: ${language}`);
  }
  const resolvedNode = resolveNodeExecutable(nodePath);
  const paths = getCliPaths(homeDir);
  const scriptPath = path.join(paths.runtimeDir, 'bin', 'statusline.mjs');
  const cmd = buildStatusLineCommand(resolvedNode, scriptPath, {
    stacked,
    noColor,
    platform,
  });

  withLifecycleLock(paths.base, paths.lockFile, () => {
    assertNotSymlinkOrJunction(paths.settingsFile);
    assertNotSymlinkOrJunction(paths.backupFile);
    verifyRuntimeRoot(paths.runtimeDir);

    const { bytes: beforeBytes, data: settings } = readSettingsBytesAndObject(paths.settingsFile);
    const { data: prevBackup } = readSettingsBytesAndObject(paths.backupFile, 'Install backup file');
    const current = settings.statusLine;
    const owned = ownsStatusLine(current, prevBackup);

    if (fs.existsSync(paths.runtimeDir) && (!prevBackup || prevBackup.name !== INSTALL_NAME)) {
      throw new Error('Recovery metadata is missing or invalid; refusing to overwrite existing runtime.');
    }

    const backup = owned
      ? { ...prevBackup }
      : {
          name: INSTALL_NAME,
          schema: INSTALL_SCHEMA_VERSION,
          previousPresent: Object.hasOwn(settings, 'statusLine'),
          previous: current ?? null,
        };

    const existingCmds = Array.isArray(backup.commands) ? backup.commands : [];
    backup.commands = [...new Set([...existingCmds, ...(owned ? [current.command] : []), cmd])];
    backup.command = cmd;
    writeJsonAtomic(paths.backupFile, backup);

    copyRuntimeFiles(sourceRoot, paths.runtimeDir);

    const checkBytes = fs.existsSync(paths.settingsFile) ? fs.readFileSync(paths.settingsFile) : null;
    if ((beforeBytes === null) !== (checkBytes === null) || (beforeBytes && checkBytes && !beforeBytes.equals(checkBytes))) {
      throw new Error('settings.json changed concurrently during installation; please retry.');
    }

    settings.statusLine = {
      ...(owned ? current : {}),
      type: 'command',
      command: cmd,
      enabled: true,
      stack_with_default: Boolean(stacked),
    };
    writeJsonAtomic(paths.settingsFile, settings);
  });

  if (language) {
    savePreferences(resolveDataDir(dataDir, process.env, homeDir), { language });
  }

  return {
    runtimeDir: paths.runtimeDir,
    settingsFile: paths.settingsFile,
    command: cmd,
    stacked: Boolean(stacked),
  };
}

/**
 * Uninstalls the standalone `statusLine` runtime and restores the prior `settings.json` entry.
 * @param {{ homeDir?: string }} [opts]
 */
export function uninstallStatusLine({ homeDir = os.homedir() } = {}) {
  const paths = getCliPaths(homeDir);
  if (!fs.existsSync(paths.runtimeDir) && !fs.existsSync(paths.backupFile)) {
    return { removed: false, restored: false };
  }

  let restored = false;
  withLifecycleLock(paths.base, paths.lockFile, () => {
    assertNotSymlinkOrJunction(paths.settingsFile);
    assertNotSymlinkOrJunction(paths.backupFile);
    verifyRuntimeRoot(paths.runtimeDir);

    const { data: backup } = readSettingsBytesAndObject(paths.backupFile, 'Install backup file');
    if (backup.name !== INSTALL_NAME || backup.schema !== INSTALL_SCHEMA_VERSION) {
      throw new Error('Recovery metadata is missing or invalid; refusing to uninstall.');
    }

    const { bytes: beforeBytes, data: settings } = readSettingsBytesAndObject(paths.settingsFile);
    if (ownsStatusLine(settings.statusLine, backup)) {
      if (backup.previousPresent) {
        settings.statusLine = backup.previous;
      } else {
        delete settings.statusLine;
      }
      const checkBytes = fs.existsSync(paths.settingsFile) ? fs.readFileSync(paths.settingsFile) : null;
      if ((beforeBytes === null) !== (checkBytes === null) || (beforeBytes && checkBytes && !beforeBytes.equals(checkBytes))) {
        throw new Error('settings.json changed concurrently during uninstall; please retry.');
      }
      writeJsonAtomic(paths.settingsFile, settings);
      restored = true;
    }

    if (fs.existsSync(paths.runtimeDir)) {
      const resolved = fs.realpathSync(paths.runtimeDir);
      if (path.dirname(resolved) !== fs.realpathSync(paths.base) || path.basename(resolved) !== INSTALL_NAME) {
        throw new Error('Refusing to remove unexpected directory outside antigravity-cli base.');
      }
      fs.rmSync(resolved, { recursive: true, force: true });
    }
    if (fs.existsSync(paths.backupFile)) {
      fs.unlinkSync(paths.backupFile);
    }
  });

  return { removed: true, restored };
}

/**
 * Inspects current `statusLine` installation and configuration state without mutating disk.
 * @param {{ homeDir?: string, dataDir?: string | null }} [opts]
 */
export function inspectStatusLine({ homeDir = os.homedir(), dataDir = null } = {}) {
  const paths = getCliPaths(homeDir);
  const { data: settings } = readSettingsBytesAndObject(paths.settingsFile);
  const { data: backup } = readSettingsBytesAndObject(paths.backupFile, 'Install backup file');
  const current = settings.statusLine;
  const configured = ownsStatusLine(current, backup);
  const installed = fs.existsSync(path.join(paths.runtimeDir, 'bin', 'statusline.mjs'));
  return {
    installed,
    configured,
    enabled: configured && current.enabled !== false,
    stackWithDefault: configured && current.stack_with_default === true,
    runtimeDir: paths.runtimeDir,
    settingsFile: paths.settingsFile,
    dataDir: resolveDataDir(dataDir, process.env, homeDir),
  };
}
