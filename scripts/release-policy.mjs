// The release workflow always runs so required checks never remain pending.
export function isDocumentationOnly(files) {
  return files.length > 0 && files.every((file) =>
    file.startsWith('docs/') || /^[^/]+\.md$/i.test(file) || /^(LICENSE|COPYING|NOTICE)(\.[^/]*)?$/i.test(file));
}

export function releaseEvent(eventName, ref) {
  return ['push', 'workflow_dispatch'].includes(eventName) && ref === 'refs/heads/main';
}
