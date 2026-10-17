import { chmod, rm, writeFile, mkdtemp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ANDROID_KEY_ALIAS = 'openwebui-client';

export function decodeKeystoreBase64(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) {
    throw new Error('ANDROID_KEYSTORE_BASE64 must be non-empty canonical Base64');
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('ANDROID_KEYSTORE_BASE64 must be non-empty canonical Base64');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== value) {
    throw new Error('ANDROID_KEYSTORE_BASE64 must decode to non-empty canonical bytes');
  }
  return bytes;
}

export async function validateAndroidKeystore({
  base64 = process.env.ANDROID_KEYSTORE_BASE64,
  password = process.env.ANDROID_KEYSTORE_PASSWORD,
  tempRoot = os.tmpdir(),
  runKeytool = (args, env) => spawnSync('keytool', args, { encoding: 'utf8', env }),
} = {}) {
  if (typeof password !== 'string' || password.length < 32) {
    throw new Error('ANDROID_KEYSTORE_PASSWORD must contain at least 32 characters');
  }
  const bytes = decodeKeystoreBase64(base64);
  const directory = await mkdtemp(path.join(tempRoot, 'android-keystore-check-'));
  const keystorePath = path.join(directory, 'release.p12');
  try {
    await writeFile(keystorePath, bytes, { mode: 0o600, flag: 'wx' });
    await chmod(keystorePath, 0o600);
    const result = runKeytool([
      '-list',
      '-v',
      '-storetype', 'PKCS12',
      '-keystore', keystorePath,
      '-storepass:env', 'ANDROID_KEYSTORE_PASSWORD',
      '-alias', ANDROID_KEY_ALIAS,
    ], { ...process.env, ANDROID_KEYSTORE_PASSWORD: password });
    if (result.error || result.status !== 0 || !/Entry type:\s*PrivateKeyEntry/i.test(result.stdout ?? '')) {
      throw new Error('The Android keystore could not be opened with the configured password and alias');
    }
    return { alias: ANDROID_KEY_ALIAS };
  } finally {
    bytes.fill(0);
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await validateAndroidKeystore();
    process.stdout.write('Android signing keystore and fixed alias validated.\n');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
