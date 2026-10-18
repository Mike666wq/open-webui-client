import test from 'node:test';
import assert from 'node:assert/strict';
import { isDocumentationOnly, releaseEvent } from './release-policy.mjs';
import { planRelease } from './release-orchestrator.mjs';

test('only documented paths are exempt; build/test/workflow/dependency edits always release', () => {
  assert.equal(isDocumentationOnly(['README.md', 'docs/setup.md', 'LICENSE']), true);
  for (const file of ['src/help.md', 'scripts/test.py', '.github/workflows/build.yml', 'package-lock.json']) {
    assert.equal(isDocumentationOnly(['README.md', file]), false);
  }
  assert.equal(isDocumentationOnly([]), false);
  assert.equal(releaseEvent('pull_request', 'refs/heads/main'), false);
  assert.equal(releaseEvent('push', 'refs/heads/main'), true);
  assert.equal(releaseEvent('workflow_dispatch', 'refs/heads/feature'), false);
});
test('coalesces waiting pushes without preparing versions, but always recovers an existing run pin', async () => {
  const opts = { eventName: 'push', ref: 'refs/heads/main', runId: '123', runNumber: 100, workspaceSha: 'a'.repeat(40), files: ['src/app.js'] };
  let marker = null;
  const adapter = { findPreparationByRunId: async () => marker, getMainHead: async () => 'b'.repeat(40), getReleaseByTag: async () => null };
  assert.deepEqual(await planRelease(adapter, opts), { release: false, reason: 'superseded' });
  assert.equal((await planRelease(adapter, { ...opts, files: ['docs/a.md'] })).reason, 'documentation-only');
  marker = { runId: '123', version: '1.0.1', tag: 'v1.0.1', commitSha: 'c'.repeat(40) };
  assert.deepEqual(await planRelease(adapter, opts), { release: true, reason: 'retry-existing-pin' });
});
