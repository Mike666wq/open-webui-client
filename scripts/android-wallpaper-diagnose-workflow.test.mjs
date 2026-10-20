import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('wallpaper diagnosis entrypoint is isolated to the Android candidate workflow', async () => {
	const workflow = await readFile(
		new URL('../.github/workflows/android-wallpaper-diagnose.yml', import.meta.url),
		'utf8'
	);
	assert.match(workflow, /name: Android layout and bundled frontend diagnosis/);
	assert.match(workflow, /workflow_dispatch:/);
	assert.match(workflow, /codex\/android-layout-fix/);
	assert.match(workflow, /system-images;android-36;google_apis;x86_64/);
	assert.doesNotMatch(workflow, /branches:\s*\n\s*- main/);
	assert.doesNotMatch(workflow, /windows-|macos-|release-orchestrator\.mjs publish/);
	assert.match(workflow, /scripts\/android-bundled-frontend-diagnose\.py/);
	assert.match(workflow, /android-wallpaper-evidence/);
	assert.match(workflow, /scripts\/fixtures\/personalization\/\*\*/);
	const buildStep = workflow.indexOf('Build x86_64 debug diagnostic APK');
	const nativeTests = workflow.indexOf('Run Android native policy and bundle unit tests');
	assert.ok(buildStep >= 0, 'diagnostic APK build step must exist');
	assert.ok(
		nativeTests > buildStep,
		'native tests must run after Tauri generates the Android plugin settings'
	);
});
