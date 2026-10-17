import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveAndroidSmokeSource, selectAndroidSmokeSource, V0_2_2_SOURCE_SHA } from './select-android-smoke-source.mjs';

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
    'public/app-icon.png',
    'src-tauri/src/lib.rs',
    'src-tauri/plugins/connection-controls/android/src/main/java/ConnectionControlsPlugin.kt',
    'src-tauri/capabilities/local-shell.json',
    'src-tauri/build.rs',
    'src-tauri/tauri.conf.json',
    'scripts/prepare-android.mjs',
    'scripts/prepare-assets.mjs',
    'scripts/android-icons.mjs',
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


test('reusable candidate and release inputs override inherited caller events', () => {
  const pinnedSourceSha = 'b0aceb0068342fde1ed04ded1424cce487805b2c';
  for (const eventName of ['workflow_dispatch', 'push', 'workflow_call']) {
    for (const sourceLabel of ['candidate', 'release-pinned']) {
      assert.deepEqual(resolveAndroidSmokeSource({ eventName, pinnedSourceSha, sourceLabel }), {
        sourceSha: pinnedSourceSha, sourceKind: sourceLabel,
      });
    }
  }
});

test('pinned source inputs fail closed instead of silently falling back to a baseline', () => {
  for (const pinnedSourceSha of ['', 'main', 'a'.repeat(39), 'g'.repeat(40)]) {
    assert.throws(() => resolveAndroidSmokeSource({
      eventName: 'workflow_dispatch', pinnedSourceSha, sourceLabel: 'candidate',
    }), /immutable commit SHA/);
  }
  for (const sourceLabel of ['', 'bad label', 'x'.repeat(41)]) {
    assert.throws(() => resolveAndroidSmokeSource({
      eventName: 'push', pinnedSourceSha: 'a'.repeat(40), sourceLabel,
    }), /source label/);
  }
  assert.throws(() => resolveAndroidSmokeSource({ eventName: 'workflow_call' }), /immutable commit SHA/);
});

test('standalone diagnosis preserves baseline defaults and resolves current source explicitly', () => {
  assert.deepEqual(resolveAndroidSmokeSource({ eventName: 'workflow_dispatch' }), {
    sourceSha: V0_2_2_SOURCE_SHA, sourceKind: 'v0.2.2-baseline',
  });
  assert.deepEqual(resolveAndroidSmokeSource({
    eventName: 'workflow_dispatch', requestedSource: 'current', currentSha: 'a'.repeat(40),
  }), { sourceSha: 'a'.repeat(40), sourceKind: 'current' });
  assert.throws(() => resolveAndroidSmokeSource({
    eventName: 'workflow_dispatch', requestedSource: 'current', currentSha: 'main',
  }), /40-character commit SHA/);
});


test('the actual chooser workflow script uses a pinned SHA with an inherited dispatch event', () => {
  const workflow = readFileSync(new URL('../.github/workflows/android-emulator-diagnose.yml', import.meta.url), 'utf8');
  const sourceStep = workflow.slice(workflow.indexOf('      - name: Select pinned baseline or current app source'));
  const script = sourceStep.match(/        run: \|\n([\s\S]*?)(?=\n  build-x86_64-test-apk:)/)?.[1]
    .split('\n').map((line) => line.replace(/^          /, '')).join('\n');
  assert.ok(script, 'source chooser must expose a shell script');
  const temp = mkdtempSync(path.join(os.tmpdir(), 'android-source-workflow-'));
  const output = path.join(temp, 'output');
  const pinnedSha = 'b0aceb0068342fde1ed04ded1424cce487805b2c';
  try {
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: {
      ...process.env,
      GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_OUTPUT: output,
      ANDROID_SMOKE_REQUESTED_SOURCE: 'baseline',
      ANDROID_SMOKE_PINNED_SOURCE_SHA: pinnedSha, ANDROID_SMOKE_SOURCE_LABEL: 'candidate',
      ANDROID_SMOKE_BEFORE: '', ANDROID_SMOKE_SHA: 'a'.repeat(40),
    } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(output, 'utf8'), `source_sha=${pinnedSha}\nsource_kind=candidate\n`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
