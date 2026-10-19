import { spawnSync } from 'node:child_process';
import { PNG } from 'pngjs';
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

export function validateAndroidApkIcons(resourceDump, manifestTree) {
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

  const splashAttributeIds = ['0x0101062d', '0x0101062c'];
  const startupThemeIds = [...manifestTree.matchAll(
    /A: android:theme\([^)]*\)=@(?:0x)?([0-9a-f]+)/gi,
  )].map((match) => `0x${match[1].toLowerCase()}`);
  if (startupThemeIds.length === 0) {
    throw new Error('APK manifest does not assign an application or activity startup theme');
  }

  const styleBlocks = resourceDump.split(/(?=^[ \t]*resource\s+0x[0-9a-f]+\s+[^\r\n]*:style)/gim);
  const startupStyles = styleBlocks.filter((block) =>
    startupThemeIds.some((id) => new RegExp(`^[ \t]*resource\\s+${id}\\b`, 'im').test(block)),
  );
  if (!startupStyles.some((block) =>
    splashAttributeIds.every((id) => new RegExp(`\\b${id}\\b`, 'i').test(block)),
  )) {
    throw new Error('APK startup theme does not reference both Android 12 splash-screen attributes');
  }
  return true;
}
// AAPT2 may shorten archive paths and recompress PNGs. Resolve the paths from
// the compiled resource table, then compare decoded pixels rather than ZIP names
// or compressed bytes. This still rejects missing, duplicated or altered icons.
export function androidIconPaths(resourceDump) {
  const paths = new Map();
  let resource;
  for (const line of resourceDump.split(/\r?\n/)) {
    const header = line.match(/^\s*resource\s+0x[0-9a-f]+\s+(?:[^:\s]+:)?([^\s]+)/i);
    if (header) resource = header[1];
    if (!/^mipmap\/ic_launcher(?:_round|_foreground)?$/.test(resource ?? '')) continue;
    const value = line.match(/^\s*\(([^)]*)\)\s+\(file\)\s+(\S+)/);
    if (!value || !/^(?:mdpi|hdpi|xhdpi|xxhdpi|xxxhdpi)(?:-v\d+)?$/.test(value[1])) continue;
    const density = value[1].split('-')[0];
    const name = resource.slice('mipmap/'.length) + '.png';
    const key = `${density}/${name}`;
    if (paths.has(key)) throw new Error(`APK has multiple ${density} ${name} resource values`);
    if (!/^res\/[^\s]+\.png$/.test(value[2]) || value[2].split('/').includes('..')) {
      throw new Error(`APK has an invalid ${density} ${name} resource path`);
    }
    paths.set(key, value[2]);
  }
  return paths;
}

function decodeIcon(bytes, description) {
  let image;
  try {
    image = PNG.sync.read(bytes);
  } catch {
    throw new Error(`Could not decode ${description} as a PNG`);
  }
  // AAPT may discard invisible RGB values when alpha is zero.
  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i + 3] === 0) image.data.fill(0, i, i + 3);
  }
  return image;
}

export function validateAndroidApkIconPayloads(resourceDump, entries, readArchiveEntry, readGeneratedIcon) {
  const paths = androidIconPaths(resourceDump);
  const archiveEntries = entries.split(/\r?\n/);
  const densities = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];
  const names = ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png'];
  for (const density of densities) {
    for (const name of names) {
      const entry = paths.get(`${density}/${name}`);
      if (!entry || archiveEntries.filter((candidate) => candidate === entry).length !== 1) {
        throw new Error(`APK must contain exactly one ${density} ${name} resource`);
      }
      const generated = decodeIcon(readGeneratedIcon(density, name), `generated ${density} ${name}`);
      const packaged = decodeIcon(readArchiveEntry(entry), `packaged ${density} ${name}`);
      if (generated.width !== packaged.width || generated.height !== packaged.height ||
          !generated.data.equals(packaged.data)) {
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
  const aapt = path.join(buildTools, 'aapt');
  const badging = run(aapt, ['dump', 'badging', absoluteApk]);
  const entries = run('unzip', ['-Z1', absoluteApk]);
  verifyAndroidApkIconResources(absoluteApk, { androidHome });
  run('python3', [
    fileURLToPath(new URL('./bundled-frontend-archive.py', import.meta.url)),
    'apk', absoluteApk,
    fileURLToPath(new URL('../frontend.lock.json', import.meta.url)),
  ]);
  return validateAndroidApkMetadata({ badging, entries, versionCode });
}

export function verifyAndroidApkIconResources(apkPath, {
  androidHome = process.env.ANDROID_HOME,
  resourceRoot = 'src-tauri/gen/android/app/src/main/res',
} = {}) {
  if (!androidHome) throw new Error('ANDROID_HOME is required to verify APK icons');
  const absoluteApk = path.resolve(apkPath);
  const buildTools = path.join(androidHome, 'build-tools', '36.0.0');
  const resources = run(path.join(buildTools, 'aapt2'), ['dump', 'resources', absoluteApk]);
  const manifestTree = run(path.join(buildTools, 'aapt'), ['dump', 'xmltree', absoluteApk, 'AndroidManifest.xml']);
  // Existing startup-theme validation uses the legacy AAPT style/attribute format.
  const legacyResources = run(path.join(buildTools, 'aapt'), ['dump', '--values', 'resources', absoluteApk]);
  validateAndroidApkIcons(legacyResources, manifestTree);
  return validateAndroidApkIconPayloads(
    resources,
    run('unzip', ['-Z1', absoluteApk]),
    (entry) => runBytes('unzip', ['-p', absoluteApk, entry]),
    (density, name) => readFileSync(path.join(resourceRoot, `mipmap-${density}`, name)),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [, , apkPath, rawVersionCode] = process.argv;
    if (apkPath && rawVersionCode === '--icons-only') {
      verifyAndroidApkIconResources(apkPath);
      process.stdout.write('Verified compiled APK launcher resources and official icon pixels.\n');
    } else {
      if (!apkPath || !rawVersionCode) throw new Error('Usage: node scripts/verify-android-apk.mjs <apk-path> <version-code>');
      const result = verifyAndroidApk(apkPath, Number(rawVersionCode));
      process.stdout.write(`Verified signed ARM64 APK ${result.applicationId}, minSdk ${result.minSdk}, versionCode ${result.versionCode}.\n`);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
