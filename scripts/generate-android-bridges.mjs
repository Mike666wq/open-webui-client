import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { transformWithEsbuild } from 'vite';

export async function generateAndroidBridges(root) {
  const target = path.join(root, 'src-tauri', 'android-scripts');
  await mkdir(target, { recursive: true });
  for (const name of ['download-bridge.js', 'link-bridge.js']) {
    const source = await readFile(path.join(root, 'scripts', name), 'utf8');
    const { code } = await transformWithEsbuild(source, name, { target: 'chrome74', loader: 'js' });
    await writeFile(path.join(target, name), code);
  }
}
