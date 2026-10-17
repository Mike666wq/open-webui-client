import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeKeystoreBase64, validateAndroidKeystore } from './validate-android-keystore.mjs';

test('keystore Base64 validator accepts canonical non-empty bytes only', () => {
  const encoded = Buffer.from([0x30, 0x82, 0x01, 0x02]).toString('base64');
  assert.deepEqual(decodeKeystoreBase64(encoded), Buffer.from([0x30, 0x82, 0x01, 0x02]));
  for (const invalid of ['', 'AQ', 'AQ==\n', 'AQ===', '!!!!']) {
    assert.throws(() => decodeKeystoreBase64(invalid), /canonical Base64/);
  }
});

test('keystore check requires a strong password and checks the fixed alias without exposing keytool output', async () => {
  const bytes = Buffer.from('fake-pkcs12');
  await assert.rejects(validateAndroidKeystore({
    base64: bytes.toString('base64'),
    password: 'short',
    runKeytool: () => { throw new Error('must not be invoked'); },
  }), /at least 32 characters/);

  let invocation;
  const result = await validateAndroidKeystore({
    base64: bytes.toString('base64'),
    password: 'a'.repeat(40),
    runKeytool: (args, env) => {
      invocation = { args, env };
      return { status: 0, stdout: 'sensitive certificate details\nEntry type: PrivateKeyEntry' };
    },
  });
  assert.deepEqual(result, { alias: 'openwebui-client' });
  assert.equal(invocation.args.includes('openwebui-client'), true);
  assert.equal(invocation.args.includes('ANDROID_KEYSTORE_PASSWORD'), true);
  assert.equal(invocation.env.ANDROID_KEYSTORE_PASSWORD, 'a'.repeat(40));
  assert.equal(Object.values(result).includes('sensitive certificate details'), false);
});

test('keystore check fails with a sanitized error when password or alias is wrong', async () => {
  await assert.rejects(validateAndroidKeystore({
    base64: Buffer.from('fake-pkcs12').toString('base64'),
    password: 'a'.repeat(40),
    runKeytool: () => ({ status: 1, stdout: 'leaked path or details', stderr: 'details' }),
  }), (error) => {
    assert.equal(error.message, 'The Android keystore could not be opened with the configured password and alias');
    return true;
  });
  await assert.rejects(validateAndroidKeystore({
    base64: Buffer.from('fake-pkcs12').toString('base64'),
    password: 'a'.repeat(40),
    runKeytool: () => ({ status: 0, stdout: 'Entry type: trustedCertEntry' }),
  }), /could not be opened with the configured password and alias/);
});
