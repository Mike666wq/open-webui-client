import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { stageManifest, verifyManifest } from './artifact-integrity.mjs';

const env = { RELEASE_COMMIT_SHA: 'a'.repeat(40), RELEASE_VERSION: '1.2.3', RELEASE_VERSION_CODE: '1100', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' };
const pin = { commitSha: env.RELEASE_COMMIT_SHA, version: '1.2.3', versionCode: 1100, runId: '123' };
test('package provenance permits same-run prior-attempt reuse and rejects modified/missing/wrong-source packages', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'artifact-integrity-'));
  try {
    await writeFile(path.join(dir, 'app.apk'), 'package');
    const manifest = await stageManifest(dir, 'android', env);
    assert.equal(manifest.attempt, 2);
    assert.equal((await verifyManifest(dir, 'android', pin)).bytes.toString(), 'package');
    await assert.rejects(verifyManifest(dir, 'android', { ...pin, commitSha: 'b'.repeat(40) }), /manifest/);
    await assert.rejects(verifyManifest(dir, 'android', { ...pin, runId: '999' }), /manifest/);
    await writeFile(path.join(dir, 'app.apk'), 'tampered');
    await assert.rejects(verifyManifest(dir, 'android', pin), /digest/);
    await rm(path.join(dir, 'app.apk'));
    await assert.rejects(verifyManifest(dir, 'android', pin), /ENOENT/);
    const value = JSON.parse(await readFile(path.join(dir, 'android.manifest.json'), 'utf8'));
    await writeFile(path.join(dir, 'android.manifest.json'), JSON.stringify({ ...value, file: '../escape.apk' }));
    await assert.rejects(verifyManifest(dir, 'android', pin), /manifest/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
