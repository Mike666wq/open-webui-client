(() => {
  const open = (value) => {
    try {
      const url = new URL(value, window.location.href);
      if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) return;
      window.__TAURI__?.core?.invoke('open-external', { url: url.href }).catch(() => {});
    } catch {}
  };

  document.addEventListener('click', (event) => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!anchor) return;
    const target = new URL(anchor.href, window.location.href);
    if (anchor.target === '_blank' || target.origin !== window.location.origin) {
      event.preventDefault();
      event.stopImmediatePropagation();
      open(target.href);
    }
  }, true);

  window.open = (value) => {
    open(String(value));
    return null;
  };
})();
