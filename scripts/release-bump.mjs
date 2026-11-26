#!/usr/bin/env node
// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_ROOT = path.resolve(__dirname, '..');

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const CONSTANTS_VERSION_RE = /(export\s+const\s+PLUGIN_VERSION\s*=\s*['"])([^'"]+)(['"]\s*;)/;

/**
 * Normalizes a SemVer string (stripping optional leading `v` when `allowLeadingV` is true).
 * @param {unknown} raw
 * @param {{ allowLeadingV?: boolean }} [opts]
 * @returns {string}
 */
export function parseSemver(raw, { allowLeadingV = false } = {}) {
  if (typeof raw !== 'string') {
    throw new Error(`Expected SemVer version string, received ${typeof raw}`);
  }
  const trimmed = raw.trim();
  const candidate = allowLeadingV ? trimmed.replace(/^v/, '') : trimmed;
  if (!SEMVER_RE.test(candidate)) {
    throw new Error(`Invalid SemVer version "${raw}". Expected X.Y.Z (e.g. 0.1.0).`);
  }
  return candidate;
}

/** @param {string} filePath */
function readJsonObject(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${filePath} must contain a top-level JSON object.`);
  }
  return parsed;
}

/**
 * Reads version strings from `package.json`, `plugin.json`, and `src/constants.mjs`.
 * @param {string} [rootDir=DEFAULT_ROOT]
 */
export function readManifestVersions(rootDir = DEFAULT_ROOT) {
  const pkgPath = path.join(rootDir, 'package.json');
  const pluginPath = path.join(rootDir, 'plugin.json');
  const constantsPath = path.join(rootDir, 'src', 'constants.mjs');

  const pkg = readJsonObject(pkgPath);
  const plugin = readJsonObject(pluginPath);
  const constantsText = fs.readFileSync(constantsPath, 'utf8');
  const constMatch = constantsText.match(CONSTANTS_VERSION_RE);
  if (!constMatch) {
    throw new Error(`Missing PLUGIN_VERSION export in ${constantsPath}`);
  }

  return {
    packageVersion: String(pkg.version ?? ''),
    pluginVersion: String(plugin.version ?? ''),
    constantsVersion: constMatch[2],
  };
}

/**
 * Verifies that `package.json`, `plugin.json`, `src/constants.mjs` (and optional git `--tag`)
 * all carry the exact same valid SemVer version.
 * @param {string} [rootDir=DEFAULT_ROOT]
 * @param {{ tag?: string | null }} [opts]
 */
export function checkVersions(rootDir = DEFAULT_ROOT, { tag = null } = {}) {
  const { packageVersion, pluginVersion, constantsVersion } = readManifestVersions(rootDir);
  parseSemver(packageVersion);
  parseSemver(pluginVersion);
  parseSemver(constantsVersion);

  if (packageVersion !== pluginVersion || packageVersion !== constantsVersion) {
    throw new Error(
      `Version mismatch detected: package.json=${packageVersion}, plugin.json=${pluginVersion}, src/constants.mjs=${constantsVersion}`
    );
  }

  if (tag !== null && tag !== undefined) {
    const cleanTag = String(tag).trim().replace(/^refs\/tags\//, '');
    if (!cleanTag.startsWith('v')) {
      throw new Error(`Release tag "${cleanTag}" must start with "v" (expected "v${packageVersion}").`);
    }
    const tagVersion = parseSemver(cleanTag.slice(1));
    if (tagVersion !== packageVersion) {
      throw new Error(
        `Release tag "${cleanTag}" does not match manifest version "${packageVersion}".`
      );
    }
  }

  return packageVersion;
}

/**
 * Updates `package.json`, `plugin.json`, and `src/constants.mjs` to `nextVersion`.
 * @param {string} rawVersion
 * @param {string} [rootDir=DEFAULT_ROOT]
 */
export function bumpVersion(rawVersion, rootDir = DEFAULT_ROOT) {
  const nextVersion = parseSemver(rawVersion, { allowLeadingV: true });
  const pkgPath = path.join(rootDir, 'package.json');
  const pluginPath = path.join(rootDir, 'plugin.json');
  const constantsPath = path.join(rootDir, 'src', 'constants.mjs');

  const pkg = readJsonObject(pkgPath);
  const plugin = readJsonObject(pluginPath);
  const constantsText = fs.readFileSync(constantsPath, 'utf8');
  if (!CONSTANTS_VERSION_RE.test(constantsText)) {
    throw new Error(`Missing PLUGIN_VERSION export in ${constantsPath}`);
  }

  const previousVersion = String(pkg.version ?? '');
  pkg.version = nextVersion;
  plugin.version = nextVersion;
  const updatedConstants = constantsText.replace(CONSTANTS_VERSION_RE, `$1${nextVersion}$3`);

  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  fs.writeFileSync(pluginPath, JSON.stringify(plugin, null, 2) + '\n', 'utf8');
  fs.writeFileSync(constantsPath, updatedConstants, 'utf8');

  checkVersions(rootDir);
  return { previousVersion, nextVersion };
}

/**
 * Validates `plugin.json`, `hooks.json`, `skills/`, and `assets/` structure in pure Node.js
 * so CI environments without the `agy` binary still enforce plugin integrity.
 * @param {string} [rootDir=DEFAULT_ROOT]
 */
export function validatePluginStructure(rootDir = DEFAULT_ROOT) {
  const pluginPath = path.join(rootDir, 'plugin.json');
  const hooksPath = path.join(rootDir, 'hooks.json');
  const skillsDir = path.join(rootDir, 'skills');

  const plugin = readJsonObject(pluginPath);
  if (typeof plugin.name !== 'string' || !plugin.name.trim()) {
    throw new Error('plugin.json must define a non-empty "name".');
  }
  parseSemver(String(plugin.version ?? ''));

  if (plugin.logo) {
    const logoPath = path.join(rootDir, String(plugin.logo));
    if (!fs.existsSync(logoPath)) {
      throw new Error(`plugin.json logo file does not exist: ${plugin.logo}`);
    }
  }

  const hooks = readJsonObject(hooksPath);
  for (const [groupName, events] of Object.entries(hooks)) {
    if (!events || typeof events !== 'object' || Array.isArray(events)) {
      throw new Error(`hooks.json entry "${groupName}" must be an object.`);
    }
    for (const [eventName, handlers] of Object.entries(events)) {
      if (!Array.isArray(handlers) || handlers.length === 0) {
        throw new Error(`hooks.json "${groupName}.${eventName}" must be a non-empty array.`);
      }
      for (const h of handlers) {
        if (h.type === 'command' && typeof h.command === 'string') {
          const match = h.command.match(/\.\/([^\s'"]+)/);
          if (match && !fs.existsSync(path.join(rootDir, match[1]))) {
            throw new Error(`Hook target script missing: ${match[1]}`);
          }
        }
      }
    }
  }

  if (fs.existsSync(skillsDir)) {
    for (const dirent of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const skillFile = path.join(skillsDir, dirent.name, 'SKILL.md');
      if (!fs.existsSync(skillFile)) {
        throw new Error(`Missing SKILL.md in skills/${dirent.name}`);
      }
      const content = fs.readFileSync(skillFile, 'utf8');
      if (!/^---\r?\n[\s\S]*?\bname:\s*\S+[\s\S]*?\bdescription:\s*[\s\S]*?\r?\n---/.test(content)) {
        throw new Error(`Invalid YAML frontmatter in skills/${dirent.name}/SKILL.md`);
      }
    }
  }

  return { pluginName: plugin.name, version: plugin.version };
}

/** @param {string[]} argv */
function parseCliArgs(argv) {
  let check = false;
  let validatePlugin = false;
  /** @type {string | null} */
  let tag = null;
  let rootDir = DEFAULT_ROOT;
  /** @type {string | null} */
  let versionArg = null;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') {
      check = true;
    } else if (arg === '--validate-plugin') {
      validatePlugin = true;
    } else if (arg === '--tag') {
      const val = argv[++i];
      if (!val) throw new Error('Missing value for --tag');
      tag = val;
    } else if (arg === '--root') {
      const val = argv[++i];
      if (!val) throw new Error('Missing value for --root');
      rootDir = path.resolve(val);
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (!arg.startsWith('-') && !versionArg) {
      versionArg = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { check, validatePlugin, tag, rootDir, versionArg, help };
}

function main() {
  const { check, validatePlugin, tag, rootDir, versionArg, help } = parseCliArgs(
    process.argv.slice(2)
  );

  if (help || (!check && !validatePlugin && !versionArg)) {
    process.stdout.write(
      `Usage:\n` +
        `  node scripts/release-bump.mjs <X.Y.Z>            Sync version across manifests & constants\n` +
        `  node scripts/release-bump.mjs --check            Verify all versions match\n` +
        `  node scripts/release-bump.mjs --check --tag vX.Y.Z  Verify git tag matches manifests\n` +
        `  node scripts/release-bump.mjs --validate-plugin  Validate plugin.json, hooks, and skills\n`
    );
    if (!help) process.exitCode = 1;
    return;
  }

  if (validatePlugin) {
    const info = validatePluginStructure(rootDir);
    process.stdout.write(`Plugin structure valid: ${info.pluginName}@${info.version}\n`);
  }

  if (check) {
    const verified = checkVersions(rootDir, { tag });
    const suffix = tag ? ` (matched tag ${tag})` : '';
    process.stdout.write(
      `Version check passed: ${verified} (package.json, plugin.json, src/constants.mjs)${suffix}\n`
    );
    return;
  }

  if (versionArg) {
    const { previousVersion, nextVersion } = bumpVersion(versionArg, rootDir);
    process.stdout.write(
      `Synchronized version: ${previousVersion} -> ${nextVersion} (package.json, plugin.json, src/constants.mjs)\n`
    );
  }
}

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('release-bump.mjs') || process.argv[1].includes('release-bump.mjs'));

if (isDirectRun) {
  try {
    main();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n`);
    process.exitCode = 1;
  }
}
