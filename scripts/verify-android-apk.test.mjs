import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { androidIconPaths, runValidationCommand, validateAndroidApkIconPayloads, validateAndroidApkIcons, validateAndroidApkMetadata, validateSigningFingerprint } from './verify-android-apk.mjs';

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

test('built APK theme must reference Android 12 splash attributes by compiled ID', () => {
  const resources = `
    resource mipmap/ic_launcher:
    resource mipmap/ic_launcher_round:
    resource mipmap/ic_launcher_foreground:
    resource color/ic_launcher_background:
    resource 0x7f010001 com.example:style/AppTheme:
      0x0101062d android:attr/windowSplashScreenAnimatedIcon:
      0x0101062c android:attr/windowSplashScreenBackground:
  `;
  const manifestTree = `
    E: application
      A: android:theme(0x01010000)=@0x7f010001
  `;
  assert.equal(validateAndroidApkIcons(resources, manifestTree), true);
  assert.throws(() => validateAndroidApkIcons(
    resources.replace('mipmap/ic_launcher_round', 'mipmap/other'),
    manifestTree,
  ), /ic_launcher_round/);
  assert.throws(() => validateAndroidApkIcons(
    resources.replace('0x0101062d', '0x0101062e'),
    manifestTree,
  ), /splash-screen/);
  assert.throws(() => validateAndroidApkIcons(resources, ''), /startup theme/);
});
function iconFixture({ shortened = true } = {}) {
  const densities = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];
  const names = ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png'];
  const packaged = new Map();
  const generated = new Map();
  let resources = '';
  for (const [nameIndex, name] of names.entries()) {
    resources += `    resource 0x7f0d000${nameIndex} mipmap/${name.slice(0, -4)}\n`;
    for (const [densityIndex, density] of densities.entries()) {
      const archivePath = shortened ? `res/${nameIndex}${densityIndex}.png` : `res/mipmap-${density}-v4/${name}`;
      resources += `      (${density}-v4) (file) ${archivePath} type=PNG\n`;
      const data = Buffer.from([nameIndex, densityIndex, 90, 255, 40, 50, 60, 0]);
      const image = { width: 2, height: 1, data };
      generated.set(`${density}/${name}`, PNG.sync.write(image, { deflateLevel: 0 }));
      // The package is recompressed and loses invisible RGB values.
      packaged.set(archivePath, PNG.sync.write({ ...image, data: Buffer.from([
        nameIndex, densityIndex, 90, 255, 0, 0, 0, 0,
      ]) }, { deflateLevel: 9 }));
    }
  }
  return { resources, packaged, generated, entries: [...packaged.keys()].join('\n') };
}

function validateFixture(fixture) {
  return validateAndroidApkIconPayloads(
    fixture.resources, fixture.entries,
    (entry) => fixture.packaged.get(entry),
    (density, name) => fixture.generated.get(`${density}/${name}`),
  );
}

test('launcher pixels survive shortened resource paths, PNG recompression and invisible RGB changes', () => {
  for (const shortened of [true, false]) {
    const fixture = iconFixture({ shortened });
    assert.equal(androidIconPaths(fixture.resources).size, 15);
    assert.notDeepEqual(fixture.packaged.values().next().value, fixture.generated.values().next().value);
    assert.equal(validateFixture(fixture), true);
  }
});

test('APK resource table must map each icon density to exactly one existing archive entry', () => {
  let fixture = iconFixture();
  fixture.resources = fixture.resources.replace('mdpi-v4', 'anydpi-v26');
  assert.throws(() => validateFixture(fixture), /exactly one mdpi/);
  fixture = iconFixture();
  fixture.resources = fixture.resources.replace('(mdpi-v4)', '(mdpi-v4) (file) res/extra.png type=PNG\n      (mdpi-v5)');
  assert.throws(() => validateFixture(fixture), /multiple mdpi/);
  fixture = iconFixture();
  fixture.entries = fixture.entries.split('\n').slice(1).join('\n');
  assert.throws(() => validateFixture(fixture), /exactly one mdpi/);
  fixture = iconFixture();
  fixture.entries += '\nres/00.png';
  assert.throws(() => validateFixture(fixture), /exactly one mdpi/);
  fixture = iconFixture();
  fixture.resources = fixture.resources.replace('res/00.png', 'res/../other.png');
  assert.throws(() => validateFixture(fixture), /invalid mdpi/);
});

test('changed pixels, dimensions or malformed PNGs still reject the packaged official icon', () => {
  for (const changed of [
    PNG.sync.write({ width: 2, height: 1, data: Buffer.from([255, 0, 90, 255, 0, 0, 0, 0]) }),
    PNG.sync.write({ width: 1, height: 2, data: Buffer.from([0, 0, 90, 255, 0, 0, 0, 0]) }),
  ]) {
    const fixture = iconFixture();
    fixture.packaged.set('res/00.png', changed);
    assert.throws(() => validateFixture(fixture), /does not match the generated official icon/);
  }
  const fixture = iconFixture();
  fixture.packaged.set('res/00.png', Buffer.from('not a PNG'));
  assert.throws(() => validateFixture(fixture), /Could not decode packaged mdpi/);
});
