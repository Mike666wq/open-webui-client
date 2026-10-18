/* Open WebUI adapter, upstream 91ea4e3421d1d8069f13d4a463fcb5986d94ea60.
 * Native evaluates this function with a bounded JSON request. No public bridge,
 * network access, stored conversation data, or changes to host theme preferences. */
(function (request) {
  'use strict';
  const doc = document;
  const key = 'owc-personalization-style';
  const marker = 'data-owc-appearance';
  const surfaceMarker = 'data-owc-appearance-surface';
  const root = doc.documentElement;
  const chat = doc.querySelector('#chat-container');
  const messages = chat?.querySelector('#messages-container') || doc.querySelector('#messages-container');
  const chatInput = chat?.querySelector('#chat-input') || doc.querySelector('#chat-input') ||
    doc.querySelector('#message-input') || doc.querySelector('textarea[aria-label]') ||
    chat?.querySelector('[contenteditable="true"]');
  const supported = location.origin === request.origin &&
    (location.pathname === '/' || location.pathname.startsWith('/c/')) &&
    !!chat && !!messages && !!chatInput;
  const page = location.origin + location.pathname + location.search;
  const rows = supported ? Array.from(messages.querySelectorAll('.user-message[id^="message-"]'))
    .filter(node => !node.hidden && node.getAttribute('aria-hidden') !== 'true') : [];
  const entries = request.navigation ? rows.map(node => {
    const content = node.querySelector('.markdown-prose, .whitespace-pre-wrap');
    return { id: node.id, text: (content?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160) || '…' };
  }) : [];
  // IDs identify the currently mounted branch; never request hidden history.
  const branch = JSON.stringify(rows.map(node => node.id));
  const clearSurfaces = () => {
    doc.querySelectorAll(`[${surfaceMarker}]`).forEach(node => node.removeAttribute(surfaceMarker));
  };
  const cleanup = () => {
    doc.getElementById(key)?.remove(); root.removeAttribute(marker); clearSurfaces();
  };
  if (!supported || !request.config?.enabled) cleanup();
  else {
    const c = request.config;
    const clamp = (n, min, max, fallback) => Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    const dark = !!c.dark;
    const text = dark ? '#e5e7eb' : '#111827';
    const muted = dark ? '#a6afbd' : '#596579';
    const surface = dark ? '17,19,24' : '248,250,252';
    const alpha = clamp(c.opacity, 50, 100, 90) / 100;
    const accent = /^#[0-9a-f]{6}$/i.test(c.accent) ? c.accent : '#2563eb';
    const rgb = parseInt(accent.slice(1), 16);
    const luminance = [16,8,0].map(shift => ((rgb >> shift) & 255)/255).map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4);
    const ink = luminance[0]*.2126+luminance[1]*.7152+luminance[2]*.0722 > .2 ? '#111827' : '#ffffff';
    const scope = `html[${marker}]`;
    const css = `
${scope}, ${scope} body { background:transparent!important; color:${text}!important; color-scheme:${dark ? 'dark' : 'light'}; }
${scope} [${surfaceMarker}] { background-color:transparent!important; background-image:none!important; }
${scope} body > #app, ${scope} #app > div, ${scope} #app > div > div,
${scope} #app > div > main, ${scope} #app > div > main > div, ${scope} #chat-container,
${scope} #chat-container > div, ${scope} #chat-container > div > div,
${scope} #chat-container > div > div > div, ${scope} #chat-pane,
${scope} #messages-container { background-color:transparent!important; background-image:none!important; }
${scope} #chat-container > div > .pointer-events-none.absolute { display:none!important; }
${scope} #chat-container { color:${text}!important; --color-gray-50:${dark ? '#20242c' : '#f8fafc'}; --color-gray-850:${dark ? '#20242c' : '#edf1f7'}; }
${scope} #messages-container, ${scope} #chat-container :is(nav, #message-input, #message-input-container, #chat-input-container, #message-input-dropzone, .user-message .rounded-3xl), ${scope} #sidebar { background-color:rgba(${surface},${alpha})!important; color:${text}!important; }
${scope} #chat-container :is(.markdown-prose,.whitespace-pre-wrap) { color:${text}!important; font-size:${clamp(c.fontSize,14,24,16)}px!important; line-height:${clamp(c.lineHeight,130,210,165)/100}!important; }
${scope} #chat-container :is(pre,code) { font-family:ui-monospace,SFMono-Regular,Consolas,monospace!important; line-height:1.5!important; }
${scope} #chat-container pre { background:${dark ? '#20242c' : '#edf1f7'}!important; color:${text}!important; }
${scope} #chat-container :is(a,button[aria-pressed="true"]) { color:${accent}!important; }
${scope} #chat-container :is(.text-gray-500,.text-gray-400) { color:${muted}!important; }
${scope} #chat-container :is(.text-gray-100,.text-gray-200,.text-gray-700,.text-gray-800,.text-gray-900,.text-black) { color:${text}!important; }
${scope} #send-message-button { background-color:${accent}!important; color:${ink}!important; }
${scope} :is(#chat-input,#message-input,textarea[aria-label],[contenteditable="true"]) { color:${text}!important; caret-color:${accent}; }
`;
    let style = doc.getElementById(key);
    if (!style) { style = doc.createElement('style'); style.id = key; (doc.head || root).appendChild(style); }
    if (style.textContent !== css) style.textContent = css;
    if (!root.hasAttribute(marker)) root.setAttribute(marker, '');
    clearSurfaces();
    // Newer Open WebUI shells paint their page background at intermediate
    // wrappers whose class names change between releases. Apply the marker only
    // to the minimal computed-opacity path from the chat to the document root.
    const opaqueLayers = [];
    for (let node = chat; node && node !== root; node = node.parentElement) {
      const style = node.ownerDocument?.defaultView?.getComputedStyle?.(node);
      if (!style) continue;
      const hasPaint = style.backgroundImage !== 'none' ||
        (style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
          style.backgroundColor !== 'transparent');
      if (hasPaint || node === chat || node.parentElement === root) opaqueLayers.push(node);
    }
    for (const node of opaqueLayers.slice(0, 12)) {
      if (node !== root) node.setAttribute(surfaceMarker, '');
    }
  }
  let jumped = false;
  if (supported && request.jump && request.page === page && request.branch === branch) {
    const target = rows.find(node => node.id === request.jump);
    if (target) { target.scrollIntoView({ block: 'start', behavior: 'auto' }); jumped = true; }
  }
  return { supported, page, branch, entries, jumped };
})
