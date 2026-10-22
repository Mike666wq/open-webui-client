import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('automatic APK release excludes emulator and desktop jobs while retaining package gates', async () => {
  const workflow = await readFile(new URL('../.github/workflows/android.yml', import.meta.url), 'utf8');
  assert.match(workflow, /on:\n  workflow_dispatch:/);
  assert.doesNotMatch(workflow, /release-emulator-smoke|android-emulator-diagnose|windows-|macos-/);
  assert.match(workflow, /needs: \[prepare-release, release-quality, android\]/);
  assert.match(workflow, /needs\.release-quality\.result == 'success'.*needs\.android\.result == 'success'/);
  for (const gate of ['testDebugUnitTest', 'verify-android-apk.mjs', 'artifact-integrity.mjs stage android', 'scripts/release-orchestrator.mjs publish']) {
    assert.ok(workflow.includes(gate), `Missing release gate: ${gate}`);
  }
});

test('Android resource packaging retains SvelteKit underscore directories', async () => {
  const build = (await readFile(
    new URL('../src-tauri/plugins/connection-controls/android/build.gradle.kts', import.meta.url),
    'utf8',
  )).replaceAll('\r\n', '\n');
  const block = build.match(/androidResources\s*\{\n([\s\S]*?)\n\s*\}\n\n\s*defaultConfig/)?.[1];
  assert.ok(block, 'The plugin must configure Android resource ignore patterns');
  assert.match(block, /ignoreAssetsPatterns\.clear\(\)/);
  const ignoreAssets = block.match(/ignoreAssetsPatterns\.add\("([^"]*)"\)/)?.[1];
  assert.ok(ignoreAssets, 'The plugin must configure Android resource ignore patterns');
  assert.doesNotMatch(block, /ignoreAssetsPatterns\s*\+=/);
  assert.doesNotMatch(ignoreAssets, /<dir>_\*/);
  for (const media of ['jpg', 'jpeg', 'png', 'gif', 'wav', 'mp3', 'ogg', 'mp4', '3gp', '3gpp']) {
    assert.ok(!ignoreAssets.includes(`!*.${media}`), `The plugin must package .${media} web assets`);
  }
});
