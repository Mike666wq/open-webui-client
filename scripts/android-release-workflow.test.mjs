import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('automatic APK release excludes emulator and desktop jobs while retaining package gates', async () => {
  const workflow = await readFile(new URL('../.github/workflows/android.yml', import.meta.url), 'utf8');
  assert.match(workflow, /on:\n  push:\n    branches:\n      - main/);
  assert.doesNotMatch(workflow, /workflow_dispatch:|release-emulator-smoke|android-emulator-diagnose|windows-|macos-/);
  assert.match(workflow, /needs: \[prepare-release, release-quality, android\]/);
  assert.match(workflow, /needs\.release-quality\.result == 'success'.*needs\.android\.result == 'success'/);
  for (const gate of ['testDebugUnitTest', 'verify-android-apk.mjs', 'artifact-integrity.mjs stage android', 'scripts/release-orchestrator.mjs publish']) {
    assert.ok(workflow.includes(gate), `Missing release gate: ${gate}`);
  }
});

test('Android resource packaging retains SvelteKit underscore directories', async () => {
  const build = await readFile(
    new URL('../src-tauri/plugins/connection-controls/android/build.gradle.kts', import.meta.url),
    'utf8',
  );
  const ignoreAssets = build.match(/androidResources\s*\{[\s\S]*?ignoreAssetsPatterns\s*\+=\s*"([^"]*)"/)?.[1];
  assert.ok(ignoreAssets, 'The plugin must configure Android resource ignore patterns');
  assert.doesNotMatch(ignoreAssets, /<dir>_\*/);
});
