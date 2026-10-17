import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateServiceUrl } from '../src/trust.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function generateClientConfig() {
  const config = JSON.parse(await readFile(path.join(root, 'client.config.json'), 'utf8'));
  const service = validateServiceUrl(config.defaultServiceUrl);

  await writeFile(
    path.join(root, 'src', 'client-config.generated.js'),
    `export default Object.freeze(${JSON.stringify({
      defaultServiceUrl: service.origin,
    }, null, 2)});\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generateClientConfig();
}
