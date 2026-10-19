import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareBundledFrontend, sha256File, validateFrontendLock } from './prepare-bundled-frontend.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const repository = 'Mike666wq/open-webui-frontend';
const upstreamCommit = '6a18585ff4c2e5f6805f682222cfbc46dc669ef8';

async function fixture({ extra = null, sourceCommit = 'a'.repeat(40) } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'frontend-test-'));
  const content = { 'index.html': '<html>official UI</html>', '_app/immutable/chunk.js': 'export const version = "0.12.2";' };
  const manifest = {
    schema: 1, sourceRepository: repository, sourceCommit, upstreamCommit, upstreamVersion: '0.12.2',
    entry: 'index.html', pageRoutes: ['^/$', '^/auth/?$', '^/c/[^/]+/?$'],
    files: Object.entries(content).map(([filename, bytes]) => ({
      path: filename, size: Buffer.byteLength(bytes), sha256: hash(bytes),
      mime: filename.endsWith('.html') ? 'text/html' : 'text/javascript',
    })),
  };
  const data = { ...content, 'frontend-manifest.json': JSON.stringify(manifest) };
  if (extra) data[extra] = 'unlisted';
  const archive = path.join(root, 'frontend.zip');
  const zip = spawnSync('python3', ['-c', [
    'import json,sys,zipfile',
    'with zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED) as z:',
    ' for name,data in json.load(sys.stdin).items(): z.writestr(name,data)',
  ].join('\n'), archive], { input: JSON.stringify(data), encoding: 'utf8' });
  assert.equal(zip.status, 0, zip.stderr);
  const lock = {
    schema: 1, sourceRepository: repository, sourceCommit, upstreamVersion: '0.12.2', upstreamCommit,
    archiveUrl: `https://github.com/${repository}/releases/download/frontend-${sourceCommit.slice(0, 12)}/open-webui-frontend.zip`,
    archiveSha256: await sha256File(archive), manifestSha256: hash(data['frontend-manifest.json']),
  };
  await writeFile(path.join(root, 'frontend.lock.json'), JSON.stringify(lock));
  const destination = path.join(root, 'src-tauri/plugins/connection-controls/android/src/main/assets/bundled-frontend');
  return { root, archive, lock, destination, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('frontend identity pins both bytes and commit-specific release location', async () => {
  const f = await fixture();
  try {
    assert.equal(validateFrontendLock(f.lock), f.lock);
    for (const change of [
      { sourceRepository: 'other/frontend' }, { sourceCommit: 'main' }, { schema: 2 },
      { upstreamVersion: '0.12.3' }, { manifestSha256: 'bad' },
      { archiveUrl: f.lock.archiveUrl + '?alternate=latest' },
      { archiveUrl: 'https://example.com/frontend.zip' },
    ]) assert.throws(() => validateFrontendLock({ ...f.lock, ...change }));
  } finally { await f.cleanup(); }
});

test('install verifies every asset; a valid generated directory needs no download', async () => {
  const f = await fixture();
  try {
    const first = await prepareBundledFrontend({ projectRoot: f.root, archivePath: f.archive });
    assert.equal(first.files, 2);
    assert.equal(await readFile(path.join(f.destination, 'index.html'), 'utf8'), '<html>official UI</html>');
    // A nonexistent supplied archive proves a verified cache is self-contained.
    assert.deepEqual(await prepareBundledFrontend({ projectRoot: f.root, archivePath: '/nonexistent.zip' }), first);
    await writeFile(path.join(f.destination, '_app/immutable/chunk.js'), 'corrupted');
    await prepareBundledFrontend({ projectRoot: f.root, archivePath: f.archive });
    assert.match(await readFile(path.join(f.destination, '_app/immutable/chunk.js'), 'utf8'), /0\.12\.2/);
  } finally { await f.cleanup(); }
});

test('archive digest mismatch never replaces an existing frontend', async () => {
  const f = await fixture();
  try {
    await mkdir(f.destination, { recursive: true });
    await writeFile(path.join(f.destination, 'index.html'), 'previous frontend');
    await writeFile(f.archive, 'invalid zip bytes');
    await assert.rejects(prepareBundledFrontend({ projectRoot: f.root, archivePath: f.archive }), /archive SHA256/);
    assert.equal(await readFile(path.join(f.destination, 'index.html'), 'utf8'), 'previous frontend');
  } finally { await f.cleanup(); }
});

test('even a pinned archive cannot contain traversal or unlisted assets', async () => {
  for (const extra of ['../outside.txt', '/absolute.txt', 'unlisted.js']) {
    const f = await fixture({ extra });
    try {
      await assert.rejects(prepareBundledFrontend({ projectRoot: f.root, archivePath: f.archive }), /escapes|inventory/);
      await assert.rejects(readFile(path.join(f.destination, 'index.html')));
    } finally { await f.cleanup(); }
  }
});

test('APK verification checks the packaged frontend bytes against the pinned manifest', async () => {
  const f = await fixture();
  try {
    await prepareBundledFrontend({ projectRoot: f.root, archivePath: f.archive });
    const apk = path.join(f.root, 'test.apk');
    const makeApk = altered => spawnSync('python3', ['-c', [
      'import pathlib,sys,zipfile',
      'root=pathlib.Path(sys.argv[1])',
      'with zipfile.ZipFile(sys.argv[2],"w") as z:',
      ' for p in root.rglob("*"):',
      '  if p.is_file(): z.writestr("assets/bundled-frontend/"+p.relative_to(root).as_posix(), b"altered" if sys.argv[3]=="yes" and p.name=="index.html" else p.read_bytes())',
    ].join('\n'), f.destination, apk, altered ? 'yes' : 'no'], { encoding: 'utf8' });
    assert.equal(makeApk(false).status, 0);
    const verify = () => spawnSync('python3', ['scripts/bundled-frontend-archive.py', 'apk', apk, path.join(f.root, 'frontend.lock.json')], { encoding: 'utf8' });
    assert.equal(verify().status, 0);
    assert.equal(makeApk(true).status, 0);
    const invalid = verify();
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /SHA256 mismatch/);
  } finally { await f.cleanup(); }
});
