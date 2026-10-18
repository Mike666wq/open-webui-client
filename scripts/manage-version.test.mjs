import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  bumpVersions,
  checkVersions,
  isStableSemver,
  versionCodeFromRunNumber,
} from './manage-version.mjs';

async function makeFixture(version = '0.2.0') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'owc-version-test-'));
  await mkdir(path.join(root, 'src-tauri', 'plugins', 'connection-controls'), { recursive: true });
  const files = {
    'package.json': JSON.stringify({
      name: 'open-webui-client',
      private: true,
      version,
      dependencies: { example: '1.2.3' },
    }, null, 2) + '\n',
    'package-lock.json': JSON.stringify({
      name: 'open-webui-client',
      version,
      lockfileVersion: 3,
      packages: {
        '': { name: 'open-webui-client', version, dependencies: { example: '1.2.3' } },
        'node_modules/example': { version: '1.2.3' },
        'node_modules/@tauri-apps/api': { version: '2.12.3' },
      },
    }, null, 2) + '\n',
    [path.join('src-tauri', 'tauri.conf.json')]: JSON.stringify({
      version,
      identifier: 'local.openwebui.client',
    }, null, 2) + '\n',
    [path.join('src-tauri', 'Cargo.toml')]: `[package]\nname = "open-webui-client"\nversion = "${version}"\nedition = "2024"\n\n[dependencies]\nexample = "=1.2.3"\n`,
    [path.join('src-tauri', 'Cargo.lock')]: `version = 4\n\n[[package]]\nname = "open-webui-client"\nversion = "${version}"\ndependencies = [\n "example 1.2.3",\n]\n\n[[package]]\nname = "example"\nversion = "1.2.3"\n\n[[package]]\nname = "tauri-plugin-connection-controls"\nversion = "0.1.0"\n`,
    [path.join('src-tauri', 'plugins', 'connection-controls', 'Cargo.toml')]: '[package]\nname = "tauri-plugin-connection-controls"\nversion = "0.1.0"\n',
  };
  await Promise.all(Object.entries(files).map(([relativePath, contents]) =>
    writeFile(path.join(root, relativePath), contents)));
  return { root };
}

test('stable version validation and Android release code bounds are strict', () => {
  for (const version of ['0.0.0', '0.2.0', '12.345.678']) assert.equal(isStableSemver(version), true);
  for (const version of ['v0.2.0', '00.2.0', '0.02.0', '0.2', '0.2.0-beta.1', '0.2.0+build']) {
    assert.equal(isStableSemver(version), false, version);
  }
  assert.equal(versionCodeFromRunNumber(1), 1001);
  assert.equal(versionCodeFromRunNumber(2_099_999_000), 2_100_000_000);
  for (const runNumber of [0, -1, 1.5, Number.MAX_SAFE_INTEGER, 2_099_999_001]) {
    assert.throws(() => versionCodeFromRunNumber(runNumber));
  }
});

test('check validates every app version location and fixed identifier', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(await checkVersions(), packageJson.version);
  const { root } = await makeFixture();
  try {
    assert.equal(await checkVersions(root), '0.2.0');
    await writeFile(path.join(root, 'src-tauri', 'tauri.conf.json'), JSON.stringify({
      version: '0.2.0', identifier: 'unexpected.application.id',
    }));
    await assert.rejects(checkVersions(root), /identifier must remain local\.openwebui\.client/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bump updates only the app versions after validating all files', async () => {
  const { root } = await makeFixture();
  try {
    assert.deepEqual(await bumpVersions('minor', root), { previous: '0.2.0', current: '0.3.0' });
    assert.equal(await checkVersions(root), '0.3.0');
    const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const packageLock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
    const tauri = JSON.parse(await readFile(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
    const cargoToml = await readFile(path.join(root, 'src-tauri', 'Cargo.toml'), 'utf8');
    const cargoLock = await readFile(path.join(root, 'src-tauri', 'Cargo.lock'), 'utf8');
    const pluginCargo = await readFile(path.join(root, 'src-tauri', 'plugins', 'connection-controls', 'Cargo.toml'), 'utf8');
    assert.equal(packageJson.dependencies.example, '1.2.3');
    assert.equal(packageLock.packages['node_modules/example'].version, '1.2.3');
    assert.equal(packageLock.packages['node_modules/@tauri-apps/api'].version, '2.12.3');
    assert.equal(tauri.identifier, 'local.openwebui.client');
    assert.match(cargoToml, /example = "=1\.2\.3"/);
    assert.match(cargoLock, /name = "example"\nversion = "1\.2\.3"/);
    assert.match(cargoLock, /name = "tauri-plugin-connection-controls"\nversion = "0\.1\.0"/);
    assert.match(pluginCargo, /version = "0\.1\.0"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('patch bump advances the current main release baseline from 0.2.1 to 0.2.2', async () => {
  const { root } = await makeFixture('0.2.1');
  try {
    assert.deepEqual(await bumpVersions('patch', root), { previous: '0.2.1', current: '0.2.2' });
    assert.equal(await checkVersions(root), '0.2.2');
    const packageLock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
    assert.equal(packageLock.version, '0.2.2');
    assert.equal(packageLock.packages[''].version, '0.2.2');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('invalid, stale, or inconsistent bump inputs do not write any version file', async () => {
  const { root } = await makeFixture();
  try {
    const paths = [
      'package.json',
      'package-lock.json',
      path.join('src-tauri', 'tauri.conf.json'),
      path.join('src-tauri', 'Cargo.toml'),
      path.join('src-tauri', 'Cargo.lock'),
    ];
    const before = await Promise.all(paths.map((relativePath) => readFile(path.join(root, relativePath), 'utf8')));
    await assert.rejects(bumpVersions('0.2.0', root), /must be greater/);
    await assert.rejects(bumpVersions('0.2.0-beta.1', root), /stable X\.Y\.Z/);
    const tauriPath = path.join(root, 'src-tauri', 'tauri.conf.json');
    await writeFile(tauriPath, JSON.stringify({ version: '0.1.0', identifier: 'local.openwebui.client' }));
    await assert.rejects(bumpVersions('patch', root), /App versions disagree/);
    const after = await Promise.all(paths.map((relativePath) => readFile(path.join(root, relativePath), 'utf8')));
    for (const index of [0, 1, 3, 4]) assert.equal(after[index], before[index]);
    assert.equal(after[2], JSON.stringify({ version: '0.1.0', identifier: 'local.openwebui.client' }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Android workflow migration keeps codes above previously released APKs', () => {
  assert.equal(versionCodeFromRunNumber(1, 100000), 100001);
  assert.equal(versionCodeFromRunNumber(2, 100000), 100002);
  assert.throws(() => versionCodeFromRunNumber(1, -1));
  assert.throws(() => versionCodeFromRunNumber(2_100_000_000, 100000));
});
