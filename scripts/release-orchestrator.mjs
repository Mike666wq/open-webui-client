import { createHash } from 'node:crypto';
import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { releaseEvent, isDocumentationOnly } from './release-policy.mjs';
import { verifyManifest } from './artifact-integrity.mjs';
import { fileURLToPath } from 'node:url';
import {
  bumpVersions,
  checkVersions,
  isStableSemver,
  validateVersionContents,
  versionCodeFromRunNumber,
} from './manage-version.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const VERSION_FILES = [
  'package.json',
  'package-lock.json',
  'src-tauri/tauri.conf.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
];
const PLATFORM_ORDER = ['windows', 'macos', 'android'];
const PLATFORM_EXTENSIONS = { windows: '.exe', macos: '.dmg', android: '.apk' };
const RUN_MARKER_PREFIX = 'openwebui-release-run:';
const SHA_PATTERN = /^[a-f0-9]{40}$/i;

function validRunId(runId) {
  return typeof runId === 'string' && /^[1-9]\d{0,19}$/.test(runId);
}

export function validateReleaseSecrets(secrets) {
  const password = secrets?.ANDROID_KEYSTORE_PASSWORD;
  const encoded = secrets?.ANDROID_KEYSTORE_BASE64;
  if (secrets?.ANDROID_RELEASE_SECRETS_VALIDATED !== 'true') {
    throw new Error('Android signing secrets must pass the workflow keystore validation before release preparation');
  }
  if (typeof password !== 'string' || password.length < 32) {
    throw new Error('Android release keystore password is missing or invalid');
  }
  if (typeof encoded !== 'string' || encoded.length === 0 || encoded.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error('Android release keystore data is missing or invalid');
  }
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== encoded) {
    throw new Error('Android release keystore data is missing or invalid');
  }
  return true;
}

function validatePin(pin) {
  if (!pin || !validRunId(String(pin.runId)) || !isStableSemver(pin.version) ||
      pin.tag !== `v${pin.version}` || !SHA_PATTERN.test(pin.commitSha) ||
      !Number.isSafeInteger(pin.versionCode) || pin.versionCode < 1001 || pin.versionCode > 2_100_000_000) {
    throw new Error('Release pin is incomplete or invalid');
  }
  return {
    runId: String(pin.runId),
    version: pin.version,
    tag: pin.tag,
    commitSha: pin.commitSha.toLowerCase(),
    versionCode: pin.versionCode,
  };
}

function pinFromMarker(marker, runId, runNumber) {
  if (!marker || String(marker.runId) !== runId) {
    throw new Error('The stored release marker does not match this workflow run');
  }
  return validatePin({
    ...marker,
    runId,
    versionCode: versionCodeFromRunNumber(runNumber),
  });
}

async function snapshotVersionFiles(root) {
  return new Map(await Promise.all(VERSION_FILES.map(async (relativePath) => [
    relativePath,
    await readFile(path.join(root, relativePath)),
  ])));
}

async function restoreVersionFiles(root, snapshot) {
  await Promise.all([...snapshot].map(([relativePath, contents]) =>
    writeFile(path.join(root, relativePath), contents)));
}

export async function prepareRelease(adapter, {
  eventName,
  ref,
  runId,
  runNumber,
  workspaceSha,
  secrets,
  root = projectRoot,
}) {
  validateReleaseSecrets(secrets);
  if (!releaseEvent(eventName, ref)) {
    throw new Error('Release preparation is restricted to main push or manual workflow runs');
  }
  if (!validRunId(String(runId))) throw new Error('GitHub run ID is invalid');
  const normalizedRunId = String(runId);
  const versionCode = versionCodeFromRunNumber(Number(runNumber));

  // Check the marker first so a rerun reuses its original source SHA and version.
  const existing = await adapter.findPreparationByRunId(normalizedRunId);
  if (existing) {
    const pin = pinFromMarker(existing, normalizedRunId, Number(runNumber));
    const mainSha = await adapter.getMainHead();
    if (!await adapter.isAncestor(pin.commitSha, mainSha)) {
      throw new Error('The pinned release commit is no longer in main history');
    }
    if (!await adapter.verifyVersionSnapshot(pin.commitSha, pin.version)) {
      throw new Error('The release commit version snapshot does not match its run marker');
    }
    return pin;
  }

  const mainSha = await adapter.getMainHead();
  if (!SHA_PATTERN.test(mainSha) || !SHA_PATTERN.test(workspaceSha) || mainSha.toLowerCase() !== workspaceSha.toLowerCase()) {
    return { superseded: true };
  }
  const previousVersion = await checkVersions(root);
  const snapshot = await snapshotVersionFiles(root);
  try {
    const { current: version } = await bumpVersions('patch', root);
    const tag = `v${version}`;
    const marker = `${RUN_MARKER_PREFIX}${normalizedRunId}`;
    const versionFiles = Object.fromEntries(await Promise.all(VERSION_FILES.map(async (relativePath) => [
      relativePath.replaceAll(path.sep, '/'),
      await readFile(path.join(root, relativePath), 'utf8'),
    ])));
    const commitSha = await adapter.commitReleaseBump({
      expectedBaseSha: mainSha.toLowerCase(),
      runId: normalizedRunId,
      previousVersion,
      version,
      tag,
      versionCode,
      marker,
      versionFiles,
    });
    return validatePin({ runId: normalizedRunId, version, tag, commitSha, versionCode });
  } catch (error) {
    await restoreVersionFiles(root, snapshot);
    throw error;
  }
}

function artifactName(platform, version, versionCode) {
  switch (platform) {
    case 'windows': return `Open-WebUI-Client-${version}-windows-x64-setup.exe`;
    case 'macos': return `Open-WebUI-Client-${version}-macos-arm64.dmg`;
    case 'android': return `Open-WebUI-Client-${version}-android-arm64-vc${versionCode}.apk`;
    default: throw new Error(`Unknown release platform: ${platform}`);
  }
}

function prepareReleaseAssets(pin, checks, artifacts) {
  if (!checks || checks.sourceSha?.toLowerCase() !== pin.commitSha ||
      PLATFORM_ORDER.some((platform) => checks[platform] !== 'success')) {
    throw new Error('Windows, macOS, and Android builds must all pass for the pinned source SHA');
  }
  const names = new Set();
  const packages = [];
  for (const platform of PLATFORM_ORDER) {
    const artifact = artifacts?.[platform];
    const expectedName = artifactName(platform, pin.version, pin.versionCode);
    if (!artifact || artifact.name !== expectedName || artifact.sourceSha?.toLowerCase() !== pin.commitSha ||
        !(artifact.bytes instanceof Uint8Array) || artifact.bytes.byteLength === 0 ||
        !artifact.name.endsWith(PLATFORM_EXTENSIONS[platform]) || names.has(artifact.name)) {
      throw new Error(`The ${platform} package does not match this release pin`);
    }
    names.add(artifact.name);
    const bytes = Buffer.from(artifact.bytes);
    packages.push({
      name: artifact.name,
      contentType: platform === 'windows'
        ? 'application/vnd.microsoft.portable-executable'
        : platform === 'macos' ? 'application/x-apple-diskimage' : 'application/vnd.android.package-archive',
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  const checksumText = `${packages.map(({ name, sha256 }) => `${sha256}  ${name}`).join('\n')}\n`;
  packages.push({
    name: 'SHA256SUMS',
    contentType: 'text/plain; charset=utf-8',
    bytes: Buffer.from(checksumText, 'utf8'),
    sha256: createHash('sha256').update(checksumText, 'utf8').digest('hex'),
  });
  return packages;
}

async function publicAssetsMatch(adapter, release, expectedAssets) {
  const actualAssets = release.assets || [];
  if (actualAssets.length !== expectedAssets.length) return false;
  const actualByName = new Map(actualAssets.map((asset) => [asset.name, asset]));
  if (actualByName.size !== expectedAssets.length) return false;
  for (const expected of expectedAssets) {
    const actual = actualByName.get(expected.name);
    if (!actual || actual.size !== expected.bytes.byteLength) return false;
    let digest = actual.digest;
    if (typeof digest === 'string' && digest.startsWith('sha256:')) digest = digest.slice('sha256:'.length);
    else digest = await adapter.getReleaseAssetDigest(actual);
    if (digest?.toLowerCase() !== expected.sha256) return false;
  }
  return true;
}

function releaseResult(pin, releaseAssets, alreadyPublished = false) {
  return {
    tag: pin.tag,
    commitSha: pin.commitSha,
    version: pin.version,
    alreadyPublished,
    assets: releaseAssets.map(({ name, sha256 }) => ({ name, sha256 })),
  };
}

export async function publishRelease(adapter, rawPin, checks, artifacts) {
  const pin = validatePin(rawPin);
  const releaseAssets = prepareReleaseAssets(pin, checks, artifacts);
  const mainSha = await adapter.getMainHead();
  if (!await adapter.isAncestor(pin.commitSha, mainSha)) {
    throw new Error('The pinned release commit is no longer in main history');
  }

  const existingRelease = await adapter.getReleaseByTag(pin.tag);
  const existingTag = await adapter.getTagTarget(pin.tag);
  if (existingTag && existingTag.toLowerCase() !== pin.commitSha) {
    throw new Error(`Tag ${pin.tag} already points to a different commit; refusing to move it`);
  }
  if (existingRelease && existingRelease.tag !== pin.tag) {
    throw new Error('The existing draft release does not match the pinned tag');
  }
  if (existingRelease && !existingRelease.draft) {
    if (existingRelease.prerelease || existingTag?.toLowerCase() !== pin.commitSha ||
        !await publicAssetsMatch(adapter, existingRelease, releaseAssets)) {
      throw new Error('The public release does not exactly match this pin; public assets are immutable');
    }
    return releaseResult(pin, releaseAssets, true);
  }
  if (existingRelease?.prerelease) {
    throw new Error('A prerelease cannot be reused as a stable release');
  }

  if (!existingTag) await adapter.createTag(pin.tag, pin.commitSha);
  const release = existingRelease ?? await adapter.createDraftRelease({
    tag: pin.tag,
    commitSha: pin.commitSha,
    title: `Open WebUI Client ${pin.version}`,
    body: `Release ${pin.version}\nSource commit: ${pin.commitSha}\nWorkflow run: ${pin.runId}\nAndroid versionCode: ${pin.versionCode}\n\nAndroid: immersive status bar, native connection menu, keyboard/inset and Back-navigation improvements are covered by GitHub automated checks. HyperOS physical-device UX acceptance has not been completed.`,
  });
  if (!release?.draft || release.prerelease || !release.id) {
    throw new Error('GitHub did not return a draft release');
  }
  await adapter.replaceDraftAssets(release.id, releaseAssets);
  await adapter.publishDraft(release.id);
  return releaseResult(pin, releaseAssets);
}

function createGitHubAdapter(env) {
  const repository = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  if (typeof repository !== 'string' || !/^[^/]+\/[^/]+$/.test(repository) || !token) {
    throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required for release automation');
  }
  const apiBase = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  const repositoryApi = `${apiBase}/repos/${repository}`;
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
  };

  async function request(route, { method = 'GET', body, headers: extraHeaders = {}, allowNotFound = false } = {}) {
    const response = await fetch(`${repositoryApi}${route}`, {
      method,
      headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}), ...extraHeaders },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (allowNotFound && response.status === 404) return null;
    const responseBody = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const message = responseBody?.message || `GitHub API request failed (${response.status})`;
      throw new Error(message);
    }
    return responseBody;
  }

  async function getMainHead() {
    const response = await request('/git/ref/heads/main');
    return response.object?.sha;
  }

  async function getTree(commitSha) {
    const commit = await request(`/git/commits/${commitSha}`);
    const tree = await request(`/git/trees/${commit.tree.sha}?recursive=1`);
    if (tree.truncated) throw new Error('GitHub returned a truncated tree while validating release workflows');
    return tree;
  }

  return {
    async getMainHead() {
      return getMainHead();
    },
    async isAncestor(ancestorSha, descendantSha) {
      if (ancestorSha.toLowerCase() === descendantSha.toLowerCase()) return true;
      const comparison = await request(`/compare/${ancestorSha}...${descendantSha}`);
      return comparison.status === 'ahead' && comparison.ahead_by > 0;
    },
    async verifyVersionSnapshot(commitSha, expectedVersion) {
      const contents = new Map();
      for (const relativePath of VERSION_FILES) {
        const apiPath = relativePath.split('/').map(encodeURIComponent).join('/');
        const file = await request(`/contents/${apiPath}?ref=${encodeURIComponent(commitSha)}`);
        if (file.encoding !== 'base64' || typeof file.content !== 'string') return false;
        contents.set(relativePath.split('/').join(path.sep), Buffer.from(file.content.replace(/\n/g, ''), 'base64').toString('utf8'));
      }
      return validateVersionContents(contents) === expectedVersion;
    },
    async findPreparationByRunId(runId) {
      let page = 1;
      let found;
      while (true) {
        const commits = await request(`/commits?sha=main&per_page=100&page=${page}`);
        if (!Array.isArray(commits) || commits.length === 0) break;
        for (const item of commits) {
          const message = item.commit?.message || '';
          const marker = message.split(/\r?\n/).find((line) => line.startsWith(RUN_MARKER_PREFIX));
          if (marker === `${RUN_MARKER_PREFIX}${runId}`) {
            const version = message.match(/^chore\(release\): v(\d+\.\d+\.\d+)$/m)?.[1];
            if (!version || found) throw new Error('Duplicate or malformed release run marker in main history');
            found = { runId, version, tag: `v${version}`, commitSha: item.sha };
          }
        }
        if (commits.length < 100) break;
        page += 1;
      }
      return found;
    },
    async commitReleaseBump({ expectedBaseSha, runId, version, marker, versionFiles }) {
      const tree = await getTree(expectedBaseSha);
      const entries = [];
      for (const [filePath, content] of Object.entries(versionFiles)) {
        const blob = await request('/git/blobs', {
          method: 'POST',
          body: { content: Buffer.from(content, 'utf8').toString('base64'), encoding: 'base64' },
        });
        const baseEntry = tree.tree.find((entry) => entry.path === filePath);
        entries.push({
          path: filePath,
          mode: baseEntry?.mode || '100644',
          type: 'blob',
          sha: blob.sha,
        });
      }
      const newTree = await request('/git/trees', {
        method: 'POST',
        body: { base_tree: tree.sha, tree: entries },
      });
      const commit = await request('/git/commits', {
        method: 'POST',
        body: {
          message: `chore(release): v${version}\n\n${marker}`,
          tree: newTree.sha,
          parents: [expectedBaseSha],
        },
      });
      try {
        await request('/git/refs/heads/main', {
          method: 'PATCH',
          body: { sha: commit.sha, force: false },
        });
      } catch {
        throw new Error(`main changed during release preparation for run ${runId}; no force update was attempted`);
      }
      return commit.sha;
    },
    async assertReleaseWorkflowUnchanged(pinnedSha, mainSha) {
      const [pinnedTree, mainTree] = await Promise.all([getTree(pinnedSha), getTree(mainSha)]);
      const workflowHashes = (tree) => new Map(tree.tree
        .filter((entry) => entry.type === 'blob' && entry.path.startsWith('.github/workflows/'))
        .map((entry) => [entry.path, entry.sha]));
      const pinned = workflowHashes(pinnedTree);
      const current = workflowHashes(mainTree);
      if (pinned.size !== current.size || [...pinned].some(([file, sha]) => current.get(file) !== sha)) {
        throw new Error('Release workflow files changed on main after the pinned build source; refusing to publish');
      }
    },
    async getTagTarget(tag) {
      const reference = await request(`/git/ref/tags/${encodeURIComponent(tag)}`, { allowNotFound: true });
      if (!reference) return null;
      if (reference.object?.type === 'commit') return reference.object.sha;
      if (reference.object?.type === 'tag') {
        const annotated = await request(`/git/tags/${reference.object.sha}`);
        return annotated.object?.sha;
      }
      return null;
    },
    async createTag(tag, commitSha) {
      try {
        await request('/git/refs', { method: 'POST', body: { ref: `refs/tags/${tag}`, sha: commitSha } });
      } catch {
        const actual = await this.getTagTarget(tag);
        if (actual?.toLowerCase() !== commitSha.toLowerCase()) throw new Error(`Could not create immutable tag ${tag}`);
      }
    },
    async createDraftRelease({ tag, commitSha, title, body }) {
      return request('/releases', {
        method: 'POST',
        body: {
          tag_name: tag,
          target_commitish: commitSha,
          name: title,
          body,
          draft: true,
          prerelease: false,
        },
      });
    },
    async getReleaseByTag(tag) {
      const release = await request(`/releases/tags/${encodeURIComponent(tag)}`, { allowNotFound: true });
      if (!release) return null;
      return {
        id: release.id,
        tag: release.tag_name,
        draft: release.draft,
        prerelease: release.prerelease,
        assets: (release.assets || []).map((asset) => ({
          id: asset.id,
          name: asset.name,
          size: asset.size,
          digest: asset.digest,
          browserDownloadUrl: asset.browser_download_url,
        })),
        uploadUrl: release.upload_url,
      };
    },
    async getPublicChecksums(asset) {
      const url = new URL(asset.browserDownloadUrl);
      if (url.protocol !== 'https:') throw new Error('Public checksum URL must use HTTPS');
      const response = await fetch(url);
      if (!response.ok) throw new Error('Could not verify published checksums');
      return response.text();
    },
    async getReleaseAssetDigest(asset) {
      if (/^sha256:[a-f0-9]{64}$/.test(asset.digest || '')) return asset.digest.slice(7);
      if (!asset.browserDownloadUrl) return null;
      const download = new URL(asset.browserDownloadUrl);
      if (download.protocol !== 'https:') throw new Error('Public release asset URL must use HTTPS');
      const response = await fetch(download, { headers: { accept: 'application/octet-stream' } });
      if (!response.ok || !response.body) throw new Error(`Could not verify public release asset ${asset.name}`);
      const digest = createHash('sha256');
      for await (const chunk of response.body) digest.update(chunk);
      return digest.digest('hex');
    },
    async replaceDraftAssets(releaseId, assets) {
      const release = await request(`/releases/${releaseId}`);
      if (!release.draft || release.prerelease) throw new Error('Only a draft release can have its assets replaced');
      for (const existing of release.assets || []) {
        await request(`/releases/assets/${existing.id}`, { method: 'DELETE' });
      }
      const uploadUrl = release.upload_url.replace(/\{\?.*$/, '');
      for (const asset of assets) {
        const url = new URL(uploadUrl);
        url.searchParams.set('name', asset.name);
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            ...headers,
            'content-type': asset.contentType,
            'content-length': String(asset.bytes.byteLength),
          },
          body: asset.bytes,
        });
        if (!response.ok) throw new Error(`Could not upload draft release asset ${asset.name} (${response.status})`);
      }
    },
    async publishDraft(releaseId) {
      const release = await request(`/releases/${releaseId}`);
      if (!release.draft || release.prerelease) throw new Error('Only a non-prerelease draft can be published');
      await request(`/releases/${releaseId}`, { method: 'PATCH', body: { draft: false, prerelease: false } });
    },
  };
}

function readPinFromEnv(env) {
  return {
    runId: env.RELEASE_RUN_ID,
    version: env.RELEASE_VERSION,
    commitSha: env.RELEASE_COMMIT_SHA,
    tag: env.RELEASE_TAG,
    versionCode: Number(env.RELEASE_VERSION_CODE),
  };
}

async function readArtifacts(directory, pin) {
  const names = {
    windows: artifactName('windows', pin.version, pin.versionCode),
    macos: artifactName('macos', pin.version, pin.versionCode),
    android: artifactName('android', pin.version, pin.versionCode),
  };
  const directoryEntries = await readdir(directory);
  const expectedNames = new Set(Object.values(names));
  const actualPackages = directoryEntries.filter((name) => name.endsWith('.exe') || name.endsWith('.dmg') || name.endsWith('.apk'));
  if (actualPackages.length !== 3 || actualPackages.some((name) => !expectedNames.has(name))) {
    throw new Error('The downloaded release directory must contain exactly the three pinned platform packages');
  }
  return Object.fromEntries(await Promise.all(PLATFORM_ORDER.map(async (platform) => [
    platform, await verifyManifest(directory, platform, pin),
  ])));
}

function writeGithubOutputs(output, values) {
  return appendFile(output, `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`);
}

export async function alreadyPublished(adapter, pin) {
  const release = await adapter.getReleaseByTag(pin.tag);
  if (!release || release.draft) return false;
  if (release.prerelease || await adapter.getTagTarget(pin.tag) !== pin.commitSha) throw new Error('Public release pin mismatch');
  const names = PLATFORM_ORDER.map((platform) => artifactName(platform, pin.version, pin.versionCode));
  const assets = release.assets || [];
  if (assets.length !== 4 || new Set(assets.map((a) => a.name)).size !== 4 ||
      !assets.some((a) => a.name === 'SHA256SUMS')) throw new Error('Public release manifest incomplete');
  const sums = await adapter.getPublicChecksums(assets.find((a) => a.name === 'SHA256SUMS'));
  const lines = sums.trim().split(/\r?\n/);
  if (lines.length !== 3) throw new Error('Public release checksum count mismatch');
  for (const name of names) {
    const asset = assets.find((item) => item.name === name);
    if (!asset || asset.size <= 0) throw new Error('Public release package missing');
    const digest = await adapter.getReleaseAssetDigest(asset);
    if (!/^[a-f0-9]{64}$/.test(digest || '') || !lines.includes(`${digest}  ${name}`)) {
      throw new Error('Public release checksum mismatch');
    }
  }
  return true;
}

export async function planRelease(adapter, { eventName, ref, runId, runNumber, workspaceSha, files = [] }) {
  if (!releaseEvent(eventName, ref)) return { release: false, reason: 'pull-request' };
  const existing = await adapter.findPreparationByRunId(String(runId));
  if (existing) {
    const pin = pinFromMarker(existing, String(runId), Number(runNumber));
    if (await alreadyPublished(adapter, pin)) return { release: false, reason: 'already-published' };
    return { release: true, reason: 'retry-existing-pin' };
  }
  if (eventName === 'push' && isDocumentationOnly(files)) return { release: false, reason: 'documentation-only' };
  const main = await adapter.getMainHead();
  if (main.toLowerCase() !== workspaceSha.toLowerCase()) return { release: false, reason: 'superseded' };
  return { release: true, reason: 'release' };
}

async function cliPlan(env) {
  const files = JSON.parse(await readFile(env.RELEASE_CHANGED_FILES, 'utf8'));
  const result = await planRelease(createGitHubAdapter(env), {
    eventName: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF, runId: env.GITHUB_RUN_ID,
    workspaceSha: env.GITHUB_SHA, runNumber: env.GITHUB_RUN_NUMBER, files,
  });
  if (env.GITHUB_OUTPUT) await writeGithubOutputs(env.GITHUB_OUTPUT, {
    release: String(result.release), reason: result.reason,
  });
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `Release selection: ${result.reason}\n`);
}

async function cliPrepare(env) {
  const pin = await prepareRelease(createGitHubAdapter(env), {
    eventName: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF,
    runId: env.GITHUB_RUN_ID,
    runNumber: env.GITHUB_RUN_NUMBER,
    workspaceSha: env.GITHUB_SHA,
    secrets: {
      ANDROID_KEYSTORE_PASSWORD: env.ANDROID_KEYSTORE_PASSWORD,
      ANDROID_KEYSTORE_BASE64: env.ANDROID_KEYSTORE_BASE64,
      ANDROID_RELEASE_SECRETS_VALIDATED: env.ANDROID_RELEASE_SECRETS_VALIDATED,
    },
  });
  if (env.GITHUB_OUTPUT) {
    await writeGithubOutputs(env.GITHUB_OUTPUT, {
      ready: pin.superseded ? 'false' : 'true',
      version: pin.version || '',
      commit_sha: pin.commitSha,
      tag: pin.tag,
      version_code: pin.versionCode,
      run_id: pin.runId,
    });
  }
  process.stdout.write(`${JSON.stringify(pin)}\n`);
}

async function cliPublish(env) {
  const pin = validatePin(readPinFromEnv(env));
  const artifactDirectory = env.RELEASE_ARTIFACT_DIR;
  if (!artifactDirectory) throw new Error('RELEASE_ARTIFACT_DIR is required');
  const artifacts = await readArtifacts(artifactDirectory, pin);
  const result = await publishRelease(createGitHubAdapter(env), pin, {
    sourceSha: env.RELEASE_SOURCE_SHA,
    windows: env.RELEASE_WINDOWS_RESULT,
    macos: env.RELEASE_MACOS_RESULT,
    android: env.RELEASE_ANDROID_RESULT,
  }, artifacts);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function main(args, env = process.env) {
  if (args.length === 1 && args[0] === 'plan') return cliPlan(env);
  if (args.length === 1 && args[0] === 'prepare') return cliPrepare(env);
  if (args.length === 1 && args[0] === 'publish') return cliPublish(env);
  throw new Error('Usage: node scripts/release-orchestrator.mjs prepare | publish');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
