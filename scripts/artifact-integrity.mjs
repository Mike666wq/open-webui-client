import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function stageManifest(directory, target, env = process.env) {
  const extension = { windows: '.exe', macos: '.dmg', android: '.apk', diagnostic: '.apk' }[target];
  if (!extension) throw new Error('Invalid artifact target');
  const files = (await readdir(directory)).filter((name) => name.endsWith(extension));
  if (files.length !== 1) throw new Error('Expected exactly one package for this target');
  const manifest = {
    target, sourceSha: env.RELEASE_COMMIT_SHA, version: env.RELEASE_VERSION,
    versionCode: Number(env.RELEASE_VERSION_CODE), runId: env.GITHUB_RUN_ID,
    attempt: Number(env.GITHUB_RUN_ATTEMPT),
    file: files[0], sha256: digest(await readFile(path.join(directory, files[0]))),
  };
  if (!/^[a-f0-9]{40}$/i.test(manifest.sourceSha || '') || !/^\d+\.\d+\.\d+$/.test(manifest.version || '') ||
      !Number.isSafeInteger(manifest.versionCode) || manifest.versionCode < 1001 ||
      !/^[1-9]\d*$/.test(manifest.runId || '') || !Number.isSafeInteger(manifest.attempt) || manifest.attempt < 1) {
    throw new Error('Incomplete artifact provenance');
  }
  await writeFile(path.join(directory, `${target}.manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function verifyManifest(directory, target, pin) {
  const manifest = JSON.parse(await readFile(path.join(directory, `${target}.manifest.json`), 'utf8'));
  if (manifest.target !== target || manifest.sourceSha !== pin.commitSha || manifest.version !== pin.version ||
      manifest.versionCode !== pin.versionCode || manifest.runId !== String(pin.runId) ||
      !Number.isSafeInteger(manifest.attempt) || manifest.attempt < 1 ||
      !manifest.file || path.basename(manifest.file) !== manifest.file || !/^[a-f0-9]{64}$/.test(manifest.sha256 || '')) {
    throw new Error(`The ${target} manifest does not match this release pin`);
  }
  const bytes = await readFile(path.join(directory, manifest.file));
  if (!bytes.length || digest(bytes) !== manifest.sha256) throw new Error(`The ${target} package digest does not match its manifest`);
  return { name: manifest.file, sourceSha: manifest.sourceSha, bytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'stage') await stageManifest(process.argv[4], process.argv[3]);
    else if (process.argv[2] === 'verify') await verifyManifest(process.argv[4], process.argv[3], {
      commitSha: process.env.RELEASE_COMMIT_SHA, version: process.env.RELEASE_VERSION,
      versionCode: Number(process.env.RELEASE_VERSION_CODE), runId: process.env.GITHUB_RUN_ID,
    });
    else throw new Error('Expected stage or verify, target and directory');
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
