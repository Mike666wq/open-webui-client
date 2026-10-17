import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const V0_2_2_SOURCE_SHA = '3edd2b1191f5f7bbd56cf2d35dd401bb61489f10';

const behaviorPaths = [
  /^src\//,
  /^public\//,
  /^index\.html$/,
  /^package(?:-lock)?\.json$/,
  /^vite\.config\.js$/,
  /^client\.config\.json$/,
  /^src-tauri\//,
  /^scripts\/(?:prepare-android|generate-client-config|generate-android-bridges|prepare-assets|android-icons|download-bridge|link-bridge)\.(?:mjs|js)$/,
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

export function resolveAndroidSmokeSource({
  eventName, pinnedSourceSha = '', sourceLabel = '', currentSha,
  requestedSource = 'baseline', changedPaths = [],
}) {
  // Reusable workflows inherit the caller's event_name (e.g. workflow_dispatch).
  // Explicit immutable inputs must take precedence over that inherited event.
  if (pinnedSourceSha || sourceLabel || eventName === 'workflow_call') {
    if (!/^[0-9a-f]{40}$/.test(pinnedSourceSha)) {
      throw new Error('Pinned Android smoke source requires a 40-character immutable commit SHA');
    }
    if (!/^[a-z0-9-]{1,40}$/.test(sourceLabel)) {
      throw new Error('Pinned Android smoke source label is invalid');
    }
    return { sourceSha: pinnedSourceSha, sourceKind: sourceLabel };
  }
  const selected = selectAndroidSmokeSource({ eventName, requestedSource, changedPaths });
  if (selected === 'current') {
    if (!/^[0-9a-f]{40}$/.test(currentSha ?? '')) {
      throw new Error('Current Android smoke source requires a 40-character commit SHA');
    }
    return { sourceSha: currentSha, sourceKind: 'current' };
  }
  return { sourceSha: selected, sourceKind: 'v0.2.2-baseline' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = resolveAndroidSmokeSource({
    eventName: process.env.GITHUB_EVENT_NAME,
    requestedSource: process.env.ANDROID_SMOKE_REQUESTED_SOURCE ?? 'baseline',
    pinnedSourceSha: process.env.ANDROID_SMOKE_PINNED_SOURCE_SHA ?? '',
    sourceLabel: process.env.ANDROID_SMOKE_SOURCE_LABEL ?? '',
    currentSha: process.env.ANDROID_SMOKE_SHA,
    changedPaths: JSON.parse(process.env.ANDROID_SMOKE_CHANGED_PATHS ?? '[]'),
  });
  console.log(`source_sha=${result.sourceSha}`);
  console.log(`source_kind=${result.sourceKind}`);
}
