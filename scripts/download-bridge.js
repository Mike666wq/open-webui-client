(() => {
  if (window.top !== window.self) return;
  if (window.__OWC_DOWNLOAD_BRIDGE__?.version === 1) return;

  const CHUNK_BYTES = 128 * 1024;
  const MAX_BYTES = 2 * 1024 * 1024 * 1024;
  const objectUrls = new Map();
  const handledEvents = new WeakSet();
  const suppressAnchorDispatch = new WeakSet();
  const originalCreateObjectURL = URL.createObjectURL?.bind(URL);
  const originalRevokeObjectURL = URL.revokeObjectURL?.bind(URL);

  const invoke = (command, args) => {
    const core = window.__TAURI__?.core;
    if (typeof core?.invoke !== 'function') return Promise.reject(new Error('The native bridge is not ready.'));
    return core.invoke(command, args);
  };

  const currentSession = () => {
    const session = window.__OWC_SESSION__;
    if (
      typeof window.__TAURI__?.core?.invoke !== 'function' ||
      !session ||
      !Number.isSafeInteger(session.generation) ||
      typeof session.token !== 'string' ||
      session.token.length === 0
    ) return null;
    return { generation: session.generation, sessionToken: session.token };
  };

  const sameSession = (session) => {
    const current = currentSession();
    return current?.generation === session.generation && current.sessionToken === session.sessionToken;
  };

  const notifyRetry = () => {
    const message = 'Downloads are not ready yet. Please try again in a moment.';
    try {
      if (typeof window.alert === 'function') window.alert(message);
      else console.warn(message);
    } catch {
      console.warn(message);
    }
  };

  const notifyFailure = () => {
    const message = 'The download could not be saved. Please try again.';
    try {
      if (typeof window.alert === 'function') window.alert(message);
      else console.warn(message);
    } catch {
      console.warn(message);
    }
  };

  const safeFilename = (value) => {
    const filename = String(value || 'download')
      .split(/[\\/]/)
      .pop()
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 255);
    return filename || 'download';
  };

  const safeMimeType = (value) => {
    const mimeType = String(value || '').split(';', 1)[0].trim();
    const [kind, subtype, extra] = mimeType.split('/');
    const validToken = (part) => part && part.length <= 127 && /^[A-Za-z0-9!#$&^_.+-]+$/.test(part);
    if (!extra && validToken(kind) && validToken(subtype)) return `${kind}/${subtype}`.toLowerCase();
    return 'application/octet-stream';
  };

  const contentDispositionFilename = (header) => {
    if (!header) return '';
    const encoded = /(?:^|;)\s*filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
    if (encoded) {
      try {
        return decodeURIComponent(encoded[1].trim().replace(/^"|"$/g, ''));
      } catch {}
    }
    const plain = /(?:^|;)\s*filename\s*=\s*(?:"((?:\\.|[^"])*)"|([^;]*))/i.exec(header);
    return plain ? (plain[1] ?? plain[2] ?? '').replace(/\\([\\"])/g, '$1').trim() : '';
  };

  const urlFrom = (value) => {
    try {
      return new URL(String(value), window.location.href);
    } catch {
      return null;
    }
  };

  const fileIdFrom = (url) => {
    if (url.origin !== window.location.origin || url.username || url.password || url.search) return null;
    const match = /^\/api\/v1\/files\/([A-Za-z0-9_-]+)\/content$/.exec(url.pathname);
    return match?.[1] ?? null;
  };

  const toBase64 = (bytes) => {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      const end = Math.min(offset + 0x8000, bytes.length);
      for (let index = offset; index < end; index += 1) binary += String.fromCharCode(bytes[index]);
    }
    return btoa(binary);
  };

  const runTransfer = async ({ session, filename, mimeType, expectedBytes, produce }) => {
    let transferId;
    try {
      if (!sameSession(session)) return false;
      const beginArgs = { filename: safeFilename(filename), mimeType: mimeType || 'application/octet-stream', ...session };
      if (Number.isSafeInteger(expectedBytes)) beginArgs.expectedBytes = expectedBytes;
      const result = await invoke('save-begin', beginArgs);
      if (result?.status === 'cancelled') return true;
      if (result?.status !== 'started' || typeof result.transferId !== 'string' || result.transferId.length === 0) {
        throw new Error('The native save dialog returned an invalid transfer.');
      }
      transferId = result.transferId;

      let sequence = 0;
      let totalBytes = 0;
      const write = async (bytes) => {
        if (!sameSession(session)) throw new Error('The connection session expired.');
        totalBytes += bytes.byteLength;
        if (totalBytes > MAX_BYTES || (Number.isSafeInteger(expectedBytes) && totalBytes > expectedBytes)) {
          throw new Error('The download is larger than allowed.');
        }
        await invoke('save-write-chunk', {
          transferId,
          sequence,
          chunkBase64: toBase64(bytes),
          ...session,
        });
        sequence += 1;
      };

      await produce(write);
      if (Number.isSafeInteger(expectedBytes) && totalBytes !== expectedBytes) {
        throw new Error('The downloaded size did not match the expected size.');
      }
      if (!sameSession(session)) throw new Error('The connection session expired.');
      await invoke('save-finish', { transferId, ...session });
      return true;
    } catch (error) {
      if (transferId) {
        try {
          await invoke('save-cancel', { transferId, ...session });
        } catch {}
      }
      console.warn('Download bridge failed to save a file.', error);
      notifyFailure();
      return false;
    }
  };

  const saveBlob = (blob, filename) => {
    if (!(blob instanceof Blob) || typeof blob.slice !== 'function') return false;
    if (blob.size > MAX_BYTES) {
      notifyFailure();
      return true;
    }
    const session = currentSession();
    if (!session) {
      notifyRetry();
      return true;
    }

    void runTransfer({
      session,
      filename: filename || blob.name || 'download',
      mimeType: safeMimeType(blob.type),
      expectedBytes: blob.size,
      produce: async (write) => {
        for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
          const part = blob.slice(offset, Math.min(offset + CHUNK_BYTES, blob.size));
          const bytes = typeof part.arrayBuffer === 'function' ? await part.arrayBuffer()
            : await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = () => reject(new Error('Could not read the file chunk.'));
              reader.readAsArrayBuffer(part);
            });
          await write(new Uint8Array(bytes));
        }
      },
    });
    return true;
  };

  const streamResponse = async (reader, write) => {
    let buffer = new Uint8Array(CHUNK_BYTES);
    let used = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
        let offset = 0;
        while (offset < bytes.length) {
          const count = Math.min(CHUNK_BYTES - used, bytes.length - offset);
          buffer.set(bytes.subarray(offset, offset + count), used);
          used += count;
          offset += count;
          if (used === CHUNK_BYTES) {
            await write(buffer);
            buffer = new Uint8Array(CHUNK_BYTES);
            used = 0;
          }
        }
      }
      if (used > 0) await write(buffer.subarray(0, used));
    } finally {
      try { reader.releaseLock?.(); } catch {}
    }
  };

  const saveUrl = async (url, filenameHint) => {
    const session = currentSession();
    if (!session) {
      notifyRetry();
      return false;
    }
    if (typeof fetch !== 'function') {
      notifyFailure();
      return false;
    }

    try {
      const response = await fetch(url.href, {
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
      });
      if (!response.ok || response.redirected) throw new Error('The file request failed.');
      const finalUrl = urlFrom(response.url || url.href);
      if (!finalUrl || finalUrl.origin !== window.location.origin || finalUrl.username || finalUrl.password) {
        throw new Error('The file request left the current service.');
      }
      const fileId = fileIdFrom(finalUrl);
      if (!fileId && !filenameHint) throw new Error('The file URL is not permitted.');
      const dispositionName = contentDispositionFilename(response.headers?.get?.('content-disposition'));
      const filename = filenameHint || dispositionName || fileId || 'download';
      const mimeType = safeMimeType(response.headers?.get?.('content-type'));
      if (!response.body?.getReader) throw new Error('The file response cannot be streamed.');

      return runTransfer({
        session,
        filename,
        mimeType,
        produce: (write) => streamResponse(response.body.getReader(), write),
      });
    } catch (error) {
      console.warn('Download bridge could not fetch a file.', error);
      notifyFailure();
      return false;
    }
  };

  const describeAnchorDownload = (anchor) => {
    const url = urlFrom(anchor.href);
    if (!url) return null;
    const blob = objectUrls.get(url.href);
    if (blob instanceof Blob && anchor.hasAttribute('download')) {
      return { kind: 'blob', blob, filename: anchor.download };
    }

    const fileId = fileIdFrom(url);
    if (fileId) return { kind: 'url', url, filename: anchor.download || fileId };

    if (url.origin !== window.location.origin || url.username || url.password || !anchor.hasAttribute('download')) return null;
    let filename = anchor.download;
    if (!filename) {
      try { filename = decodeURIComponent(url.pathname.split('/').pop() || 'download'); } catch { filename = 'download'; }
    }
    return { kind: 'url', url, filename };
  };

  const startAnchorDownload = (anchor, event) => {
    const download = describeAnchorDownload(anchor);
    if (!download) return false;
    if (event) {
      handledEvents.add(event);
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    if (download.kind === 'blob') saveBlob(download.blob, download.filename);
    else void saveUrl(download.url, download.filename);
    return true;
  };

  const originalCreate = originalCreateObjectURL;
  if (originalCreate) {
    URL.createObjectURL = (blob) => {
      const href = originalCreate(blob);
      if (blob instanceof Blob) objectUrls.set(href, blob);
      return href;
    };
  }
  if (originalRevokeObjectURL) {
    URL.revokeObjectURL = (href) => {
      objectUrls.delete(String(href));
      return originalRevokeObjectURL(href);
    };
  }

  document.addEventListener('click', (event) => {
    if (handledEvents.has(event)) return;
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (anchor) startAnchorDownload(anchor, event);
  }, true);

  if (typeof HTMLAnchorElement !== 'undefined') {
    const prototype = HTMLAnchorElement.prototype;
    const originalClick = prototype.click;
    const originalDispatchEvent = prototype.dispatchEvent;

    if (typeof originalClick === 'function') {
      prototype.click = function (...args) {
        if (!this.isConnected && startAnchorDownload(this, null)) {
          suppressAnchorDispatch.add(this);
          try { return originalClick.apply(this, args); } finally { suppressAnchorDispatch.delete(this); }
        }
        return originalClick.apply(this, args);
      };
    }

    if (typeof originalDispatchEvent === 'function') {
      prototype.dispatchEvent = function (event) {
        if (suppressAnchorDispatch.has(this)) return originalDispatchEvent.call(this, event);
        if (event?.type === 'click') startAnchorDownload(this, event);
        return originalDispatchEvent.call(this, event);
      };
    }
  }

  const bridge = {
    version: 1,
    open(value) {
      const url = urlFrom(value);
      if (!url) return false;
      const fileId = fileIdFrom(url);
      if (!fileId) return false;
      void saveUrl(url, fileId);
      return true;
    },
    saveBlob,
  };
  window.__OWC_DOWNLOAD_BRIDGE__ = bridge;
  window.saveAs = saveBlob;
})();
