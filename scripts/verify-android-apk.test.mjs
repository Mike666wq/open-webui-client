import test from 'node:test';
import assert from 'node:assert/strict';
import { runValidationCommand, validateAndroidApkIconPayloads, validateAndroidApkIcons, validateAndroidApkMetadata, validateSigningFingerprint } from './verify-android-apk.mjs';

const badging = `package: name='local.openwebui.client' versionCode='1042' versionName='0.2.1'\nsdkVersion:'29'\ntargetSdkVersion:'36'`;
const entries = 'AndroidManifest.xml\nlib/arm64-v8a/libapp.so\n';

test('AAPT-sized command output is not truncated at Node’s default subprocess buffer', () => {
  const output = runValidationCommand(process.execPath, [
    '-e',
    'process.stdout.write("x".repeat(2 * 1024 * 1024))',
  ]);
  assert.equal(output.length, 2 * 1024 * 1024);
});

test('signed release APK metadata must match package, minSdk, ARM64 ABI and pinned code', () => {
  assert.deepEqual(validateAndroidApkMetadata({ badging, entries, versionCode: 1042 }), {
    applicationId: 'local.openwebui.client',
    minSdk: 29,
    versionCode: 1042,
  });
  assert.throws(() => validateAndroidApkMetadata({ badging, entries, versionCode: 1043 }), /does not match/);
  assert.throws(() => validateAndroidApkMetadata({ badging: badging.replace('local.openwebui.client', 'other.app'), entries, versionCode: 1042 }), /application ID/);
  assert.throws(() => validateAndroidApkMetadata({ badging: badging.replace("sdkVersion:'29'", "sdkVersion:'30'"), entries, versionCode: 1042 }), /minimum SDK/);
  assert.throws(() => validateAndroidApkMetadata({ badging, entries: 'AndroidManifest.xml', versionCode: 1042 }), /ARM64/);
  assert.throws(() => validateAndroidApkMetadata({ badging, entries, versionCode: 2_100_000_001 }), /valid release/);
});

test('APK signer certificate must match the configured fixed keystore', () => {
  const fingerprint = 'AB:'.concat(Array.from({ length: 31 }, () => 'CD').join(':'));
  const keytool = `Alias name: openwebui-client\nEntry type: PrivateKeyEntry\nSHA256: ${fingerprint}`;
  const signerDigest = fingerprint.replaceAll(':', '').toLowerCase();
  const signer = `Signer #1 certificate SHA-256 digest: ${signerDigest}`;
  assert.equal(validateSigningFingerprint(keytool, signer), true);
  assert.throws(() => validateSigningFingerprint(keytool, `Signer #1 certificate SHA-256 digest: ${'00'.repeat(32)}`), /does not match/);
  assert.throws(() => validateSigningFingerprint(keytool, `${signer}\nSigner #2 certificate SHA-256 digest: ${signerDigest}`), /does not match/);
});

test('built APK must contain launcher, round, adaptive foreground and splash icon resources', () => {
  const resources = `
    resource mipmap/ic_launcher:
    resource mipmap/ic_launcher_round:
    resource mipmap/ic_launcher_foreground:
    resource color/ic_launcher_background:
    android:windowSplashScreenAnimatedIcon
    android:windowSplashScreenBackground
  `;
  assert.equal(validateAndroidApkIcons(resources), true);
  assert.throws(() => validateAndroidApkIcons(resources.replace('mipmap/ic_launcher_round', 'mipmap/other')), /ic_launcher_round/);
  assert.throws(() => validateAndroidApkIcons(resources.replace('windowSplashScreenAnimatedIcon', 'other')), /splash-screen/);
});

test('packaged launcher PNG payloads must match every generated official density icon', () => {
  const densities = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];
  const names = ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png'];
  const entries = densities.flatMap((density) => names.map((name) => `res/mipmap-${density}-v4/${name}`)).join('\n');
  const packaged = new Map(entries.split('\n').map((entry) => [entry, Buffer.from(`official:${entry}`)]));
  const generated = new Map(densities.flatMap((density) => names.map((name) => [
    `${density}/${name}`,
    packaged.get(`res/mipmap-${density}-v4/${name}`),
  ])));
  assert.equal(validateAndroidApkIconPayloads(
    entries,
    (entry) => packaged.get(entry),
    (density, name) => generated.get(`${density}/${name}`),
  ), true);
  const altered = new Map(packaged);
  altered.set('res/mipmap-xhdpi-v4/ic_launcher_round.png', Buffer.from('different pixels'));
  assert.throws(() => validateAndroidApkIconPayloads(
    entries,
    (entry) => altered.get(entry),
    (density, name) => generated.get(`${density}/${name}`),
  ), /does not match the generated official icon/);
});
