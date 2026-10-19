import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const repository = 'Mike666wq/open-webui-frontend';
const sourceCommit = /^[0-9a-f]{40}$/;
const digest = /^[0-9a-f]{64}$/;
const maximumArchiveBytes = 1024 * 1024 * 1024;

export function validateFrontendLock(value) {
  if (value?.schema !== 1 || value.sourceRepository !== repository ||
      !sourceCommit.test(value.sourceCommit ?? '') ||
      value.upstreamVersion !== '0.12.2' ||
      value.upstreamCommit !== '6a18585ff4c2e5f6805f682222cfbc46dc669ef8' ||
      !digest.test(value.archiveSha256 ?? '') || !digest.test(value.manifestSha256 ?? '')) {
    throw new Error('Invalid pinned official frontend identity or digest');
  }
  const expected = `https://github.com/${repository}/releases/download/frontend-${value.sourceCommit.slice(0, 12)}/open-webui-frontend.zip`;
  if (value.archiveUrl !== expected) throw new Error('Frontend archive must be the pinned repository release asset');
  return value;
}

export async function sha256File(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

function inspectArchive(args) {
  const result = spawnSync('python3', [path.join(root, 'scripts/bundled-frontend-archive.py'), ...args], {
    encoding: 'utf8', maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error((result.stderr || result.error?.message || 'Frontend archive verification failed').trim());
  }
  return JSON.parse(result.stdout);
}

export async function prepareBundledFrontend({ projectRoot = root, archivePath = null } = {}) {
  const lockPath = path.join(projectRoot, 'frontend.lock.json');
  const lock = validateFrontendLock(JSON.parse(await readFile(lockPath, 'utf8')));
  const parent = path.join(projectRoot, 'src-tauri/plugins/connection-controls/android/src/main/assets');
  const destination = path.join(parent, 'bundled-frontend');
  try {
    const verified = inspectArchive(['verify', destination, lockPath]);
    console.log(`Using verified bundled frontend ${verified.sourceCommit} (${verified.files} files)`);
    return verified;
  } catch {
    // A partial or stale generated directory is never accepted as a build input.
  }
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(path.join(tmpdir(), 'owc-frontend-'));
  const staged = await mkdtemp(path.join(parent, '.bundled-frontend-'));
  try {
    const archive = archivePath ?? path.join(temporary, 'frontend.zip');
    if (!archivePath) {
      const response = await fetch(lock.archiveUrl, { signal: AbortSignal.timeout(300_000) });
      if (!response.ok || !response.body) throw new Error(`Frontend asset download failed (${response.status})`);
      let length = 0;
      const limit = new Transform({
        transform(chunk, _encoding, callback) {
          length += chunk.length;
          callback(length > maximumArchiveBytes ? new Error('Frontend archive exceeds 1 GiB') : null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(archive, { flags: 'wx' }));
    }
    if (await sha256File(archive) !== lock.archiveSha256) throw new Error('Frontend archive SHA256 does not match frontend.lock.json');
    const verified = inspectArchive(['extract', archive, staged, lockPath]);
    await rm(destination, { recursive: true, force: true });
    await rename(staged, destination);
    console.log(`Prepared official frontend ${verified.sourceCommit} (${verified.files} verified files)`);
    return verified;
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await rm(staged, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const android = process.env.TAURI_ENV_PLATFORM === 'android' ||
    process.env.TAURI_ENV_TARGET_TRIPLE?.includes('android');
  if (!process.argv.includes('--if-android') || android) await prepareBundledFrontend();
}
