#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const repository = 'Mike666wq/open-webui-frontend';
const expectedUpstreamVersion = '0.12.2';
const expectedUpstreamCommit = '6a18585ff4c2e5f6805f682222cfbc46dc669ef8';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function argumentsFrom(argv) {
	const values = {};
	for (let index = 0; index < argv.length; index += 2) {
		const name = argv[index];
		const value = argv[index + 1];
		if (!name?.startsWith('--') || value === undefined) {
			throw new Error('Expected --name value arguments');
		}
		values[name.slice(2)] = value;
	}
	return values;
}

export async function createRunnerFrontendLock({
	frontendRoot,
	sourceCommit,
	output,
	archiveUrl = null
}) {
	if (!/^[0-9a-f]{40}$/.test(sourceCommit ?? '')) {
		throw new Error('sourceCommit must be a full lowercase Git SHA');
	}
	const manifestPath = path.join(frontendRoot, 'dist/frontend-manifest.json');
	const archivePath = path.join(frontendRoot, 'dist/open-webui-frontend.zip');
	const [manifestBytes, archive] = await Promise.all([
		readFile(manifestPath),
		readFile(archivePath)
	]);
	const manifest = JSON.parse(manifestBytes);
	if (
		manifest.schema !== 1 ||
		manifest.sourceRepository !== repository ||
		manifest.sourceCommit !== sourceCommit ||
		manifest.upstreamVersion !== expectedUpstreamVersion ||
		manifest.upstreamCommit !== expectedUpstreamCommit
	) {
		throw new Error('Frontend bundle provenance does not match the requested source');
	}
	const lock = {
		schema: 1,
		sourceRepository: repository,
		sourceCommit,
		upstreamVersion: manifest.upstreamVersion,
		upstreamCommit: manifest.upstreamCommit,
		archiveSha256: digest(archive),
		manifestSha256: digest(manifestBytes),
		archiveUrl:
			archiveUrl ??
			`https://github.com/${repository}/releases/download/frontend-${sourceCommit.slice(0, 12)}/open-webui-frontend.zip`
	};
	await writeFile(output, `${JSON.stringify(lock, null, 2)}\n`);
	return lock;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
	const args = argumentsFrom(process.argv.slice(2));
	if (!args['frontend-root'] || !args['source-commit'] || !args.output) {
		throw new Error(
			'Usage: create-runner-frontend-lock.mjs --frontend-root DIR --source-commit SHA --output FILE'
		);
	}
	const lock = await createRunnerFrontendLock({
		frontendRoot: path.resolve(args['frontend-root']),
		sourceCommit: args['source-commit'],
		output: path.resolve(args.output)
	});
	console.log(JSON.stringify(lock, null, 2));
}
