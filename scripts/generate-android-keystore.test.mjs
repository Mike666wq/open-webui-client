import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateAndroidKeystore } from './generate-android-keystore.mjs';

test('keystore bootstrap requires a password and refuses an existing Base64 signing key', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'owc-keystore-guard-'));
  try {
    await assert.rejects(generateAndroidKeystore(root, {}), /ANDROID_KEYSTORE_PASSWORD is required/);
    await assert.rejects(
      generateAndroidKeystore(root, { ANDROID_KEYSTORE_PASSWORD: 'too-short' }),
      /at least 32 characters/,
    );
    await assert.rejects(
      generateAndroidKeystore(root, {
        ANDROID_KEYSTORE_PASSWORD: 'test-only-placeholder-0123456789abcdef',
        ANDROID_KEYSTORE_BASE64: 'already configured',
      }),
      /refusing to regenerate/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('keystore bootstrap does not overwrite an existing PKCS#12 file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'owc-keystore-existing-'));
  try {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'openwebui-client.p12'), 'keep');
    await assert.rejects(
      generateAndroidKeystore(root, { ANDROID_KEYSTORE_PASSWORD: 'test-only-placeholder-0123456789abcdef' }),
      /Refusing to replace an existing keystore file/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
