import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const APP_NAME = 'open-webui-client';
const APP_IDENTIFIER = 'local.openwebui.client';
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_ANDROID_VERSION_CODE = 2_100_000_000;
const ANDROID_VERSION_CODE_BASE = 1_000;

const VERSION_FILES = [
  'package.json',
  'package-lock.json',
  path.join('src-tauri', 'tauri.conf.json'),
  path.join('src-tauri', 'Cargo.toml'),
  path.join('src-tauri', 'Cargo.lock'),
];

export function isStableSemver(value) {
  return typeof value === 'string' && VERSION_PATTERN.test(value);
}

function parseVersion(value, label) {
  if (!isStableSemver(value)) {
    throw new Error(`${label} must be a stable semantic version in X.Y.Z form`);
  }
  return value.split('.').map(BigInt);
}

function compareVersions(left, right) {
  const a = parseVersion(left, 'Version');
  const b = parseVersion(right, 'Version');
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] < b[index]) return -1;
    if (a[index] > b[index]) return 1;
  }
  return 0;
}

function bumpedVersion(current, part) {
  const [major, minor, patch] = parseVersion(current, 'Current version');
  if (part === 'major') return `${major + 1n}.0.0`;
  if (part === 'minor') return `${major}.${minor + 1n}.0`;
  if (part === 'patch') return `${major}.${minor}.${patch + 1n}`;
  if (isStableSemver(part)) return part;
  throw new Error('Bump target must be major, minor, patch, or a stable X.Y.Z version');
}

export function versionCodeFromRunNumber(runNumber) {
  if (!Number.isSafeInteger(runNumber) || runNumber < 1) {
    throw new Error('GitHub run number must be a positive safe integer');
  }
  const versionCode = ANDROID_VERSION_CODE_BASE + runNumber;
  if (versionCode > MAX_ANDROID_VERSION_CODE) {
    throw new Error(`Android version code must not exceed ${MAX_ANDROID_VERSION_CODE}`);
  }
  return versionCode;
}

function parseJsonFile(contents, label) {
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function readCargoPackageVersion(contents) {
  const lines = contents.split(/\r?\n/);
  let inPackage = false;
  let name;
  let version;
  let packageSections = 0;
  for (const line of lines) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) {
      inPackage = section[1] === 'package';
      if (inPackage) packageSections += 1;
      continue;
    }
    if (!inPackage) continue;
    const nameField = line.match(/^\s*name\s*=\s*"([^"]+)"\s*$/);
    const versionField = line.match(/^\s*version\s*=\s*"([^"]+)"\s*$/);
    if (nameField) name = nameField[1];
    if (versionField) version = versionField[1];
  }
  if (packageSections !== 1 || name !== APP_NAME || !version) {
    throw new Error('src-tauri/Cargo.toml must contain one app [package] name/version');
  }
  return version;
}

function readCargoLockPackageVersion(contents) {
  const sections = contents.split(/^\[\[package\]\]\s*$/m).slice(1);
  const appPackages = sections.filter((section) => /^name\s*=\s*"open-webui-client"\s*$/m.test(section));
  if (appPackages.length !== 1) {
    throw new Error('src-tauri/Cargo.lock must contain exactly one open-webui-client package');
  }
  const version = appPackages[0].match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  if (!version) throw new Error('The app package in src-tauri/Cargo.lock has no version');
  return version;
}

function validateVersionFiles(contentsByPath) {
  const packageJson = parseJsonFile(contentsByPath.get('package.json'), 'package.json');
  const packageLock = parseJsonFile(contentsByPath.get('package-lock.json'), 'package-lock.json');
  const tauriConfig = parseJsonFile(contentsByPath.get(path.join('src-tauri', 'tauri.conf.json')), 'src-tauri/tauri.conf.json');
  if (packageJson.name !== APP_NAME) throw new Error(`package.json name must be ${APP_NAME}`);
  if (packageLock.name !== APP_NAME || packageLock.packages?.['']?.name !== APP_NAME) {
    throw new Error('package-lock.json root package names do not match the app');
  }
  if (tauriConfig.identifier !== APP_IDENTIFIER) {
    throw new Error(`Tauri identifier must remain ${APP_IDENTIFIER}`);
  }

  const versions = {
    'package.json': packageJson.version,
    'package-lock.json root': packageLock.version,
    'package-lock.json packages[""]': packageLock.packages[''].version,
    'src-tauri/tauri.conf.json': tauriConfig.version,
    'src-tauri/Cargo.toml': readCargoPackageVersion(contentsByPath.get(path.join('src-tauri', 'Cargo.toml'))),
    'src-tauri/Cargo.lock': readCargoLockPackageVersion(contentsByPath.get(path.join('src-tauri', 'Cargo.lock'))),
  };
  for (const [label, version] of Object.entries(versions)) parseVersion(version, label);
  const uniqueVersions = new Set(Object.values(versions));
  if (uniqueVersions.size !== 1) {
    throw new Error(`App versions disagree: ${Object.entries(versions).map(([key, value]) => `${key}=${value}`).join(', ')}`);
  }
  return Object.values(versions)[0];
}

async function readVersionFiles(root) {
  const entries = await Promise.all(VERSION_FILES.map(async (relativePath) => [
    relativePath,
    await readFile(path.join(root, relativePath), 'utf8'),
  ]));
  return new Map(entries);
}

function updateVersionFiles(contentsByPath, version) {
  const updated = new Map(contentsByPath);
  const packageJson = parseJsonFile(updated.get('package.json'), 'package.json');
  packageJson.version = version;
  updated.set('package.json', `${JSON.stringify(packageJson, null, 2)}\n`);

  const packageLock = parseJsonFile(updated.get('package-lock.json'), 'package-lock.json');
  packageLock.version = version;
  packageLock.packages[''].version = version;
  updated.set('package-lock.json', `${JSON.stringify(packageLock, null, 2)}\n`);

  const tauriPath = path.join('src-tauri', 'tauri.conf.json');
  const tauriConfig = parseJsonFile(updated.get(tauriPath), 'src-tauri/tauri.conf.json');
  tauriConfig.version = version;
  updated.set(tauriPath, `${JSON.stringify(tauriConfig, null, 2)}\n`);

  const cargoTomlPath = path.join('src-tauri', 'Cargo.toml');
  const cargoLines = updated.get(cargoTomlPath).split(/(\r?\n)/);
  let inPackage = false;
  let updatedTomlVersion = false;
  for (let index = 0; index < cargoLines.length; index += 1) {
    if (/^\s*\[([^\]]+)\]\s*$/.test(cargoLines[index])) {
      inPackage = cargoLines[index].match(/^\s*\[([^\]]+)\]\s*$/)[1] === 'package';
    } else if (inPackage && /^\s*version\s*=\s*"[^"]+"\s*$/.test(cargoLines[index])) {
      cargoLines[index] = cargoLines[index].replace(/"[^"]+"/, `"${version}"`);
      updatedTomlVersion = true;
      break;
    }
  }
  if (!updatedTomlVersion) throw new Error('Could not update the app version in src-tauri/Cargo.toml');
  updated.set(cargoTomlPath, cargoLines.join(''));

  const cargoLockPath = path.join('src-tauri', 'Cargo.lock');
  const cargoLock = updated.get(cargoLockPath);
  const appPackagePattern = /(\[\[package\]\]\r?\nname = "open-webui-client"\r?\nversion = ")[^"]+("\r?\n)/g;
  const matches = [...cargoLock.matchAll(appPackagePattern)];
  if (matches.length !== 1) throw new Error('Could not identify one app package version in src-tauri/Cargo.lock');
  updated.set(cargoLockPath, cargoLock.replace(appPackagePattern, `$1${version}$2`));

  // Validate all candidate contents before any filesystem writes occur.
  if (validateVersionFiles(updated) !== version) throw new Error('Updated app version files failed validation');
  return updated;
}

export async function checkVersions(root = projectRoot) {
  const contents = await readVersionFiles(root);
  return validateVersionFiles(contents);
}

export async function bumpVersions(target, root = projectRoot) {
  const contents = await readVersionFiles(root);
  const current = validateVersionFiles(contents);
  const next = bumpedVersion(current, target);
  if (compareVersions(next, current) <= 0) {
    throw new Error(`New version ${next} must be greater than ${current}`);
  }
  const updated = updateVersionFiles(contents, next);
  // All files and candidate outputs have been validated before the first write.
  await Promise.all(VERSION_FILES.map((relativePath) =>
    writeFile(path.join(root, relativePath), updated.get(relativePath), 'utf8')));
  return { previous: current, current: next };
}

async function main(args) {
  if (args.length === 1 && args[0] === 'check') {
    const version = await checkVersions();
    process.stdout.write(`App version ${version} is synchronized across all release metadata.\n`);
    return;
  }
  if (args.length === 2 && args[0] === 'bump') {
    const result = await bumpVersions(args[1]);
    process.stdout.write(`Updated app version ${result.previous} -> ${result.current}.\n`);
    return;
  }
  throw new Error('Usage: node scripts/manage-version.mjs check | bump <major|minor|patch|X.Y.Z>');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
