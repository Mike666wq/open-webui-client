import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ALIAS = 'openwebui-client';
const KEYSTORE_FILENAME = 'openwebui-client.p12';
const FINGERPRINT_FILENAME = 'keystore-fingerprint.txt';

function runKeytool(args, env) {
  const result = spawnSync('keytool', args, { encoding: 'utf8', env });
  if (result.error || result.status !== 0) {
    throw new Error(`keytool failed (${result.status ?? result.error?.code ?? 'unknown error'})`);
  }
  return result.stdout;
}

export async function generateAndroidKeystore(outputDirectory, env = process.env) {
  if (!env.ANDROID_KEYSTORE_PASSWORD) {
    throw new Error('ANDROID_KEYSTORE_PASSWORD is required');
  }
  if (env.ANDROID_KEYSTORE_PASSWORD.length < 32) {
    throw new Error('ANDROID_KEYSTORE_PASSWORD must contain at least 32 characters');
  }
  if (env.ANDROID_KEYSTORE_BASE64) {
    throw new Error('ANDROID_KEYSTORE_BASE64 already exists; refusing to regenerate the signing key');
  }

  const outputRoot = path.resolve(outputDirectory);
  const keystorePath = path.join(outputRoot, KEYSTORE_FILENAME);
  const fingerprintPath = path.join(outputRoot, FINGERPRINT_FILENAME);
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  await chmod(outputRoot, 0o700);
  try {
    await readFile(keystorePath);
    throw new Error('Refusing to replace an existing keystore file');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const commandEnv = { ...env, ANDROID_KEY_ALIAS: ALIAS };
  try {
    runKeytool([
      '-genkeypair',
      '-alias', ALIAS,
      '-keyalg', 'RSA',
      '-keysize', '3072',
      '-validity', '10000',
      '-dname', 'CN=Open WebUI Client, OU=Android, O=Open WebUI Client, C=US',
      '-storetype', 'PKCS12',
      '-keystore', keystorePath,
      '-storepass:env', 'ANDROID_KEYSTORE_PASSWORD',
      '-keypass:env', 'ANDROID_KEYSTORE_PASSWORD',
    ], commandEnv);
    await chmod(keystorePath, 0o600);

    const details = runKeytool([
      '-list', '-v',
      '-storetype', 'PKCS12',
      '-keystore', keystorePath,
      '-storepass:env', 'ANDROID_KEYSTORE_PASSWORD',
      '-alias', ALIAS,
    ], commandEnv);
    const fingerprint = details.match(/^\s*SHA256:\s*(.+)$/m)?.[1]?.trim();
    if (!fingerprint) throw new Error('Could not read the generated certificate SHA-256 fingerprint');

    await writeFile(fingerprintPath, `Alias: ${ALIAS}\nSHA-256 certificate fingerprint: ${fingerprint}\n`, { mode: 0o600, flag: 'wx' });
    await chmod(fingerprintPath, 0o600);
    return { keystorePath, fingerprintPath, fingerprint, alias: ALIAS };
  } catch (error) {
    await Promise.all([
      import('node:fs/promises').then(({ rm }) => rm(keystorePath, { force: true })),
      import('node:fs/promises').then(({ rm }) => rm(fingerprintPath, { force: true })),
    ]);
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const outputDirectory = process.argv[2];
    if (!outputDirectory) throw new Error('Usage: node scripts/generate-android-keystore.mjs <output-directory>');
    const generated = await generateAndroidKeystore(outputDirectory);
    process.stdout.write(`Generated a password-protected PKCS#12 keystore and SHA-256 fingerprint in ${path.resolve(outputDirectory)}.\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
