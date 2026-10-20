import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRunnerFrontendLock } from './create-runner-frontend-lock.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const upstreamCommit = '6a18585ff4c2e5f6805f682222cfbc46dc669ef8';

async function fixture({
	sourceCommit = 'a'.repeat(40),
	sourceRepository = 'Mike666wq/open-webui-frontend',
	upstreamVersion = '0.12.2',
	bundleCommit = sourceCommit
} = {}) {
	const root = await mkdtemp(path.join(tmpdir(), 'runner-frontend-lock-'));
	const dist = path.join(root, 'dist');
	await mkdir(dist, { recursive: true });
	const manifest = {
		schema: 1,
		sourceRepository,
		sourceCommit: bundleCommit,
		upstreamVersion,
		upstreamCommit,
		entry: 'index.html',
		pageRoutes: ['^/$'],
		files: [
			{
				path: 'index.html',
				sha256: digest('real frontend'),
				size: Buffer.byteLength('real frontend'),
				mime: 'text/html'
			}
		]
	};
	const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
	const archive = Buffer.from('deterministic frontend archive');
	await writeFile(path.join(dist, 'frontend-manifest.json'), manifestBytes);
	await writeFile(path.join(dist, 'open-webui-frontend.zip'), archive);
	return {
		root,
		sourceCommit,
		manifestBytes,
		archive,
		cleanup: () => rm(root, { recursive: true, force: true })
	};
}

test('runner lock pins source, upstream provenance and deterministic bytes', async () => {
	const value = await fixture();
	try {
		const output = path.join(value.root, 'frontend.lock.json');
		const first = await createRunnerFrontendLock({
			frontendRoot: value.root,
			sourceCommit: value.sourceCommit,
			output
		});
		const second = await createRunnerFrontendLock({
			frontendRoot: value.root,
			sourceCommit: value.sourceCommit,
			output
		});
		assert.deepEqual(first, second);
		assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), first);
		assert.equal(first.sourceCommit, value.sourceCommit);
		assert.equal(first.upstreamVersion, '0.12.2');
		assert.equal(first.upstreamCommit, upstreamCommit);
		assert.equal(first.archiveSha256, digest(value.archive));
		assert.equal(first.manifestSha256, digest(value.manifestBytes));
		assert.match(
			first.archiveUrl,
			new RegExp(`/frontend-${value.sourceCommit.slice(0, 12)}/open-webui-frontend\\.zip$`)
		);
	} finally {
		await value.cleanup();
	}
});

test('runner lock rejects malformed or mismatched candidate provenance', async () => {
	for (const options of [
		{ sourceCommit: 'main' },
		{ bundleCommit: 'b'.repeat(40) },
		{ sourceRepository: 'someone/open-webui-frontend' },
		{ upstreamVersion: '0.12.3' }
	]) {
		const value = await fixture(options);
		try {
			await assert.rejects(
				createRunnerFrontendLock({
					frontendRoot: value.root,
					sourceCommit: value.sourceCommit,
					output: path.join(value.root, 'frontend.lock.json')
				}),
				/full lowercase Git SHA|provenance/
			);
		} finally {
			await value.cleanup();
		}
	}
});
