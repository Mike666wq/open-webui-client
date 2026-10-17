import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  adaptiveIconXml,
  ensureAndroidIconResources,
  setAndroidApplicationIcons,
  splashThemeXml,
} from './android-icons.mjs';

const manifest = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:icon="@mipmap/old_icon" android:label="@string/app_name"
        android:theme="@style/Theme.open_webui_client">
    </application>
</manifest>
`;

const themes = `<resources xmlns:tools="http://schemas.android.com/tools">
    <style name="Theme.open_webui_client" parent="Theme.Material3.DayNight.NoActionBar">
    </style>
</resources>
`;

const manifestWithoutIcons = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="@string/app_name">
    </application>
</manifest>
`;

test('the browser and native icon generator share the exact upstream Open WebUI master PNG', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const image = await readFile(path.join(root, 'public', 'app-icon.png'));
  assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(image.readUInt32BE(16), 512);
  assert.equal(image.readUInt32BE(20), 512);
  assert.equal(createHash('sha256').update(image).digest('hex'), '01b8f5cc95d4a2991bab0d854f71ace436160ec9416a8b31894b8dd68b8a7b9e');
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /rel="icon" type="image\/png" href="\/app-icon\.png"/);
  assert.match(html, /<img class="mark" src="\/app-icon\.png"/);
});

test('Android launcher declarations use official launcher and round resources', () => {
  const result = setAndroidApplicationIcons(manifest);
  assert.match(result, /android:icon="@mipmap\/ic_launcher"/);
  assert.match(result, /android:roundIcon="@mipmap\/ic_launcher_round"/);
  assert.match(result, /android:label="@string\/app_name"/);
  assert.equal((result.match(/android:icon=/g) ?? []).length, 1);
  assert.equal((result.match(/android:roundIcon=/g) ?? []).length, 1);
  assert.equal(setAndroidApplicationIcons(result), result);
  const resultWithoutIcons = setAndroidApplicationIcons(manifestWithoutIcons);
  assert.match(resultWithoutIcons, /android:icon="@mipmap\/ic_launcher"/);
  assert.match(resultWithoutIcons, /android:roundIcon="@mipmap\/ic_launcher_round"/);
});

test('adaptive and Android 12 splash resources use generated official icon layers', () => {
  const adaptive = adaptiveIconXml();
  assert.match(adaptive, /@color\/ic_launcher_background/);
  assert.match(adaptive, /@mipmap\/ic_launcher_foreground/);
  const splash = splashThemeXml(themes);
  assert.match(splash, /name="Theme\.open_webui_client" parent="Theme\.Material3\.DayNight\.NoActionBar"/);
  assert.match(splash, /android:windowSplashScreenAnimatedIcon">@mipmap\/ic_launcher/);
  assert.match(splash, /android:windowSplashScreenBackground">@color\/ic_launcher_background/);
});

test('Android icon preparation writes adaptive, round and splash references for a Tauri-generated project', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'owc-android-icons-'));
  try {
    const main = path.join(root, 'src-tauri', 'gen', 'android', 'app', 'src', 'main');
    const res = path.join(main, 'res');
    await mkdir(path.join(res, 'values'), { recursive: true });
    await writeFile(path.join(main, 'AndroidManifest.xml'), manifest);
    await writeFile(path.join(res, 'values', 'themes.xml'), themes);
    for (const density of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
      const directory = path.join(res, `mipmap-${density}`);
      await mkdir(directory, { recursive: true });
      for (const name of ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png']) {
        await writeFile(path.join(directory, name), 'generated-by-tauri-icon');
      }
    }

    assert.equal(await ensureAndroidIconResources(root), true);
    const updatedManifest = await readFile(path.join(main, 'AndroidManifest.xml'), 'utf8');
    assert.match(updatedManifest, /android:icon="@mipmap\/ic_launcher"/);
    assert.match(updatedManifest, /android:roundIcon="@mipmap\/ic_launcher_round"/);
    for (const name of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
      const actual = await readFile(path.join(res, 'mipmap-anydpi-v26', name), 'utf8');
      assert.equal(actual, adaptiveIconXml());
    }
    assert.match(await readFile(path.join(res, 'values', 'ic_launcher_background.xml'), 'utf8'), /#FFFFFF/);
    assert.equal(await readFile(path.join(res, 'values-v31', 'themes.xml'), 'utf8'), splashThemeXml(themes));
    assert.equal(await ensureAndroidIconResources(root), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Android preparation fails closed when Tauri did not generate an icon layer', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'owc-android-icons-missing-'));
  try {
    const main = path.join(root, 'src-tauri', 'gen', 'android', 'app', 'src', 'main');
    await mkdir(path.join(main, 'res'), { recursive: true });
    await writeFile(path.join(main, 'AndroidManifest.xml'), manifest);
    await assert.rejects(ensureAndroidIconResources(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
