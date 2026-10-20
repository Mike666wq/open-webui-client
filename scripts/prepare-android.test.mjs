import test from 'node:test';
import assert from 'node:assert/strict';
import { networkSecurityConfigXml, updateGradle, updateManifest } from './prepare-android.mjs';

test('manifest installs the network policy and preserves existing attributes', () => {
  const input = '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:label="Client"><activity android:name=".MainActivity" /></application></manifest>';
  const once = updateManifest(input);
  assert.match(once, /android:label="Client"/);
  assert.match(once, /android:networkSecurityConfig="@xml\/network_security_config"/);
  assert.equal(updateManifest(once), once);
  assert.match(networkSecurityConfigXml, /<base-config cleartextTrafficPermitted="true">/);
  assert.match(networkSecurityConfigXml, /<certificates src="system"\s*\/>/);
  assert.doesNotMatch(networkSecurityConfigXml, /<certificates src="user"/);
  assert.doesNotMatch(networkSecurityConfigXml, /<domain-config|mint/);
  assert.throws(() => updateManifest(once.replace('<application', '<application android:usesCleartextTraffic="true"')), /global usesCleartextTraffic/);
  assert.match(updateManifest(input.replace('<application', '<application android:usesCleartextTraffic="${usesCleartextTraffic}"')), /usesCleartextTraffic="\$\{usesCleartextTraffic\}"/);
});

test('Gradle release signing reads secrets from environment and stays idempotent', () => {
  const input = `android {
    compileSdk = 37
    defaultConfig {
        minSdk = 29
        targetSdk = 37
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        manifestPlaceholders["usesCleartextTraffic"] = "false"
    }
    buildTypes {
        getByName("debug") { manifestPlaceholders["usesCleartextTraffic"] = "true" }
        getByName("release") {
            isMinifyEnabled = false
        }
    }
}`;
  const once = updateGradle(input);
  assert.match(once, /create\("release"\)/);
  assert.match(once, /compileSdk = 36/);
  assert.match(once, /targetSdk = 36/);
  assert.match(once, /minSdk = 29/);
  assert.match(once, /androidResources\s*\{\n\s*ignoreAssetsPatterns\.clear\(\)\n\s*ignoreAssetsPatterns\.add\("([^"]*)"\)/);
  const androidResources = once.match(/androidResources\s*\{([\s\S]*?)\n\s*\}/)?.[1];
  assert.ok(androidResources);
  assert.doesNotMatch(androidResources, /<dir>_\*/);
  assert.ok(androidResources.includes('!.git'));
  assert.ok(androidResources.includes('!*.jpg'));
  assert.match(once, /versionCode = tauriProperties\.getProperty\("tauri\.android\.versionCode", "1"\)\.toInt\(\)/);
  assert.match(once, /ANDROID_KEYSTORE_PATH/);
  assert.match(once, /if \(System\.getenv\("ANDROID_KEYSTORE_PATH"\) != null\)/);
  assert.equal((once.match(/manifestPlaceholders\["usesCleartextTraffic"\]\s*=\s*"false"/g) ?? []).length, 2);
  assert.match(once, /signingConfig = signingConfigs\.getByName\("release"\)/);
  assert.match(once, /isMinifyEnabled = false/);
  assert.equal(updateGradle(once), once);

  const release = updateGradle(once, 1042);
  assert.match(release, /versionCode = 1042/);
  assert.equal(updateGradle(release, 1042), release);
  assert.throws(() => updateGradle(release, 1043), /unexpected Android defaultConfig versionCode/);
  assert.throws(() => updateGradle(once, 1000), /between 1001 and 2100000000/);
  assert.throws(() => updateGradle(once, 2_100_000_001), /between 1001 and 2100000000/);
});

test('app Gradle rejects an unexpected Android asset filter instead of duplicating rules', () => {
  const input = `android {
    compileSdk = 36
    androidResources {
        ignoreAssetsPatterns.add("<dir>_*")
    }
    defaultConfig {
        minSdk = 29
        targetSdk = 36
    }
}`;
  assert.throws(() => updateGradle(input), /unexpected androidResources configuration/);
});


test('Android manifest pins resize and preserves unrelated activity attributes idempotently', () => {
  const source = '<manifest><application><activity android:name=".MainActivity" android:exported="true" android:windowSoftInputMode="adjustPan" /></application></manifest>';
  const result = updateManifest(source);
  assert.match(result, /android:windowSoftInputMode="adjustResize"/);
  assert.match(result, /android:exported="true"/);
  assert.equal(updateManifest(result), result);
});

test('theme and font changes are handled without Activity recreation, retaining existing flags', () => {
  const source = '<manifest><application><activity android:name=".MainActivity" android:configChanges="keyboardHidden|locale" /></application></manifest>';
  const result = updateManifest(source);
  assert.equal(updateManifest(result), result);
  const flags = result.match(/android:configChanges="([^"]+)"/)[1].split('|');
  for (const flag of ['keyboardHidden', 'locale', 'uiMode', 'fontScale', 'orientation', 'screenSize']) assert.ok(flags.includes(flag));
});
