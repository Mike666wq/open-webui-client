import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Android diagnosis uses the real app and pinned API-only frontend', async () => {
	const script = await readFile(new URL('./android-bundled-frontend-diagnose.py', import.meta.url), 'utf8');
	const workflow = await readFile(
		new URL('../.github/workflows/android-wallpaper-diagnose.yml', import.meta.url),
		'utf8'
	);
	assert.doesNotMatch(script, /am start -a android\.intent\.action\.VIEW/);
	assert.doesNotMatch(script, /fixture\.html|chat\.html/);
	assert.match(script, /\/__fixture_provenance/);
	assert.match(script, /provenanceCommit.*expected_frontend_sha|expected_frontend_sha.*provenanceCommit/s);
	assert.match(script, /aria-label.*User menu/s);
	assert.match(script, /\['Settings','设置'\]/);
	assert.match(script, /aria-controls="tab-appearance"/);
	assert.match(script, /\.owui-assistant-message \.owui-assistant-card/);
	assert.match(script, /\.settings-content-scroll/);
	assert.match(script, /#open-mist-appearance-editor/);
	assert.match(script, /Input\.synthesizeScrollGesture/);
	assert.match(script, /image\/png/);
	assert.match(script, /blob:/);
	assert.match(script, /wallpaper-cancel/);
	assert.match(script, /wallpaper-applied/);
	assert.match(script, /assert_horizontal_bounds|assistantBody/);
	assert.match(script, /font_scale/);
	assert.match(script, /user_rotation/);
	assert.match(script, /keyboard/);
	assert.match(script, /resume/);
	assert.match(script, /debug-only diagnostic/i);
	assert.match(workflow, /android-36;google_apis;x86_64/);
	assert.match(workflow, /--debug --apk --target x86_64/);
	assert.match(workflow, /create-runner-frontend-lock\.mjs/);
	assert.match(workflow, /frontend-api-server\.mjs/);
	assert.match(workflow, /FRONTEND_COMMIT/);
	assert.match(workflow, /websocket-client/);
	assert.match(workflow, /bundled-frontend/);
	assert.match(workflow, /frontend-manifest\.sha256/);
	assert.match(workflow, /artifact-ids:/);
	assert.match(workflow, /npm ci --prefix "\$frontend" --no-audit --no-fund/);
	assert.match(workflow, /NODE_OPTIONS: --max-old-space-size=6144/);
	assert.doesNotMatch(workflow, /python\s+scripts\/android-wallpaper-diagnose\.py/);
	assert.doesNotMatch(workflow, /windows-|macos-|release-orchestrator\.mjs publish/);
	assert.doesNotMatch(workflow, /60 seconds|3 cold launches|cold-start/i);
});

test('Android diagnosis cannot publish releases or use production signing', async () => {
	const workflow = await readFile(
		new URL('../.github/workflows/android-wallpaper-diagnose.yml', import.meta.url),
		'utf8'
	);
	assert.match(workflow, /permissions:\s*\n\s*contents: read/);
	assert.doesNotMatch(workflow, /contents: write|gh release|softprops\/action-gh-release/);
	assert.doesNotMatch(workflow, /ANDROID_KEYSTORE|keystore\/release|apksigner sign/);
	assert.match(workflow, /adb install -r wallpaper-diagnostic\.apk/);
});
