(() => {
  const marker = 'light-torrent-magnet-link';
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    a.${marker} {
      box-shadow: inset 0 -1.1em 0 rgba(16, 185, 129, 0.18) !important;
      text-decoration-line: underline !important;
      text-decoration-color: rgba(16, 185, 129, 0.85) !important;
      text-decoration-thickness: 2px !important;
      text-underline-offset: 0.18em !important;
    }
    a.${marker}:hover, a.${marker}:focus-visible {
      box-shadow: inset 0 -1.1em 0 rgba(16, 185, 129, 0.28) !important;
      text-decoration-color: #059669 !important;
    }
    a.${marker}:focus-visible {
      outline: 2px solid #10b981 !important;
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
      element.classList.toggle(marker, Boolean(LightTorrentBridge.normalizeMagnet(element.getAttribute('href'))));
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
    if (!confirm(`Light Torrent\n\nDownload this magnet link?${label}\n\nApproving starts or opens the local client and adds this torrent to its queue immediately. Starting the client may also resume active torrents already saved in its queue.`)) return;
    try {
      const result = await chrome.runtime.sendMessage({ type: 'open-light-torrent', magnet });
      if (!result?.ok) throw new Error(result?.error || 'The extension did not respond.');
    } catch (error) {
      console.error('Light Torrent could not open the client:', error);
      alert(`Light Torrent could not open the client: ${error.message}\n\nTry reloading this page or the extension.`);
    }
  }

  window.addEventListener('click', handleMagnetClick, true);
  window.addEventListener('auxclick', handleMagnetClick, true);
})();
