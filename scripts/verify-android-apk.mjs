import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_APPLICATION_ID = 'local.openwebui.client';
const EXPECTED_MIN_SDK = 29;
const MAX_VALIDATOR_OUTPUT_BYTES = 32 * 1024 * 1024;

export function validateAndroidApkMetadata({ badging, entries, versionCode }) {
  if (!Number.isSafeInteger(versionCode) || versionCode < 1001 || versionCode > 2_100_000_000) {
    throw new Error('Expected a valid release Android versionCode');
  }
  const packageLine = badging.split(/\r?\n/).find((line) => line.startsWith('package:'));
  if (!packageLine) throw new Error('APK has no Android package metadata');
  const appId = packageLine.match(/(?:^|\s)name='([^']+)'/)?.[1];
  const actualVersionCode = packageLine.match(/(?:^|\s)versionCode='(\d+)'/)?.[1];
  if (appId !== EXPECTED_APPLICATION_ID) throw new Error(`Unexpected Android application ID: ${appId ?? 'missing'}`);
  if (actualVersionCode !== String(versionCode)) throw new Error(`APK versionCode does not match the pinned release value ${versionCode}`);
  if (!badging.split(/\r?\n/).includes(`sdkVersion:'${EXPECTED_MIN_SDK}'`)) {
    throw new Error(`APK minimum SDK must be ${EXPECTED_MIN_SDK}`);
  }
  if (!entries.split(/\r?\n/).some((entry) => /^lib\/arm64-v8a\/[^/]+\.so$/.test(entry))) {
    throw new Error('APK does not contain an ARM64 native library');
  }
  return { applicationId: appId, minSdk: EXPECTED_MIN_SDK, versionCode };
}

export function validateSigningFingerprint(keystoreOutput, apkOutput) {
  const expected = keystoreOutput.match(/^\s*SHA256:\s*([0-9A-F:]+)\s*$/im)?.[1]?.replaceAll(':', '').toLowerCase();
  const signerDigests = [...apkOutput.matchAll(/^Signer #\d+ certificate SHA-256 digest:\s*([0-9A-F]+)\s*$/gim)]
    .map((match) => match[1].toLowerCase());
  if (!expected || expected.length !== 64 || signerDigests.length !== 1 ||
      signerDigests[0].length !== 64 || signerDigests[0] !== expected) {
    throw new Error('APK signing certificate does not match the configured Android keystore');
  }
  return true;
}

export function validateAndroidApkIcons(resourceDump) {
  for (const resource of [
    'mipmap/ic_launcher',
    'mipmap/ic_launcher_round',
    'mipmap/ic_launcher_foreground',
    'color/ic_launcher_background',
  ]) {
    if (!resourceDump.includes(resource)) {
      throw new Error(`APK is missing the official launcher icon resource ${resource}`);
    }
  }
  if (!resourceDump.includes('windowSplashScreenAnimatedIcon') ||
      !resourceDump.includes('windowSplashScreenBackground')) {
    throw new Error('APK is missing Android 12 splash-screen icon resources');
  }
  return true;
}

export function validateAndroidApkIconPayloads(entries, readArchiveEntry, readGeneratedIcon) {
  const densities = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];
  const names = ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png'];
  for (const density of densities) {
    for (const name of names) {
      const suffix = new RegExp('^res/mipmap-' + density + '(?:-v\\d+)?/' + name.replaceAll('.', '\\.') + '$');
      const matches = entries.split(/\r?\n/).filter((entry) => suffix.test(entry));
      if (matches.length !== 1) {
        throw new Error(`APK must contain exactly one ${density} ${name} resource`);
      }
      const generated = readGeneratedIcon(density, name);
      const packaged = readArchiveEntry(matches[0]);
      const expectedHash = createHash('sha256').update(generated).digest('hex');
      const actualHash = createHash('sha256').update(packaged).digest('hex');
      if (actualHash !== expectedHash) {
        throw new Error(`Packaged ${density} ${name} does not match the generated official icon`);
      }
    }
  }
  return true;
}

export function runValidationCommand(program, args, env = process.env) {
  const result = spawnSync(program, args, {
    encoding: 'utf8',
    env,
    maxBuffer: MAX_VALIDATOR_OUTPUT_BYTES,
  });
  if (result.error || result.status !== 0) {
    const detail = path.basename(program) === 'aapt'
      ? `: ${(result.stderr ?? '').trim().split(/\r?\n/)[0].slice(0, 240)}`
      : '';
    const status = result.error?.code ?? `exit ${result.status}`;
    throw new Error(`${path.basename(program)} validation failed (${status})${detail}`);
  }
  return result.stdout;
}

const run = runValidationCommand;

function runBytes(program, args, env = process.env) {
  const result = spawnSync(program, args, { env });
  if (result.error || result.status !== 0) {
    throw new Error(`${path.basename(program)} validation failed`);
  }
  return result.stdout;
}

export function verifyAndroidApk(apkPath, versionCode, {
  androidHome = process.env.ANDROID_HOME,
  keystorePath = process.env.ANDROID_KEYSTORE_PATH,
  keystorePassword = process.env.ANDROID_KEYSTORE_PASSWORD,
} = {}) {
  if (!androidHome) throw new Error('ANDROID_HOME is required to verify the APK');
  if (!keystorePath || !keystorePassword) throw new Error('Android keystore values are required to verify the APK identity');
  const absoluteApk = path.resolve(apkPath);
  const buildTools = path.join(androidHome, 'build-tools', '36.0.0');
  const signature = run(path.join(buildTools, 'apksigner'), ['verify', '--verbose', '--print-certs', absoluteApk]);
  const certificate = run('keytool', [
    '-list', '-v', '-storetype', 'PKCS12', '-keystore', keystorePath,
    '-storepass:env', 'ANDROID_KEYSTORE_PASSWORD', '-alias', 'openwebui-client',
  ], { ...process.env, ANDROID_KEYSTORE_PASSWORD: keystorePassword });
  validateSigningFingerprint(certificate, signature);
  const badging = run(path.join(buildTools, 'aapt'), ['dump', 'badging', absoluteApk]);
  const resources = run(path.join(buildTools, 'aapt'), ['dump', 'resources', absoluteApk]);
  const entries = run('unzip', ['-Z1', absoluteApk]);
  validateAndroidApkIcons(resources);
  validateAndroidApkIconPayloads(
    entries,
    (entry) => runBytes('unzip', ['-p', absoluteApk, entry]),
    (density, name) => readFileSync(path.join('src-tauri/gen/android/app/src/main/res', `mipmap-${density}`, name)),
  );
  return validateAndroidApkMetadata({ badging, entries, versionCode });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [, , apkPath, rawVersionCode] = process.argv;
    if (!apkPath || !rawVersionCode) throw new Error('Usage: node scripts/verify-android-apk.mjs <apk-path> <version-code>');
    const result = verifyAndroidApk(apkPath, Number(rawVersionCode));
    process.stdout.write(`Verified signed ARM64 APK ${result.applicationId}, minSdk ${result.minSdk}, versionCode ${result.versionCode}.\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
