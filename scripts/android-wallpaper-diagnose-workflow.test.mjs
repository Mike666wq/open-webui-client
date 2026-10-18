import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('wallpaper diagnosis is isolated from both quick checks and APK releases', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/android-wallpaper-diagnose.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /name: Android wallpaper diagnosis/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /branches:\s*\n\s*- codex\/android-wallpaper-diagnose/);
  assert.match(workflow, /system-images;android-36;google_apis;x86_64/);
  assert.doesNotMatch(workflow, /branches:\s*\n\s*- main/);
  assert.doesNotMatch(workflow, /windows-|macos-|release-orchestrator\.mjs publish/);
  assert.match(workflow, /android-wallpaper-diagnose\.py/);
  assert.match(workflow, /android-wallpaper-evidence/);
});

test('wallpaper diagnosis contains a real import, visual assertion and persistence check', async () => {
  const script = await readFile(
    new URL('./android-wallpaper-diagnose.py', import.meta.url),
    'utf8',
  );
  assert.match(script, /ACTION_OPEN_DOCUMENT|Choose image/);
  assert.match(script, /ImageMagick RMSE|compare.*RMSE/s);
  assert.match(script, /def wait_for_web_page/);
  assert.match(script, /Connected WebView did not render/);
  assert.match(script, /\.pixels\.txt/);
  assert.match(script, /preview the file/);
  assert.match(script, /not is_preview_action/);
  assert.match(script, /Appearance image import failed/);
  assert.match(script, /local_image and apply is not None/);
  assert.match(script, /"appearance & reading" in text/);
  assert.match(script, /"choose image" in text/);
  assert.doesNotMatch(script, /"choose image" in labels/);
  assert.doesNotMatch(script, /find\(output, "Wallpaper fixture 8765"/);
  assert.match(script, /appearance-config\.json/);
  assert.match(script, /Persisted appearance config or decoded JPEG was not found/);
  assert.match(script, /failure-logcat\.txt/);
  assert.match(script, /def tap_after_scroll/);
  assert.match(script, /set_slider_to_start/);
  assert.match(script, /#app \{ min-height: 100dvh; background: #fff; \}/);
  assert.match(script, /#chat-container \{ background: #fff; \}/);
  assert.doesNotMatch(script, /background: transparent; \}/);
});
