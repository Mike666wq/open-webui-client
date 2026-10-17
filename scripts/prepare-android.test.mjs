import test from 'node:test';
import assert from 'node:assert/strict';
import { networkSecurityConfigXml, updateGradle, updateManifest } from './prepare-android.mjs';

test('manifest installs the network policy and preserves existing attributes', () => {
  const input = '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:label="Client"></application></manifest>';
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
