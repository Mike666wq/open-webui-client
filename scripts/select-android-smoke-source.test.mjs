import test from 'node:test';
import assert from 'node:assert/strict';
import { selectAndroidSmokeSource, V0_2_2_SOURCE_SHA } from './select-android-smoke-source.mjs';

test('workflow dispatch defaults to the released v0.2.2 source', () => {
  assert.equal(selectAndroidSmokeSource({ eventName: 'workflow_dispatch' }), V0_2_2_SOURCE_SHA);
});

test('workflow dispatch can explicitly choose the current checkout', () => {
  assert.equal(selectAndroidSmokeSource({ eventName: 'workflow_dispatch', requestedSource: 'current' }), 'current');
});

test('workflow or harness-only pushes stay pinned to v0.2.2', () => {
  assert.equal(selectAndroidSmokeSource({ eventName: 'push', changedPaths: [
    '.github/workflows/android-emulator-diagnose.yml',
    'scripts/android-emulator-smoke.py',
    'scripts/select-android-smoke-source.mjs',
  ] }), V0_2_2_SOURCE_SHA);
});

test('Tauri source and Android resource changes select the current checkout', () => {
  assert.equal(selectAndroidSmokeSource({ eventName: 'push', changedPaths: [
    'src-tauri/icons/icon.png',
    'src-tauri/gen/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml',
  ] }), 'current');
});

test('runtime and Android build changes select the current checkout', () => {
  for (const changedPath of [
    'src/app.js',
    'src-tauri/src/lib.rs',
    'src-tauri/plugins/connection-controls/android/src/main/java/ConnectionControlsPlugin.kt',
    'src-tauri/capabilities/local-shell.json',
    'src-tauri/build.rs',
    'src-tauri/tauri.conf.json',
    'scripts/prepare-android.mjs',
    'scripts/download-bridge.js',
    'scripts/link-bridge.js',
    'package-lock.json',
  ]) {
    assert.equal(selectAndroidSmokeSource({ eventName: 'push', changedPaths: [changedPath] }), 'current', changedPath);
  }
});

test('unsupported events and source choices fail closed', () => {
  assert.throws(() => selectAndroidSmokeSource({ eventName: 'pull_request' }), /Unsupported Android smoke event/);
  assert.throws(() => selectAndroidSmokeSource({ eventName: 'workflow_dispatch', requestedSource: 'branch' }), /Unsupported Android smoke source/);
});
