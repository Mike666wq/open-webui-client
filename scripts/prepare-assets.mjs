import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { generateClientConfig } from './generate-client-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await generateClientConfig();
const tauriBin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri');
const result = spawnSync(tauriBin, ['icon', 'src-tauri/icons/source.svg'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
