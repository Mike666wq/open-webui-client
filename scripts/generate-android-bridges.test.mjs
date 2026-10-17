import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { generateAndroidBridges } from './generate-android-bridges.mjs';

test('Android-only injected bridges are downlevelled for stock API29 WebView', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'android-bridge-target-'));
  try {
    await mkdir(path.join(root, 'scripts'));
    for (const name of ['download-bridge.js', 'link-bridge.js']) {
      await writeFile(path.join(root, 'scripts', name), 'window.example = window.api?.value ?? null;');
    }
    await generateAndroidBridges(root);
    for (const name of ['download-bridge.js', 'link-bridge.js']) {
      const output = await readFile(path.join(root, 'src-tauri', 'android-scripts', name), 'utf8');
      assert.doesNotMatch(output, /\?\.|\?\?/);
      assert.match(output, /window\.example/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
