import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const androidRoot = path.join(projectRoot, 'src-tauri', 'gen', 'android');
const ANDROID_SDK_LEVEL = 36;

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
  return result;
}

export function updateGradle(source) {
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

  if (!/signingConfig\s*=\s*signingConfigs\.getByName\("release"\)/.test(result)) {
    const releaseBlock = /(buildTypes\s*\{[\s\S]*?getByName\("release"\)\s*\{)/;
    if (!releaseBlock.test(result)) throw new Error('Could not find the generated release build type in app/build.gradle.kts');
    result = result.replace(releaseBlock, '$1\n            if (System.getenv("ANDROID_KEYSTORE_PATH") != null) {\n                signingConfig = signingConfigs.getByName("release")\n            }');
  }
  return result;
}

export async function prepareAndroidProject(root = projectRoot) {
  const mainDir = path.join(root, 'src-tauri', 'gen', 'android', 'app', 'src', 'main');
  const manifestPath = path.join(mainDir, 'AndroidManifest.xml');
  const gradlePath = path.join(root, 'src-tauri', 'gen', 'android', 'app', 'build.gradle.kts');
  const manifest = updateManifest(await readFile(manifestPath, 'utf8'));
  const gradle = updateGradle(await readFile(gradlePath, 'utf8'));
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
