import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateServiceUrl } from '../src/trust.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function generateClientConfig() {
  const config = JSON.parse(await readFile(path.join(root, 'client.config.json'), 'utf8'));
  const service = validateServiceUrl(config.serviceUrl);
  const permissionFor = (command) => `allow-${command.replaceAll('_', '-')}`;
  if (!Number.isInteger(config.preflightTimeoutMs) || config.preflightTimeoutMs < 1 || config.preflightTimeoutMs > 5000) {
    throw new TypeError('preflightTimeoutMs must be an integer from 1 through 5000');
  }

  const capabilitiesDir = path.join(root, 'src-tauri', 'capabilities');
  await mkdir(capabilitiesDir, { recursive: true });
  await writeFile(
    path.join(capabilitiesDir, 'remote.json'),
    `${JSON.stringify({
      identifier: 'remote-service',
      description: 'Allows the configured Open WebUI service to open external links.',
      windows: ['main'],
      local: false,
      remote: { urls: [`${service.origin}/*`] },
      permissions: [permissionFor('open_external')],
    }, null, 2)}\n`,
  );

  await writeFile(
    path.join(root, 'src', 'client-config.generated.js'),
    `export default Object.freeze(${JSON.stringify({
      serviceUrl: service.origin,
      preflightTimeoutMs: config.preflightTimeoutMs,
    }, null, 2)});\n`,
  );
  await writeFile(
    path.join(root, 'src-tauri', 'src', 'service_url.generated.rs'),
    `pub const SERVICE_URL: &str = ${JSON.stringify(service.origin)};\npub const PREFLIGHT_TIMEOUT_MS: u64 = ${config.preflightTimeoutMs};\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generateClientConfig();
}
