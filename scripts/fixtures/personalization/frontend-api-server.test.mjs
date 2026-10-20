import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

test('fixture serves every page from the verified bundle and APIs separately', async () => {
	const directory = await mkdtemp(path.join(tmpdir(), 'owc-api-fixture-'));
	const port = 18000 + Math.floor(Math.random() * 1000);
	const commit = 'a'.repeat(40);
	const entry = Buffer.from('<!doctype html><div id="real-svelte"></div>');
	const manifest = {
		schema: 1,
		sourceRepository: 'Mike666wq/open-webui-frontend',
		sourceCommit: commit,
		upstreamVersion: '0.12.2',
		upstreamCommit: 'b'.repeat(40),
		entry: 'index.html',
		pageRoutes: ['^/$', '^/c/[^/]+/?$'],
		files: [
			{
				path: 'index.html',
				sha256: createHash('sha256').update(entry).digest('hex'),
				size: entry.length,
				mime: 'text/html'
			}
		]
	};
	await mkdir(directory, { recursive: true });
	await writeFile(path.join(directory, 'index.html'), entry);
	await writeFile(
		path.join(directory, 'frontend-manifest.json'),
		JSON.stringify(manifest, null, 2)
	);
	const child = spawn(
		process.execPath,
		[new URL('./frontend-api-server.mjs', import.meta.url).pathname, directory],
		{
			env: { ...process.env, FIXTURE_PORT: String(port) },
			stdio: ['ignore', 'pipe', 'pipe']
		}
	);
	let stderr = '';
	let stdout = '';
	child.stderr.setEncoding('utf8');
	child.stdout.setEncoding('utf8');
	child.stderr.on('data', (chunk) => { stderr += chunk; });
	child.stdout.on('data', (chunk) => { stdout += chunk; });
	try {
		const origin = `http://127.0.0.1:${port}`;
		let ready = false;
		for (let attempt = 0; attempt < 50; attempt += 1) {
			try {
				await fetch(`${origin}/api/config`);
				ready = true;
				break;
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		}
		assert.ok(ready, `fixture did not start\nstdout:\n${stdout}\nstderr:\n${stderr}`);
		assert.equal((await fetch(`${origin}/`)).status, 200);
		assert.equal((await fetch(`${origin}/c/fixture`)).status, 200);
		assert.match(await (await fetch(`${origin}/`)).text(), /real-svelte/);
		assert.equal((await fetch(`${origin}/api/v1/auths/`)).status, 200);
		assert.equal((await fetch(`${origin}/api/v1/users/user/settings`)).status, 200);
		const models = await (await fetch(`${origin}/api/models`)).json();
		assert.equal(models.data[0].id, 'fixture-model');
		assert.equal((await fetch(`${origin}/api/v1/models`)).status, 404);
		const usage = await (await fetch(`${origin}/api/usage`)).json();
		assert.equal(usage.totals.messages, 2);
		const chatsResponse = await fetch(`${origin}/api/v1/chats/`);
		assert.equal(chatsResponse.status, 200);
		const chats = await chatsResponse.json();
		assert.equal(chats[0].id, 'layout-fixture');
		assert.equal((await fetch(`${origin}/api/chats/`)).status, 404);
		const chat = await (await fetch(`${origin}/api/v1/chats/layout-fixture`)).json();
		assert.equal(chat.user_id, 'fixture-user');
		assert.equal(chat.chat.user_id, 'fixture-user');
		assert.equal(chat.chat.history.currentId, 'fixture-assistant');
		assert.equal(
			(
				await (
					await fetch(`${origin}/api/v1/auths/signin`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ email: 'fixture@example.invalid', password: 'fixture' })
					})
				).json()
			).token,
			'fixture-token'
		);
		const provenance = await (await fetch(`${origin}/__fixture_provenance`)).json();
		assert.equal(provenance.sourceCommit, commit);
		assert.equal(provenance.manifestSha256Digest.length, 64);
		assert.ok(
			provenance.events.some((entry) => entry.path === '/api/v1/auths/'),
			'fixture should record the real authentication request'
		);
	} finally {
		try {
			if (child.exitCode === null) child.kill('SIGTERM');
			await Promise.race([
				new Promise((resolve) => child.once('exit', resolve)),
				new Promise((resolve) => setTimeout(resolve, 2_000))
			]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
});
