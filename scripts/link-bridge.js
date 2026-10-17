(() => {
  const open = (value) => {
    try {
      const url = new URL(value, window.location.href);
      if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) return;
      const session = window.__OWC_SESSION__;
      if (!session) return;
      window.__TAURI__?.core?.invoke('open-external', {
        url: url.href,
        generation: session.generation,
        sessionToken: session.token,
      }).catch(() => {});
    } catch {}
  };

  document.addEventListener('click', (event) => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!anchor) return;
    const target = new URL(anchor.href, window.location.href);
    if (target.origin !== window.location.origin) {
      event.preventDefault();
      event.stopImmediatePropagation();
      open(target.href);
    } else if (
      anchor.target === '_blank' &&
      (['http:', 'https:'].includes(target.protocol) || target.protocol === 'blob:') &&
      target.origin === window.location.origin &&
      !target.username &&
      !target.password
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      window.location.href = target.href;
    }
  }, true);

  window.open = (value) => {
    try {
      if (window.__OWC_DOWNLOAD_BRIDGE__?.open(String(value)) === true) return null;
    } catch {}
    try {
      const url = new URL(String(value), window.location.href);
      if (
        (['http:', 'https:'].includes(url.protocol) || (url.protocol === 'blob:' && url.origin === window.location.origin)) &&
        url.origin === window.location.origin &&
        !url.username &&
        !url.password
      ) {
        window.location.href = url.href;
        return null;
      }
    } catch {}
    open(String(value));
    return null;
  };
})();
