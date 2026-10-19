import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { generateClientConfig } from './generate-client-config.mjs';
import { generateAndroidBridges } from './generate-android-bridges.mjs';
import { ensureAndroidIconResources } from './android-icons.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'public', 'app-icon.png');
const welcomeSources = [
  path.join(root, 'open-webui-frontend', 'static', 'assets', 'welcome.webp'),
  path.join(
    root,
    'src-tauri',
    'plugins',
    'connection-controls',
    'android',
    'src',
    'main',
    'assets',
    'bundled-frontend',
    'assets',
    'welcome.webp',
  ),
];
const welcomeAssetPath = path.join(
  root,
  'src-tauri',
  'plugins',
  'connection-controls',
  'android',
  'src',
  'main',
  'assets',
  'connection-welcome.webp',
);
const sourceHash = '01b8f5cc95d4a2991bab0d854f71ace436160ec9416a8b31894b8dd68b8a7b9e';
const source = await readFile(sourcePath);
const actualHash = createHash('sha256').update(source).digest('hex');
if (actualHash !== sourceHash) {
  throw new Error(`Official Open WebUI icon source hash mismatch: ${actualHash}`);
}

await generateClientConfig();
await generateAndroidBridges(root);
await mkdir(path.dirname(welcomeAssetPath), { recursive: true });
try {
  await access(welcomeAssetPath);
} catch {
  let welcomeSourcePath;
  for (const candidate of welcomeSources) {
    try {
      await access(candidate);
      welcomeSourcePath = candidate;
      break;
    } catch {
      // Use the verified bundled frontend copy when the local checkout is absent.
    }
  }
  if (!welcomeSourcePath) {
    throw new Error('Could not find welcome.webp in the local or prepared official frontend');
  }
  await copyFile(welcomeSourcePath, welcomeAssetPath);
}
const tauriBin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri');
const result = spawnSync(tauriBin, ['icon', 'public/app-icon.png'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

await ensureAndroidIconResources(root);
