import test from 'node:test';
import assert from 'node:assert/strict';
import { validateServiceUrl, classifyNavigation } from './trust.js';
import { transition } from './connection-state.js';

const service = validateServiceUrl('https://chat.example.org:8443');
const localOrigins = new Set(['tauri://localhost', 'http://tauri.localhost']);

test('service URL accepts HTTP and HTTPS origins with hosts, IPs, and ports', () => {
  assert.equal(service.origin, 'https://chat.example.org:8443');
  assert.equal(validateServiceUrl('http://192.168.31.60:3000').origin, 'http://192.168.31.60:3000');
  assert.equal(validateServiceUrl('https://chat.example.org:8443/').origin, 'https://chat.example.org:8443');
  for (const value of [
    'http://user:pass@chat.example.org:3000',
    'http:///path',
    'http:/chat.example.org',
    'http:\\\\chat.example.org',
    'http://\\chat.example.org',
    'http://chat.example.org\\path',
    'http://chat.example.org:3000/path',
    'https://chat.example.org:3000/?q=1',
    'http://tauri.localhost/',
    'tauri://localhost/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'ftp://example.org',
  ]) {
    assert.throws(() => validateServiceUrl(value));
  }
  assert.equal(validateServiceUrl('http://localhost:3000').origin, 'http://localhost:3000');
});

test('navigation keeps the service and known app origins, opens safe web links externally', () => {
  assert.equal(classifyNavigation('https://chat.example.org:8443/chat', service, localOrigins), 'allow-app');
  assert.equal(classifyNavigation('tauri://localhost/index.html', service, localOrigins), 'allow-app');
  assert.equal(classifyNavigation('https://example.org/login', service, localOrigins), 'open-external');
  assert.equal(classifyNavigation('javascript:alert(1)', service, localOrigins), 'deny');
  assert.equal(classifyNavigation('https://user:pass@example.org', service, localOrigins), 'deny');
  assert.equal(classifyNavigation('http://localhost:3000', service, localOrigins), 'open-external');
});

test('connection settings expose connecting and failure retry transitions', () => {
  assert.equal(transition('settings', { type: 'connect' }), 'connecting');
  assert.equal(transition('connecting', { type: 'ready' }), 'connected');
  assert.equal(transition('connecting', { type: 'failed' }), 'failed');
  assert.equal(transition('failed', { type: 'connect' }), 'connecting');
  assert.equal(transition('connected', { type: 'failed' }), 'connected');
});
