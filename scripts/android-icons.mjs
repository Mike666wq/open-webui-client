import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DENSITIES = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];

export function setAndroidApplicationIcons(manifest) {
  const applications = [...manifest.matchAll(/<application\b[^>]*>/g)];
  if (applications.length !== 1) {
    throw new Error('Expected exactly one application element in AndroidManifest.xml');
  }

  const [tag] = applications[0];
  let updatedTag = tag;
  for (const [name, value] of [
    ['icon', '@mipmap/ic_launcher'],
    ['roundIcon', '@mipmap/ic_launcher_round'],
  ]) {
    const attribute = new RegExp(`\\s+android:${name}\\s*=\\s*(["'])[^"']*\\1`);
    if (attribute.test(updatedTag)) {
      updatedTag = updatedTag.replace(attribute, ` android:${name}="${value}"`);
    } else {
      updatedTag = updatedTag.replace(/\s*\/?>$/, (ending) => ` android:${name}="${value}"${ending}`);
    }
  }
  return manifest.replace(tag, updatedTag);
}

export function adaptiveIconXml() {
  return `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`;
}

export function splashThemeXml(baseThemes) {
  const styles = [...baseThemes.matchAll(/<style\b([^>]*)>/g)];
  const theme = styles.find(([, attributes]) => /\bname\s*=\s*["']Theme\.[^"']+["']/.test(attributes));
  if (!theme) throw new Error('Could not find the generated Tauri application theme in values/themes.xml');

  const attributes = theme[1];
  const name = attributes.match(/\bname\s*=\s*(["'])(.*?)\1/)?.[2];
  const parent = attributes.match(/\bparent\s*=\s*(["'])(.*?)\1/)?.[2];
  if (!name || !parent) throw new Error('Generated Tauri application theme is missing its name or parent');

  return `<resources xmlns:android="http://schemas.android.com/apk/res/android">
    <style name="${name}" parent="${parent}">
        <item name="android:windowSplashScreenBackground">@color/ic_launcher_background</item>
        <item name="android:windowSplashScreenAnimatedIcon">@mipmap/ic_launcher</item>
    </style>
</resources>
`;
}

async function requireGeneratedIcons(resDir) {
  for (const density of DENSITIES) {
    for (const filename of ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png']) {
      await access(path.join(resDir, `mipmap-${density}`, filename));
    }
  }
}

export async function ensureAndroidIconResources(root) {
  const androidRoot = path.join(root, 'src-tauri', 'gen', 'android', 'app', 'src', 'main');
  const manifestPath = path.join(androidRoot, 'AndroidManifest.xml');
  try {
    await access(manifestPath);
  } catch {
    return false;
  }

  const resDir = path.join(androidRoot, 'res');
  await requireGeneratedIcons(resDir);
  const manifest = await readFile(manifestPath, 'utf8');
  if (!manifest.includes('<application')) throw new Error('AndroidManifest.xml has no application element');
  const valuesPath = path.join(resDir, 'values', 'themes.xml');
  const themes = await readFile(valuesPath, 'utf8');

  const adaptivePath = path.join(resDir, 'mipmap-anydpi-v26');
  const splashPath = path.join(resDir, 'values-v31');
  const valuesDir = path.join(resDir, 'values');
  await Promise.all([
    mkdir(adaptivePath, { recursive: true }),
    mkdir(splashPath, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(valuesDir, 'ic_launcher_background.xml'), '<resources><color name="ic_launcher_background">#FFFFFF</color></resources>\n'),
    writeFile(path.join(adaptivePath, 'ic_launcher.xml'), adaptiveIconXml()),
    writeFile(path.join(adaptivePath, 'ic_launcher_round.xml'), adaptiveIconXml()),
    writeFile(path.join(splashPath, 'themes.xml'), splashThemeXml(themes)),
    writeFile(manifestPath, setAndroidApplicationIcons(manifest)),
  ]);
  return true;
}
