import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const V0_2_2_SOURCE_SHA = '3edd2b1191f5f7bbd56cf2d35dd401bb61489f10';

const behaviorPaths = [
  /^src\//,
  /^index\.html$/,
  /^package(?:-lock)?\.json$/,
  /^vite\.config\.js$/,
  /^client\.config\.json$/,
  /^src-tauri\//,
  /^scripts\/(?:prepare-android|generate-client-config|download-bridge|link-bridge)\.(?:mjs|js)$/,
];

export function selectAndroidSmokeSource({ eventName, requestedSource = 'baseline', changedPaths = [] }) {
  if (eventName === 'workflow_dispatch') {
    if (requestedSource === 'baseline') return V0_2_2_SOURCE_SHA;
    if (requestedSource === 'current') return 'current';
    throw new Error(`Unsupported Android smoke source: ${requestedSource}`);
  }
  if (eventName !== 'push') throw new Error(`Unsupported Android smoke event: ${eventName}`);

  const hasBehaviorChange = changedPaths.some((file) => {
    const normalized = file.replaceAll('\\', '/').replace(/^\.\//, '');
    return behaviorPaths.some((pattern) => pattern.test(normalized));
  });
  return hasBehaviorChange ? 'current' : V0_2_2_SOURCE_SHA;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const changedPaths = JSON.parse(process.env.ANDROID_SMOKE_CHANGED_PATHS ?? '[]');
  const source = selectAndroidSmokeSource({
    eventName: process.env.GITHUB_EVENT_NAME,
    requestedSource: process.env.ANDROID_SMOKE_SOURCE ?? 'baseline',
    changedPaths,
  });
  console.log(`source=${source}`);
}
