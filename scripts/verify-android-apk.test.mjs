import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAndroidApkMetadata, validateSigningFingerprint } from './verify-android-apk.mjs';

const badging = `package: name='local.openwebui.client' versionCode='1042' versionName='0.2.1'\nsdkVersion:'29'\ntargetSdkVersion:'36'`;
const entries = 'AndroidManifest.xml\nlib/arm64-v8a/libapp.so\n';

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
