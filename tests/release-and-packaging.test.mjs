import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PLUGIN_VERSION } from '../src/constants.mjs';
import {
  bumpVersion,
  checkVersions,
  validatePluginStructure,
} from '../scripts/release-bump.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

test('version is locked at 0.1.0 across package.json, plugin.json, and src/constants.mjs', () => {
  assert.equal(PLUGIN_VERSION, '0.1.0');
  const verified = checkVersions(REPO_ROOT, { tag: 'v0.1.0' });
  assert.equal(verified, '0.1.0');

  const info = validatePluginStructure(REPO_ROOT);
  assert.equal(info.pluginName, 'dash');
  assert.equal(info.version, '0.1.0');
});

test('package.json defines clean packaging allowlist excluding tests, scripts, .github, and AGENTS.md', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '0.1.0');
  assert.equal(pkg.engines?.node, '>=20.0.0');
  assert.ok(fs.existsSync(path.join(REPO_ROOT, pkg.bin['agy-dashboard'])));
  assert.ok(fs.existsSync(path.join(REPO_ROOT, pkg.bin['agy-dashboard-statusline'])));
  assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0);

  const tmpCache = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-npm-cache-'));
  let packRaw;
  try {
    packRaw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, npm_config_cache: tmpCache },
    });
  } finally {
    fs.rmSync(tmpCache, { recursive: true, force: true });
  }
  const packInfo = JSON.parse(packRaw);
  const packEntry = Array.isArray(packInfo)
    ? packInfo[0]
    : Array.isArray(packInfo.files)
      ? packInfo
      : packInfo[pkg.name] || Object.values(packInfo)[0];
  const packedPaths = packEntry.files.map(entry => entry.path);

  // Essential runtime & plugin assets must be present
  assert.ok(packedPaths.includes('package.json'));
  assert.ok(packedPaths.includes('plugin.json'));
  assert.ok(packedPaths.includes('hooks.json'));
  assert.ok(packedPaths.includes('LICENSE'));
  assert.ok(packedPaths.includes('README.md'));
  assert.ok(packedPaths.includes('README.zh-CN.md'));
  assert.ok(packedPaths.includes('assets/logo.svg'));
  assert.ok(packedPaths.includes('bin/cli.mjs'));
  assert.ok(packedPaths.includes('bin/statusline.mjs'));
  assert.ok(packedPaths.includes('skills/stats/SKILL.md'));
  assert.ok(packedPaths.includes('skills/lang/SKILL.md'));

  // Dev-only files must never ship in the npm/release tarball
  for (const filePath of packedPaths) {
    assert.ok(!filePath.startsWith('tests/'), `Unexpected test file in tarball: ${filePath}`);
    assert.ok(!filePath.startsWith('.github/'), `Unexpected workflow file in tarball: ${filePath}`);
    assert.ok(!filePath.startsWith('scripts/'), `Unexpected build script in tarball: ${filePath}`);
    assert.ok(!filePath.startsWith('tmp/'), `Unexpected scratch file in tarball: ${filePath}`);
    assert.notEqual(filePath, 'AGENTS.md', 'AGENTS.md must be excluded from published tarball');
  }
});

test('scripts/release-bump.mjs syncs X.Y.Z atomically and rejects mismatched manifests or tags', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-release-bump-'));
  try {
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'antigravity-dashboard-cli', version: '0.1.0' }, null, 2) + '\n'
    );
    fs.writeFileSync(
      path.join(tmp, 'plugin.json'),
      JSON.stringify({ name: 'dash', version: '0.1.0' }, null, 2) + '\n'
    );
    fs.writeFileSync(
      path.join(tmp, 'src', 'constants.mjs'),
      "export const PLUGIN_VERSION = '0.1.0';\n"
    );

    const bumped = bumpVersion('0.2.3', tmp);
    assert.equal(bumped.previousVersion, '0.1.0');
    assert.equal(bumped.nextVersion, '0.2.3');
    assert.equal(checkVersions(tmp, { tag: 'v0.2.3' }), '0.2.3');

    // Mismatched tag fails
    assert.throws(() => checkVersions(tmp, { tag: 'v0.1.0' }), /does not match/);
    assert.throws(() => checkVersions(tmp, { tag: '0.2.3' }), /must start with "v"/);

    // Mismatched plugin.json fails --check CLI
    fs.writeFileSync(
      path.join(tmp, 'plugin.json'),
      JSON.stringify({ name: 'dash', version: '0.9.9' }, null, 2) + '\n'
    );
    const scriptPath = path.join(REPO_ROOT, 'scripts', 'release-bump.mjs');
    assert.throws(() =>
      execFileSync(process.execPath, [scriptPath, '--check', '--root', tmp], {
        encoding: 'utf8',
        stdio: 'pipe',
      })
    );

    // CLI bump restores synchronization
    const out = execFileSync(process.execPath, [scriptPath, '0.3.0', '--root', tmp], {
      encoding: 'utf8',
    });
    assert.match(out, /0\.2\.3 -> 0\.3\.0/);
    assert.equal(checkVersions(tmp, { tag: 'v0.3.0' }), '0.3.0');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('GitHub Actions CI and Release workflows exist with expected triggers and release steps', () => {
  const ciYaml = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ciYaml, /node-version:\s*\[20,\s*22\]/);
  assert.match(ciYaml, /npm run check/);
  assert.match(ciYaml, /release-bump\.mjs --check/);
  assert.match(ciYaml, /npm pack --dry-run/);
  assert.match(ciYaml, /agy plugin validate/);

  const releaseYaml = fs.readFileSync(
    path.join(REPO_ROOT, '.github', 'workflows', 'release.yml'),
    'utf8'
  );
  assert.match(releaseYaml, /v\*\.\*\.\*/);
  assert.match(releaseYaml, /contents:\s*write/);
  assert.match(releaseYaml, /release-bump\.mjs --check --tag/);
  assert.match(releaseYaml, /sha256sum/);
  assert.match(releaseYaml, /softprops\/action-gh-release@v2/);
});
