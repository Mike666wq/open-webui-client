import test from 'node:test';
import assert from 'node:assert/strict';
import { validateServiceUrl, classifyNavigation } from './trust.js';
import { transition } from './connection-state.js';

const service = validateServiceUrl('http://mint:3000');
const localOrigins = new Set(['tauri://localhost', 'http://tauri.localhost']);

test('service URL accepts only an origin without credentials or extra path', () => {
  assert.equal(service.origin, 'http://mint:3000');
  for (const value of [
    'https://mint:3000',
    'http://user:pass@mint:3000',
    'http://mint:3000/path',
    'file:///etc/passwd',
  ]) {
    assert.throws(() => validateServiceUrl(value));
  }
});

test('navigation keeps the service and known app origins, opens safe web links externally', () => {
  assert.equal(classifyNavigation('http://mint:3000/chat', service, localOrigins), 'allow-app');
  assert.equal(classifyNavigation('tauri://localhost/index.html', service, localOrigins), 'allow-app');
  assert.equal(classifyNavigation('https://example.org/login', service, localOrigins), 'open-external');
  assert.equal(classifyNavigation('javascript:alert(1)', service, localOrigins), 'deny');
  assert.equal(classifyNavigation('https://user:pass@example.org', service, localOrigins), 'deny');
  assert.equal(classifyNavigation('http://localhost:3000', service, localOrigins), 'open-external');
});

test('connection state exposes retry, checking, opening, and unavailable transitions', () => {
  assert.equal(transition('idle', { type: 'retry' }), 'checking');
  assert.equal(transition('checking', { type: 'available' }), 'opening');
  assert.equal(transition('checking', { type: 'unavailable' }), 'unavailable');
  assert.equal(transition('opening', { type: 'unavailable' }), 'opening');
});
