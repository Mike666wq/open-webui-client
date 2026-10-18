import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  prepareRelease,
  publishRelease,
  validateReleaseSecrets,
  alreadyPublished,
} from './release-orchestrator.mjs';
import { checkVersions } from './manage-version.mjs';

const validSecrets = {
  ANDROID_KEYSTORE_PASSWORD: 'a'.repeat(32),
  ANDROID_KEYSTORE_BASE64: 'AQIDBA==',
  ANDROID_RELEASE_SECRETS_VALIDATED: 'true',
};
const runOptions = {
  eventName: 'workflow_dispatch',
  ref: 'refs/heads/main',
  runId: '456789',
  runNumber: '89',
  workspaceSha: 'a'.repeat(40),
  secrets: validSecrets,
};

async function makeRoot(version = '0.2.0') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'owc-release-test-'));
  await mkdir(path.join(root, 'src-tauri'), { recursive: true });
  const files = {
    'package.json': JSON.stringify({ name: 'open-webui-client', version }, null, 2) + '\n',
    'package-lock.json': JSON.stringify({
      name: 'open-webui-client', version,
      packages: { '': { name: 'open-webui-client', version } },
    }, null, 2) + '\n',
    [path.join('src-tauri', 'tauri.conf.json')]: JSON.stringify({
      version, identifier: 'local.openwebui.client',
    }, null, 2) + '\n',
    [path.join('src-tauri', 'Cargo.toml')]: `[package]\nname = "open-webui-client"\nversion = "${version}"\n`,
    [path.join('src-tauri', 'Cargo.lock')]: `[[package]]\nname = "open-webui-client"\nversion = "${version}"\n`,
  };
  await Promise.all(Object.entries(files).map(([relativePath, content]) =>
    writeFile(path.join(root, relativePath), content)));
  return root;
}

function fakeGitAdapter() {
  const state = {
    mainSha: 'a'.repeat(40),
    markers: new Map(),
    calls: [],
    failCommit: false,
  };
  return {
    state,
    async getMainHead() { state.calls.push('getMainHead'); return state.mainSha; },
    async findPreparationByRunId(runId) {
      state.calls.push('findPreparationByRunId');
      return state.markers.get(runId) || null;
    },
    async isAncestor(ancestor, descendant) {
      state.calls.push('isAncestor');
      return ancestor === descendant || [...state.markers.values()].some((pin) => pin.commitSha === ancestor && descendant === state.mainSha);
    },
    async verifyVersionSnapshot(commitSha, version) {
      state.calls.push('verifyVersionSnapshot');
      return [...state.markers.values()].some((pin) => pin.commitSha === commitSha && pin.version === version);
    },
    async commitReleaseBump(input) {
      state.calls.push('commitReleaseBump');
      assert.equal(input.expectedBaseSha, state.mainSha);
      assert.match(input.marker, /^openwebui-release-run:\d+$/);
      assert.deepEqual(Object.keys(input.versionFiles).sort(), [
        'package-lock.json', 'package.json', 'src-tauri/Cargo.lock',
        'src-tauri/Cargo.toml', 'src-tauri/tauri.conf.json',
      ]);
      if (state.failCommit) throw new Error('main ref update rejected');
      state.mainSha = 'b'.repeat(40);
      state.markers.set(input.runId, {
        runId: input.runId,
        version: input.version,
        tag: input.tag,
        commitSha: state.mainSha,
      });
      return state.mainSha;
    },
  };
}

function fakePublishAdapter({ tagTarget = null, release = null, failPublish = false } = {}) {
  const state = {
    mainSha: 'b'.repeat(40),
    tagTarget,
    release: release && { ...release, assets: [...(release.assets || [])] },
    calls: [],
    uploadedAssets: [],
    createdTags: 0,
    published: 0,
    failPublish,
  };
  return {
    state,
    async getMainHead() { state.calls.push('getMainHead'); return state.mainSha; },
    async isAncestor(ancestor, descendant) {
      state.calls.push('isAncestor');
      return ancestor === 'b'.repeat(40) && descendant === state.mainSha;
    },
    async assertReleaseWorkflowUnchanged() { state.calls.push('assertReleaseWorkflowUnchanged'); },
    async getReleaseByTag() { state.calls.push('getReleaseByTag'); return state.release; },
    async getTagTarget() { state.calls.push('getTagTarget'); return state.tagTarget; },
    async getReleaseAssetDigest(asset) {
      state.calls.push('getReleaseAssetDigest');
      return asset.testDigest || null;
    },
    async createTag(tag, sha) {
      state.calls.push('createTag');
      assert.equal(sha, 'b'.repeat(40));
      state.createdTags += 1;
      state.tagTarget = sha;
      state.tag = tag;
    },
    async createDraftRelease({ tag }) {
      state.calls.push('createDraftRelease');
      state.release = { id: 42, tag, draft: true, prerelease: false, assets: [] };
      return state.release;
    },
    async replaceDraftAssets(id, assets) {
      state.calls.push('replaceDraftAssets');
      assert.equal(id, state.release.id);
      assert.equal(state.release.draft, true);
      state.uploadedAssets = assets;
      state.release.assets = assets;
    },
    async publishDraft(id) {
      state.calls.push('publishDraft');
      assert.equal(id, state.release.id);
      if (state.failPublish) throw new Error('temporary publish failure');
      state.release.draft = false;
      state.published += 1;
    },
  };
}

function validPin(overrides = {}) {
  return {
    runId: '456789',
    version: '0.2.1',
    commitSha: 'b'.repeat(40),
    tag: 'v0.2.1',
    versionCode: 1089,
    ...overrides,
  };
}

function checks(pin = validPin(), overrides = {}) {
  return {
    sourceSha: pin.commitSha,
    windows: 'success',
    macos: 'success',
    android: 'success',
    ...overrides,
  };
}

function artifacts(pin = validPin()) {
  return {
    windows: {
      name: `Open-WebUI-Client-${pin.version}-windows-x64-setup.exe`,
      bytes: Buffer.from('windows-package'), sourceSha: pin.commitSha,
    },
    macos: {
      name: `Open-WebUI-Client-${pin.version}-macos-arm64.dmg`,
      bytes: Buffer.from('mac-package'), sourceSha: pin.commitSha,
    },
    android: {
      name: `Open-WebUI-Client-${pin.version}-android-arm64-vc${pin.versionCode}.apk`,
      bytes: Buffer.from('android-package'), sourceSha: pin.commitSha,
    },
  };
}

function publicAssetMetadata(pin = validPin()) {
  const packages = Object.values(artifacts(pin)).map(({ name, bytes }) => ({ name, bytes }));
  const sums = `${packages.map(({ name, bytes }) => `${createHash('sha256').update(bytes).digest('hex')}  ${name}`).join('\n')}\n`;
  const assets = [...packages, { name: 'SHA256SUMS', bytes: Buffer.from(sums) }];
  return assets.map(({ name, bytes }) => ({
    name,
    size: bytes.byteLength,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  }));
}

test('release secrets must validate before any release adapter operation', async () => {
  assert.throws(() => validateReleaseSecrets({ ...validSecrets, ANDROID_KEYSTORE_BASE64: 'bad===' }), /missing or invalid/);
  assert.throws(() => validateReleaseSecrets({ ...validSecrets, ANDROID_RELEASE_SECRETS_VALIDATED: 'false' }), /workflow keystore validation/);
  const root = await makeRoot();
  const adapter = fakeGitAdapter();
  try {
    await assert.rejects(prepareRelease(adapter, {
      ...runOptions,
      secrets: { ...validSecrets, ANDROID_KEYSTORE_PASSWORD: '' },
      root,
    }), /password is missing or invalid/);
    assert.deepEqual(adapter.state.calls, []);
    assert.equal(await checkVersions(root), '0.2.0');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prepare makes one patch commit with synchronized lock versions and reuses its marker on rerun', async () => {
  const root = await makeRoot();
  const adapter = fakeGitAdapter();
  try {
    const pin = await prepareRelease(adapter, { ...runOptions, root });
    assert.deepEqual(pin, {
      runId: '456789', version: '0.2.1', tag: 'v0.2.1', commitSha: 'b'.repeat(40), versionCode: 1089,
    });
    assert.equal(await checkVersions(root), '0.2.1');
    const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
    assert.equal(lock.version, '0.2.1');
    assert.equal(lock.packages[''].version, '0.2.1');

    adapter.state.mainSha = 'c'.repeat(40);
    const retry = await prepareRelease(adapter, { ...runOptions, workspaceSha: 'a'.repeat(40), root });
    assert.deepEqual(retry, pin);
    assert.equal(adapter.state.calls.filter((call) => call === 'commitReleaseBump').length, 1);
    assert.equal(await checkVersions(root), '0.2.1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prepare fails closed on a stale main checkout, inconsistent versions, or a main race', async () => {
  const root = await makeRoot();
  const adapter = fakeGitAdapter();
  try {
    assert.deepEqual(await prepareRelease(adapter, {
      ...runOptions, eventName: 'push', workspaceSha: 'd'.repeat(40), root,
    }), { superseded: true });
    assert.equal(await checkVersions(root), '0.2.0');

    await writeFile(path.join(root, 'src-tauri', 'Cargo.lock'), '[[package]]\nname = "open-webui-client"\nversion = "0.1.9"\n');
    await assert.rejects(prepareRelease(adapter, { ...runOptions, root }), /App versions disagree/);
    assert.equal(adapter.state.calls.filter((call) => call === 'commitReleaseBump').length, 0);

    const raceRoot = await makeRoot();
    adapter.state.failCommit = true;
    await assert.rejects(prepareRelease(adapter, { ...runOptions, root: raceRoot }), /main ref update rejected/);
    assert.equal(await checkVersions(raceRoot), '0.2.0', 'failed FF update rolls local version files back');
    await rm(raceRoot, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('publish requires all three successful checks and artifacts pinned to the same SHA', async () => {
  const pin = validPin();
  const adapter = fakePublishAdapter();
  await assert.rejects(publishRelease(adapter, pin, checks(pin, { android: 'failure' }), artifacts(pin)), /all pass/);
  const wrongArtifacts = artifacts(pin);
  wrongArtifacts.macos.sourceSha = 'c'.repeat(40);
  await assert.rejects(publishRelease(adapter, pin, checks(pin), wrongArtifacts), /macos package/);
  assert.equal(adapter.state.createdTags, 0);
  assert.equal(adapter.state.release, null);
});

test('publish refuses to move an existing tag or mutate a public release', async () => {
  const pin = validPin();
  const mismatchedTag = fakePublishAdapter({ tagTarget: 'c'.repeat(40) });
  await assert.rejects(publishRelease(mismatchedTag, pin, checks(pin), artifacts(pin)), /refusing to move it/);
  assert.equal(mismatchedTag.state.createdTags, 0);

  const publicRelease = fakePublishAdapter({
    tagTarget: pin.commitSha,
    release: { id: 9, tag: pin.tag, draft: false, prerelease: false, assets: [{ name: 'keep.exe' }] },
  });
  await assert.rejects(publishRelease(publicRelease, pin, checks(pin), artifacts(pin)), /assets are immutable/);
  assert.equal(publicRelease.state.calls.includes('replaceDraftAssets'), false);
  assert.equal(publicRelease.state.published, 0);
});

test('retrying a matching public release verifies all digests and performs no writes', async () => {
  const pin = validPin();
  const adapter = fakePublishAdapter({
    tagTarget: pin.commitSha,
    release: {
      id: 10,
      tag: pin.tag,
      draft: false,
      prerelease: false,
      assets: publicAssetMetadata(pin),
    },
  });
  const result = await publishRelease(adapter, pin, checks(pin), artifacts(pin));
  assert.equal(result.alreadyPublished, true);
  assert.equal(adapter.state.createdTags, 0);
  assert.equal(adapter.state.calls.includes('replaceDraftAssets'), false);
  assert.equal(adapter.state.calls.includes('publishDraft'), false);
});

test('draft retry replaces assets, publishes only three packages plus their checksums', async () => {
  const pin = validPin();
  const adapter = fakePublishAdapter({
    tagTarget: pin.commitSha,
    release: { id: 42, tag: pin.tag, draft: true, prerelease: false, assets: [{ name: 'stale.exe' }] },
    failPublish: true,
  });
  await assert.rejects(publishRelease(adapter, pin, checks(pin), artifacts(pin)), /temporary publish failure/);
  assert.equal(adapter.state.release.draft, true);
  adapter.state.failPublish = false;
  const result = await publishRelease(adapter, pin, checks(pin), artifacts(pin));
  assert.equal(adapter.state.createdTags, 0);
  assert.equal(adapter.state.published, 1);
  assert.equal(adapter.state.release.draft, false);
  assert.deepEqual(adapter.state.uploadedAssets.map(({ name }) => name), [
    `Open-WebUI-Client-${pin.version}-windows-x64-setup.exe`,
    `Open-WebUI-Client-${pin.version}-macos-arm64.dmg`,
    `Open-WebUI-Client-${pin.version}-android-arm64-vc${pin.versionCode}.apk`,
    'SHA256SUMS',
  ]);
  const checksumAsset = adapter.state.uploadedAssets.find(({ name }) => name === 'SHA256SUMS');
  const checksumText = checksumAsset.bytes.toString('utf8');
  assert.equal(checksumText.trim().split('\n').length, 3);
  for (const platform of ['windows', 'macos', 'android']) {
    const packageAsset = adapter.state.uploadedAssets.find(({ name }) => name.endsWith(
      platform === 'windows' ? '.exe' : platform === 'macos' ? '.dmg' : '.apk'));
    const expected = createHash('sha256').update(packageAsset.bytes).digest('hex');
    assert.match(checksumText, new RegExp(`^${expected}  ${packageAsset.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  }
  assert.equal(result.tag, pin.tag);
  assert.equal(result.commitSha, pin.commitSha);
});

test('main push prepares a release but untrusted refs/events cannot', async () => {
  const root = await makeRoot();
  try {
    const adapter = fakeGitAdapter();
    const pin = await prepareRelease(adapter, { ...runOptions, eventName: 'push', root });
    assert.equal(pin.version, '0.2.1');
    await assert.rejects(prepareRelease(adapter, { ...runOptions, eventName: 'pull_request', root }), /restricted/);
    await assert.rejects(prepareRelease(adapter, { ...runOptions, ref: 'refs/heads/feature', root }), /restricted/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('published-run preflight verifies existing public assets without preparing or rebuilding', async () => {
  const pin = validPin();
  const adapter = fakePublishAdapter({ tagTarget: pin.commitSha, release: {
    id: 10, tag: pin.tag, draft: false, prerelease: false, assets: publicAssetMetadata(pin),
  } });
  adapter.getReleaseAssetDigest = async (asset) => asset.digest.slice(7);
  adapter.getPublicChecksums = async () => Object.values(artifacts(pin)).map(({ name, bytes }) =>
    `${createHash('sha256').update(bytes).digest('hex')}  ${name}`).join('\n') + '\n';
  assert.equal(await alreadyPublished(adapter, pin), true);
  assert.equal(adapter.state.createdTags, 0);
  adapter.getPublicChecksums = async () => 'corrupt';
  await assert.rejects(alreadyPublished(adapter, pin), /checksum/);
});
