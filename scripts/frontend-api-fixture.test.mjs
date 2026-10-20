import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('frontend fixture exposes only data APIs and the verified bundle', async () => {
	const fixture = await readFile(
		new URL('./fixtures/personalization/frontend-api-server.mjs', import.meta.url),
		'utf8'
	);
	for (const route of [
		'/api/v1/auths/',
		'/api/v1/users/user/settings',
		'/api/models',
		'/api/usage',
		'/api/v1/chats/',
		'/api/v1/folders/',
		'/api/v1/notes/pinned',
		'/api/config',
		'/api/version'
	]) {
		assert.ok(fixture.includes(route), `Missing real frontend API fixture route: ${route}`);
	}
	assert.doesNotMatch(fixture, /android\.html|chat\.html|<html/i);
	assert.match(fixture, /frontend-manifest\.json/);
	assert.match(fixture, /X-OWC-Frontend-Commit/);
	assert.match(fixture, /__fixture_provenance/);
});
