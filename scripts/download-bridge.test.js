import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const bridgeSource = readFileSync(new URL('./download-bridge.js', import.meta.url), 'utf8');
const linkBridgeSource = readFileSync(new URL('./link-bridge.js', import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
let fileSaverBundle;
try {
  fileSaverBundle = readFileSync(require.resolve('file-saver'), 'utf8');
} catch (error) {
  if (process.env.CI) throw new Error('The file-saver 2.0.5 integration test requires its exact dev dependency.', { cause: error });
}
const chunkSize = 128 * 1024;
const generation = 7;
const sessionToken = 'session-token-test-only';

function createHarness({ beginResult = { status: 'started', transferId: 'transfer-1' }, fetchImpl, failWrite = false, tauriAvailable = true } = {}) {
  const listeners = new Map();
  const invokes = [];
  const invokeWaiters = new Set();
  const externalOpenCalls = [];
  const alerts = [];
  const objectUrls = new Map();
  let objectUrlId = 0;

  class Element {
    constructor() {
      this.parentElement = null;
      this.isConnected = false;
    }

    closest(selector) {
      if (selector !== 'a[href]') return null;
      for (let node = this; node; node = node.parentElement) {
        if (node instanceof HTMLAnchorElement && node.href) return node;
      }
      return null;
    }
  }

  class HTMLAnchorElement extends Element {
    constructor(href = '') {
      super();
      this._href = href;
      this.download = '';
      this.target = '';
      this.downloadAttribute = false;
    }

    get href() {
      return new URL(this._href, window.location.href).href;
    }

    set href(value) {
      this._href = String(value);
    }

    hasAttribute(name) {
      return name === 'download' && this.downloadAttribute;
    }

    dispatchEvent(event) {
      if (!event.target) event.target = this;
      if (this.isConnected) document.dispatch(event);
      return !event.defaultPrevented;
    }

    click() {
      const event = new FakeEvent('click', this);
      if (this.isConnected) document.dispatch(event);
      return event;
    }
  }
  HTMLAnchorElement.prototype.download = '';

  class FakeEvent {
    constructor(type, target) {
      this.type = type;
      this.target = target;
      this.defaultPrevented = false;
      this.immediatePropagationStopped = false;
    }

    preventDefault() {
      this.defaultPrevented = true;
    }

    stopImmediatePropagation() {
      this.immediatePropagationStopped = true;
    }
  }

  const document = {
    addEventListener(type, listener, options) {
      const entries = listeners.get(type) ?? [];
      entries.push({ listener, capture: options === true || options?.capture === true });
      listeners.set(type, entries);
    },
    dispatch(event) {
      for (const entry of listeners.get(event.type) ?? []) {
        if (entry.capture) entry.listener(event);
        if (event.immediatePropagationStopped) break;
      }
      return event;
    },
  };

  class HarnessURL extends URL {
    static createObjectURL(blob) {
      const href = `blob:https://webui.example/${++objectUrlId}`;
      objectUrls.set(href, blob);
      return href;
    }

    static revokeObjectURL(href) {
      objectUrls.delete(href);
    }
  }

  const tauriApi = {
    core: {
      invoke: async (command, args) => {
        let settleInvocation;
        const invocation = { command, args, done: new Promise((resolve) => { settleInvocation = resolve; }) };
        invokes.push(invocation);
        for (const notify of invokeWaiters) notify();
        try {
          if (command === 'save-begin') return beginResult;
          if (command === 'save-write-chunk' && failWrite) throw new Error('simulated native write failure');
          return { status: 'ok' };
        } finally {
          settleInvocation();
        }
      },
    },
  };
  const window = {
    window: null,
    location: { href: 'https://webui.example/chat', origin: 'https://webui.example' },
    URL: HarnessURL,
    __OWC_SESSION__: { generation, token: sessionToken },
    alert: (message) => alerts.push(message),
    open: (...args) => {
      externalOpenCalls.push(args);
      return { delegated: true };
    },
  };
  window.window = window;
  if (tauriAvailable) window.__TAURI__ = tauriApi;

  const context = {
    window,
    document,
    URL: HarnessURL,
    Element,
    HTMLAnchorElement,
    Event: FakeEvent,
    Blob,
    Uint8Array,
    ArrayBuffer,
    setTimeout,
    clearTimeout,
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    fetch: fetchImpl ?? (async () => { throw new Error('unexpected fetch'); }),
    console: { warn() {} },
  };
  vm.runInNewContext(bridgeSource, context, { filename: 'download-bridge.js' });

  return {
    context,
    window,
    document,
    HTMLAnchorElement,
    FakeEvent,
    invokes,
    invokeWaiters,
    objectUrls,
    alerts,
    enableTauri() { window.__TAURI__ = tauriApi; },
    externalOpenCalls,
    makeAnchor(href, { download = '', hasDownload = false, connected = false, target = '' } = {}) {
      const anchor = new HTMLAnchorElement(href);
      anchor.download = download;
      anchor.downloadAttribute = hasDownload;
      anchor.target = target;
      anchor.isConnected = connected;
      return anchor;
    },
    click(anchor) {
      return document.dispatch(new FakeEvent('click', anchor));
    },
  };
}

async function waitForCommand(harness, command, count = 1) {
  while (harness.invokes.filter((invocation) => invocation.command === command).length < count) {
    await new Promise((resolve) => {
      const notify = () => {
        if (harness.invokes.filter((invocation) => invocation.command === command).length >= count) {
          harness.invokeWaiters.delete(notify);
          resolve();
        }
      };
      harness.invokeWaiters.add(notify);
      notify();
    });
  }
  const invocations = harness.invokes.filter((invocation) => invocation.command === command).slice(0, count);
  await Promise.all(invocations.map((invocation) => invocation.done));
}

function writeBytes(harness) {
  return Buffer.concat(harness.invokes
    .filter(({ command }) => command === 'save-write-chunk')
    .sort((left, right) => left.args.sequence - right.args.sequence)
    .map(({ args }) => Buffer.from(args.chunkBase64, 'base64')));
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('detached anchor click captures a Blob before immediate revoke and writes real ordered chunks once', async () => {
  const harness = createHarness();
  const original = Uint8Array.from({ length: 300_000 }, (_, index) => (index * 37) % 251);
  const blob = new Blob([original], { type: 'application/octet-stream' });
  const href = harness.window.URL.createObjectURL(blob);
  const anchor = harness.makeAnchor(href, { download: 'export.bin', hasDownload: true });

  anchor.click();
  harness.window.URL.revokeObjectURL(href);
  await waitForCommand(harness, 'save-finish');

  const writes = harness.invokes.filter(({ command }) => command === 'save-write-chunk');
  assert.deepEqual(writes.map(({ args }) => args.sequence), [0, 1, 2]);
  assert.deepEqual(writes.map(({ args }) => Buffer.from(args.chunkBase64, 'base64').length), [chunkSize, chunkSize, 37_856]);
  assert.equal(digest(writeBytes(harness)), digest(Buffer.from(original)));
  assert.equal(harness.invokes.filter(({ command }) => command === 'save-begin').length, 1);
  assert.equal(harness.invokes.at(-1).command, 'save-finish');
  const begin = harness.invokes[0];
  assert.equal(begin.command, 'save-begin');
  assert.equal(begin.args.filename, 'export.bin');
  assert.equal(begin.args.mimeType, 'application/octet-stream');
  assert.equal(begin.args.expectedBytes, blob.size);
  assert.equal(begin.args.generation, generation);
  assert.equal(begin.args.sessionToken, sessionToken);
  assert.equal(harness.objectUrls.has(href), false);
});

test('document-start shim prompts before Tauri exists and accepts a later retry without queueing', async () => {
  const harness = createHarness({ tauriAvailable: false });
  const href = harness.window.URL.createObjectURL(new Blob(['retry after ready']));
  const anchor = harness.makeAnchor(href, { download: 'retry.txt', hasDownload: true });

  anchor.click();
  assert.equal(harness.invokes.length, 0);
  assert.equal(harness.alerts.length, 1);
  assert.match(harness.alerts[0], /try again/i);

  harness.enableTauri();
  anchor.click();
  await waitForCommand(harness, 'save-finish');
  assert.equal(harness.invokes.filter(({ command }) => command === 'save-begin').length, 1);
  assert.equal(digest(writeBytes(harness)), digest(Buffer.from('retry after ready')));
});

test('explicit dispatchEvent download is handled once and a cancelled picker sends no chunks', async () => {
  const harness = createHarness({ beginResult: { status: 'cancelled' } });
  const blob = new Blob(['picker cancelled'], { type: 'text/plain' });
  const href = harness.window.URL.createObjectURL(blob);
  const anchor = harness.makeAnchor(href, { download: 'cancel.txt', hasDownload: true, connected: true });
  const event = new harness.FakeEvent('click', anchor);

  anchor.dispatchEvent(event);
  await waitForCommand(harness, 'save-begin');

  assert.equal(event.defaultPrevented, true);
  assert.equal(harness.invokes.filter(({ command }) => command === 'save-begin').length, 1);
  assert.equal(harness.invokes.some(({ command }) => command === 'save-write-chunk' || command === 'save-finish' || command === 'save-cancel'), false);
});

test('a tracked Blob preview without an explicit download attribute stays a normal WebView link', () => {
  const harness = createHarness();
  const href = harness.window.URL.createObjectURL(new Blob(['preview content'], { type: 'text/plain' }));
  const preview = harness.makeAnchor(href, { connected: true, target: '_blank' });
  const event = harness.click(preview);

  assert.equal(event.defaultPrevented, false);
  assert.equal(harness.invokes.length, 0);
  assert.equal(harness.objectUrls.has(href), true);
});

test('connected anchor.click uses the document listener and a native write failure cancels its partial transfer', async () => {
  const harness = createHarness({ failWrite: true });
  const href = harness.window.URL.createObjectURL(new Blob(['partial bytes']));
  const anchor = harness.makeAnchor(href, { download: 'partial.bin', hasDownload: true, connected: true });

  anchor.click();
  await waitForCommand(harness, 'save-cancel');

  assert.equal(harness.invokes.filter(({ command }) => command === 'save-begin').length, 1);
  assert.equal(harness.invokes.filter(({ command }) => command === 'save-write-chunk').length, 1);
  assert.equal(harness.invokes.at(-1).command, 'save-cancel');
  assert.equal(harness.invokes.at(-1).args.transferId, 'transfer-1');
  assert.equal(harness.invokes.some(({ command }) => command === 'save-finish'), false);
});

test('same-origin file download streams decoded bytes with guarded same-origin fetch and no guessed length', async () => {
  const original = Buffer.from('first-stream-part:second-stream-part');
  const chunks = [original.subarray(0, 9), original.subarray(9)];
  const fetchCalls = [];
  const harness = createHarness({
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      let index = 0;
      return {
        ok: true,
        status: 200,
        url,
      headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'text/plain; charset=utf-8' : null },
        body: { getReader: () => ({ read: async () => index < chunks.length ? { done: false, value: chunks[index++] } : { done: true } }) },
      };
    },
  });
  const anchor = harness.makeAnchor('/api/v1/files/file_123/content', { connected: true });
  const event = harness.click(anchor);
  await waitForCommand(harness, 'save-finish');

  assert.equal(event.defaultPrevented, true);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].options.credentials, 'same-origin');
  assert.equal(fetchCalls[0].options.redirect, 'error');
  assert.equal(fetchCalls[0].options.cache, 'no-store');
  assert.equal(new URL(fetchCalls[0].url).origin, harness.window.location.origin);
  assert.equal(digest(writeBytes(harness)), digest(original));
  assert.equal(harness.invokes[0].args.filename, 'file_123');
  assert.equal(harness.invokes[0].args.mimeType, 'text/plain');
  assert.equal('expectedBytes' in harness.invokes[0].args, false);
  assert.equal(harness.invokes.at(-1).command, 'save-finish');
});

test('cross-origin downloads and ordinary links stay outside the native save bridge', async () => {
  const fetchCalls = [];
  const harness = createHarness({ fetchImpl: async (...args) => { fetchCalls.push(args); throw new Error('should not fetch'); } });
  const external = harness.makeAnchor('https://files.example.net/api/v1/files/secret/content', {
    download: 'secret.bin', hasDownload: true, connected: true,
  });
  const ordinary = harness.makeAnchor('/chat/42', { connected: true });

  const externalEvent = harness.click(external);
  const ordinaryEvent = harness.click(ordinary);
  assert.equal(externalEvent.defaultPrevented, false);
  assert.equal(ordinaryEvent.defaultPrevented, false);
  assert.equal(fetchCalls.length, 0);
  assert.equal(harness.invokes.length, 0);
  assert.equal(harness.window.__OWC_DOWNLOAD_BRIDGE__.open('https://files.example.net/api/v1/files/id/content'), false);
  assert.equal(harness.window.__OWC_DOWNLOAD_BRIDGE__.open('/chat/42'), false);
  assert.equal(harness.externalOpenCalls.length, 0);
});

test('window.open saves explicit file routes, previews Blob URLs, and preserves internal/external routing', async () => {
  const harness = createHarness({
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      url,
      headers: { get: () => 'text/plain' },
      body: { getReader: () => ({ read: async () => ({ done: true }) }) },
    }),
  });
  const blobUrl = harness.window.URL.createObjectURL(new Blob(['window.open blob']));
  vm.runInNewContext(linkBridgeSource, harness.context, { filename: 'link-bridge.js' });

  const blobAnchor = harness.makeAnchor(blobUrl, { connected: true, target: '_blank' });
  const blobAnchorEvent = harness.click(blobAnchor);
  assert.equal(blobAnchorEvent.defaultPrevented, true);
  assert.equal(harness.window.location.href, blobUrl);
  assert.equal(harness.invokes.length, 0);

  harness.window.location.href = 'https://webui.example/chat';
  assert.equal(harness.window.open(blobUrl), null);
  assert.equal(harness.window.location.href, blobUrl);
  assert.equal(harness.invokes.length, 0);
  assert.equal(harness.invokes.some(({ command }) => command === 'open-external'), false);

  harness.window.location.href = 'https://webui.example/chat';
  assert.equal(harness.window.open('/api/v1/files/file_123/content'), null);
  await waitForCommand(harness, 'save-finish');
  assert.equal(harness.invokes.filter(({ command }) => command === 'save-begin').length, 1);
  assert.equal(harness.invokes.filter(({ command }) => command === 'save-finish').length, 1);
  assert.equal(harness.invokes.some(({ command }) => command === 'open-external'), false);

  assert.equal(harness.window.open('/chat/42'), null);
  assert.equal(harness.window.location.href, 'https://webui.example/chat/42');
  const internalBlank = harness.makeAnchor('/docs/help', { connected: true, target: '_blank' });
  const internalBlankEvent = harness.click(internalBlank);
  assert.equal(internalBlankEvent.defaultPrevented, true);
  assert.equal(harness.window.location.href, 'https://webui.example/docs/help');

  const externalBlank = harness.makeAnchor('https://files.example.net/download.bin', { connected: true, target: '_blank' });
  const externalBlankEvent = harness.click(externalBlank);
  assert.equal(externalBlankEvent.defaultPrevented, true);
  assert.equal(harness.window.open('https://files.example.net/download.bin'), null);
  await waitForCommand(harness, 'open-external', 2);
  const delegated = harness.invokes.filter(({ command }) => command === 'open-external');
  assert.equal(delegated.length, 2);
  assert.equal(delegated[0].args.url, 'https://files.example.net/download.bin');
  assert.equal(delegated[1].args.url, 'https://files.example.net/download.bin');
  assert.equal(harness.invokes.filter(({ command }) => command === 'save-begin').length, 1);
});

test('file-saver 2.0.5 captures the preload shim before its Mac WebKit FileReader fallback', {
  skip: !fileSaverBundle ? 'file-saver 2.0.5 dev dependency is not installed locally' : false,
}, async () => {
  const harness = createHarness();
  const blob = new Blob(['macOS WebKit export'], { type: 'text/plain; charset=utf-8' });
  let readerCalls = 0;
  harness.context.navigator = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/605.1.15' };
  harness.context.FileReader = class {
    readAsDataURL() { readerCalls += 1; }
  };
  const preloadShim = harness.window.saveAs;
  vm.runInNewContext(fileSaverBundle, harness.context, { filename: 'file-saver-2.0.5.min.js' });
  assert.equal(harness.window.saveAs, preloadShim);
  harness.window.saveAs(blob, 'mac-export.txt');
  await waitForCommand(harness, 'save-finish');

  assert.equal(readerCalls, 0);
  assert.equal(harness.externalOpenCalls.length, 0);
  assert.equal(harness.invokes[0].args.filename, 'mac-export.txt');
  assert.equal(harness.invokes[0].args.mimeType, 'text/plain');
  assert.equal(digest(writeBytes(harness)), digest(Buffer.from('macOS WebKit export')));
});


test('legacy Android Blob chunks use FileReader when arrayBuffer is absent', { timeout: 5000 }, async () => {
  const harness = createHarness();
  const original = 'legacy WebView payload';
  const blob = new Blob([original], { type: 'text/plain' });
  const slice = blob.slice.bind(blob);
  blob.slice = (...args) => {
    const part = slice(...args);
    Object.defineProperty(part, 'arrayBuffer', { value: undefined });
    return part;
  };
  harness.context.FileReader = class {
    readAsArrayBuffer(part) {
      Blob.prototype.arrayBuffer.call(part).then((value) => { this.result = value; this.onload(); }, () => this.onerror());
    }
  };
  const href = harness.window.URL.createObjectURL(blob);
  harness.makeAnchor(href, { download: 'legacy.txt', hasDownload: true }).click();
  await waitForCommand(harness, 'save-finish');
  assert.equal(writeBytes(harness).toString(), original);
  assert.equal(harness.alerts.length, 0);
});
