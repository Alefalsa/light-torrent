(() => {
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
