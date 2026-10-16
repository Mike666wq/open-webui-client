import test from 'node:test';
import assert from 'node:assert/strict';
import { updateGradle, updateManifest } from './prepare-android.mjs';

test('manifest scopes cleartext permission to mint and preserves existing attributes', () => {
  const input = '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:label="Client"></application></manifest>';
  const once = updateManifest(input);
  assert.match(once, /android:label="Client"/);
  assert.match(once, /android:networkSecurityConfig="@xml\/network_security_config"/);
  assert.equal(updateManifest(once), once);
  assert.throws(() => updateManifest(once.replace('<application', '<application android:usesCleartextTraffic="true"')), /global usesCleartextTraffic/);
  assert.match(updateManifest(input.replace('<application', '<application android:usesCleartextTraffic="${usesCleartextTraffic}"')), /usesCleartextTraffic="\$\{usesCleartextTraffic\}"/);
});

test('Gradle release signing reads secrets from environment and stays idempotent', () => {
  const input = `android {
    defaultConfig { manifestPlaceholders["usesCleartextTraffic"] = "false" }
    buildTypes {
        getByName("debug") { manifestPlaceholders["usesCleartextTraffic"] = "true" }
        getByName("release") {
            isMinifyEnabled = false
        }
    }
}`;
  const once = updateGradle(input);
  assert.match(once, /create\("release"\)/);
  assert.match(once, /ANDROID_KEYSTORE_PATH/);
  assert.match(once, /if \(System\.getenv\("ANDROID_KEYSTORE_PATH"\) != null\)/);
  assert.equal((once.match(/manifestPlaceholders\["usesCleartextTraffic"\]\s*=\s*"false"/g) ?? []).length, 2);
  assert.match(once, /signingConfig = signingConfigs\.getByName\("release"\)/);
  assert.match(once, /isMinifyEnabled = false/);
  assert.equal(updateGradle(once), once);
});
