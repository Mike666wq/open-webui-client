import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const androidRoot = path.join(projectRoot, 'src-tauri', 'gen', 'android');
const ANDROID_SDK_LEVEL = 36;
const MIN_RELEASE_VERSION_CODE = 1001;
const MAX_RELEASE_VERSION_CODE = 2_100_000_000;
// AAPT applies "!" entries as filters and only suppresses their warnings.
// Preserve its developer-file cleanup without filtering web media or "_app".
const ANDROID_ASSET_IGNORE_PATTERNS =
  '!.svn:!.git:!.ds_store:!*.scc:.*:!CVS:!thumbs.db:!picasa.ini:!*~';

export const networkSecurityConfigXml = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="true">
        <trust-anchors>
            <certificates src="system" />
        </trust-anchors>
    </base-config>
</network-security-config>
`;

export function updateManifest(source) {
  if (!source.includes('<manifest') || !source.includes('<application')) {
    throw new Error('AndroidManifest.xml is missing a manifest or application element');
  }
  if (/android:usesCleartextTraffic\s*=\s*["']true["']/i.test(source)) {
    throw new Error('Refusing a global usesCleartextTraffic setting; use the Android network security config');
  }

  let result = source;
  if (!/android:networkSecurityConfig\s*=/.test(result)) {
    result = result.replace(/<application\b/, '<application android:networkSecurityConfig="@xml/network_security_config"');
  }
  if (!result.includes('android:networkSecurityConfig="@xml/network_security_config"')) {
    throw new Error('AndroidManifest.xml already uses an unexpected network security configuration');
  }
  // The native Insets owner handles edge-to-edge and IME overlap consistently.
  const activities = [...result.matchAll(/<activity\b[^>]*>/g)];
  const main = activities.find(([tag]) => /android:name\s*=\s*["'][^"']*MainActivity["']/.test(tag));
  if (!main) throw new Error('AndroidManifest.xml has no generated MainActivity');
  const tag = main[0];
  const updated = /android:windowSoftInputMode\s*=/.test(tag)
    ? tag.replace(/android:windowSoftInputMode\s*=\s*(["'])[^"']*\1/, 'android:windowSoftInputMode="adjustResize"')
    : tag;
  const adjusted = /android:windowSoftInputMode\s*=/.test(tag) ? updated
    : tag.replace(/\s*\/?>$/, (ending) => ` android:windowSoftInputMode="adjustResize"${ending}`);
  const config = adjusted.match(/android:configChanges\s*=\s*(["'])([^"']*)\1/);
  const flags = new Set((config?.[2] || '').split('|').filter(Boolean));
  // Updating native colors and font metrics must preserve the existing WebView.
  for (const flag of ['uiMode', 'fontScale', 'orientation', 'screenSize', 'screenLayout', 'smallestScreenSize']) flags.add(flag);
  const configAttribute = `android:configChanges="${[...flags].join('|')}"`;
  const themed = config ? adjusted.replace(config[0], configAttribute)
    : adjusted.replace(/\s*\/?>$/, (ending) => ` ${configAttribute}${ending}`);
  return result.replace(tag, themed);
}

function parseReleaseVersionCode(value) {
  const versionCode = Number(value);
  if (!Number.isSafeInteger(versionCode) || versionCode < MIN_RELEASE_VERSION_CODE || versionCode > MAX_RELEASE_VERSION_CODE) {
    throw new Error(`Release versionCode must be an integer between ${MIN_RELEASE_VERSION_CODE} and ${MAX_RELEASE_VERSION_CODE}`);
  }
  return versionCode;
}

function updateReleaseVersionCode(source, value) {
  const versionCode = parseReleaseVersionCode(value);
  const assignments = [...source.matchAll(/^(\s*)versionCode\s*=\s*(.*?)\s*$/gm)];
  if (assignments.length !== 1) {
    throw new Error('Expected exactly one Android defaultConfig versionCode assignment');
  }

  const [line] = assignments[0];
  const indentation = assignments[0][1];
  const current = assignments[0][2];
  const template = 'tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()';
  if (current === String(versionCode)) return source;
  if (current !== template) {
    throw new Error('Refusing to replace an unexpected Android defaultConfig versionCode');
  }
  return source.replace(line, `${indentation}versionCode = ${versionCode}`);
}

function ensureAppAssetsArePackaged(source) {
  const block = `    // SvelteKit serves immutable chunks from _app. AAPT's default
    // "<dir>_*" filter otherwise removes that directory from the final APK.
    androidResources {
        ignoreAssetsPatterns.clear()
        ignoreAssetsPatterns.add("${ANDROID_ASSET_IGNORE_PATTERNS}")
    }

`;
  if (source.includes(block)) return source;
  if (/^\s*androidResources\s*\{/m.test(source)) {
    throw new Error('app/build.gradle.kts already has an unexpected androidResources configuration');
  }

  const defaultConfig = /\n(\s*)defaultConfig\s*\{/;
  if (!defaultConfig.test(source)) throw new Error('app/build.gradle.kts has no defaultConfig block');
  return source.replace(defaultConfig, `\n${block}$1defaultConfig {`);
}

export function updateGradle(source, releaseVersionCode = null) {
  if (!source.includes('android {')) throw new Error('app/build.gradle.kts has no android block');
  const requiredEnv = `            storeFile = file(System.getenv("ANDROID_KEYSTORE_PATH") ?: throw GradleException("ANDROID_KEYSTORE_PATH is required"))
            storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD") ?: throw GradleException("ANDROID_KEYSTORE_PASSWORD is required")
            keyAlias = System.getenv("ANDROID_KEY_ALIAS") ?: throw GradleException("ANDROID_KEY_ALIAS is required")
            keyPassword = System.getenv("ANDROID_KEY_PASSWORD") ?: throw GradleException("ANDROID_KEY_PASSWORD is required")`;

  let result = source;
  const compileSdk37 = result.match(/compileSdk\s*=\s*37\b/g) ?? [];
  const targetSdk37 = result.match(/targetSdk\s*=\s*37\b/g) ?? [];
  const compileSdk36 = result.match(/compileSdk\s*=\s*36\b/g) ?? [];
  const targetSdk36 = result.match(/targetSdk\s*=\s*36\b/g) ?? [];
  if (compileSdk37.length === 1 && targetSdk37.length === 1 && compileSdk36.length === 0 && targetSdk36.length === 0) {
    result = result.replace(/compileSdk\s*=\s*37\b/, `compileSdk = ${ANDROID_SDK_LEVEL}`);
    result = result.replace(/targetSdk\s*=\s*37\b/, `targetSdk = ${ANDROID_SDK_LEVEL}`);
  } else if (compileSdk36.length !== 1 || targetSdk36.length !== 1 || compileSdk37.length !== 0 || targetSdk37.length !== 0) {
    throw new Error('Expected the Tauri CLI 2.12.2 Android template to declare compileSdk and targetSdk 37 exactly once');
  }
  result = ensureAppAssetsArePackaged(result);
  result = result.replace(/manifestPlaceholders\["usesCleartextTraffic"\]\s*=\s*"true"/g, 'manifestPlaceholders["usesCleartextTraffic"] = "false"');
  const signingBlock = `    if (System.getenv("ANDROID_KEYSTORE_PATH") != null) {
        signingConfigs {
        create("release") {
${requiredEnv}
        }
        }
    }

`;

  if (!result.includes('create("release")')) {
    result = result.replace(/(\n\s*buildTypes\s*\{)/, `\n${signingBlock}$1`);
  }
  if (!result.includes('create("release")')) {
    throw new Error('Could not add release signing configuration before buildTypes');
  }

  if (releaseVersionCode != null) {
    result = updateReleaseVersionCode(result, releaseVersionCode);
  }

  if (!/signingConfig\s*=\s*signingConfigs\.getByName\("release"\)/.test(result)) {
    const releaseBlock = /(buildTypes\s*\{[\s\S]*?getByName\("release"\)\s*\{)/;
    if (!releaseBlock.test(result)) throw new Error('Could not find the generated release build type in app/build.gradle.kts');
    result = result.replace(releaseBlock, '$1\n            if (System.getenv("ANDROID_KEYSTORE_PATH") != null) {\n                signingConfig = signingConfigs.getByName("release")\n            }');
  }
  return result;
}

export async function prepareAndroidProject(root = projectRoot, { env = process.env } = {}) {
  const releaseVersionCode = env.ANDROID_RELEASE_VERSION_CODE ?? null;
  const keystorePath = env.ANDROID_KEYSTORE_PATH ?? null;
  if ((releaseVersionCode == null) !== (keystorePath == null)) {
    throw new Error('ANDROID_RELEASE_VERSION_CODE and ANDROID_KEYSTORE_PATH must be set together for a signed release');
  }
  const mainDir = path.join(root, 'src-tauri', 'gen', 'android', 'app', 'src', 'main');
  const manifestPath = path.join(mainDir, 'AndroidManifest.xml');
  const gradlePath = path.join(root, 'src-tauri', 'gen', 'android', 'app', 'build.gradle.kts');
  const manifest = updateManifest(await readFile(manifestPath, 'utf8'));
  const gradle = updateGradle(await readFile(gradlePath, 'utf8'), releaseVersionCode);
  await writeFile(manifestPath, manifest);
  await writeFile(gradlePath, gradle);
  const resourceDir = path.join(mainDir, 'res', 'xml');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(resourceDir, { recursive: true });
  await writeFile(path.join(resourceDir, 'network_security_config.xml'), networkSecurityConfigXml);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareAndroidProject();
}
