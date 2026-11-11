(() => {
  const marker = 'light-torrent-magnet-link';
  const iconClass = 'light-torrent-magnet-icon';
  const icons = new WeakMap();
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    a.${marker} > .${iconClass} {
      all: unset !important;
      display: inline-block !important;
      width: 0.85em !important;
      height: 0.85em !important;
      margin-inline-start: 0 !important;
      vertical-align: -0.08em !important;
      flex-shrink: 0 !important;
      fill: currentColor !important;
      opacity: 0.7 !important;
      pointer-events: none !important;
    }
    a.${marker} > .${iconClass} > path {
      fill: inherit !important;
      stroke: none !important;
    }
    a.${marker}:hover > .${iconClass}, a.${marker}:focus-visible > .${iconClass} {
      opacity: 1 !important;
    }
    a.${marker}:focus-visible {
      outline: 2px solid currentColor !important;
      outline-offset: 3px !important;
    }
  `);
  const observers = new Map();

  function applyStyle(root) {
    if (!root.adoptedStyleSheets.includes(sheet)) {
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    }
  }

  function highlight(element) {
    if (element.localName === 'a') {
      const magnet = Boolean(LightTorrentBridge.normalizeMagnet(element.getAttribute('href')));
      element.classList.toggle(marker, magnet);
      let icon = icons.get(element);
      if (magnet) {
        if (!icon) {
          icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          icon.classList.add(iconClass);
          icon.setAttribute('aria-hidden', 'true');
          icon.setAttribute('focusable', 'false');
          icon.setAttribute('viewBox', '0 0 24 24');
          const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          shape.setAttribute('d', 'M4 8h5v4a3 3 0 0 0 6 0V8h5v4a8 8 0 0 1-16 0V8ZM4 2h5v4H4zM15 2h5v4h-5z');
          icon.append(shape);
          icons.set(element, icon);
        }
        if (element.lastChild !== icon) element.append(icon);
      } else if (icon) {
        icon.remove();
        icons.delete(element);
      }
    }
    if (element.shadowRoot) observeRoot(element.shadowRoot);
  }

  function scan(node, visited = new WeakSet()) {
    if (![1, 9, 11].includes(node.nodeType) || visited.has(node)) return;
    visited.add(node);
    if (node instanceof Element) highlight(node);
    for (const element of node.querySelectorAll('*')) {
      if (!visited.has(element)) {
        visited.add(element);
        highlight(element);
      }
    }
  }

  function observeRoot(root) {
    if (observers.has(root)) return;
    applyStyle(root);
    const observer = new MutationObserver(records => {
      const visited = new WeakSet();
      let removed = false;
      for (const record of records) {
        if (record.type === 'attributes') highlight(record.target);
        else {
          if (record.target instanceof Element) highlight(record.target);
          for (const node of record.addedNodes) scan(node, visited);
          removed ||= record.removedNodes.length > 0;
        }
      }
      if (removed) {
        for (const [target, observer] of observers) {
          if (target instanceof ShadowRoot && !target.host.isConnected) {
            observer.disconnect();
            observers.delete(target);
            target.adoptedStyleSheets = target.adoptedStyleSheets.filter(value => value !== sheet);
          }
        }
      }
      if (observers.has(root)) applyStyle(root);
    });
    observers.set(root, observer);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
    scan(root);
  }

  // A DOM observer cannot see a shadow root attached to an already-connected host.
  window.addEventListener('light-torrent-shadow-root', event => {
    for (const element of event.composedPath()) {
      if (element instanceof Element && element.isConnected && element.shadowRoot) observeRoot(element.shadowRoot);
    }
  }, true);
  observeRoot(document);

  async function handleMagnetClick(event) {
    if (!event.isTrusted || (event.type === 'click' ? event.button !== 0 : event.button !== 1)) return;
    const anchor = event.composedPath().find(element =>
      element instanceof Element && element.localName === 'a' && element.hasAttribute('href'));
    if (!anchor) return;
    const magnet = LightTorrentBridge.normalizeMagnet(anchor.getAttribute('href'));
    if (!magnet) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const name = new URLSearchParams(magnet.slice(magnet.indexOf('?') + 1)).get('dn');
    const label = name ? `\n\n${name.slice(0, 200)}` : '';
    if (!confirm(`Light Torrent\n\nDownload this magnet link?${label}\n\nApproving starts or opens the local client and adds this torrent to its queue immediately. On first use, choose a final download folder before startup. Starting the client may also resume active torrents already saved in its queue.`)) return;
    try {
      const result = await LightTorrentBridge.api.runtime.sendMessage({ type: 'open-light-torrent', magnet });
      if (!result?.ok) throw new Error(result?.error || 'The extension did not respond.');
    } catch (error) {
      console.error('Light Torrent could not open the client:', error);
      alert(`Light Torrent could not open the client: ${error.message}\n\nTry reloading this page or the extension.`);
    }
  }

  window.addEventListener('click', handleMagnetClick, true);
  window.addEventListener('auxclick', handleMagnetClick, true);
})();
