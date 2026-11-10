globalThis.LightTorrentBridge = Object.freeze({
  api: globalThis.browser ?? globalThis.chrome,
  clientOrigin: 'http://127.0.0.1:3000',
  normalizeMagnet(value) {
    if (typeof value !== 'string') return null;
    const magnet = value.trim().replace(/^magnet:/i, 'magnet:');
    return magnet.length <= 16384 && magnet.startsWith('magnet:?') ? magnet : null;
  },
  clientURL(magnet) {
    const normalized = this.normalizeMagnet(magnet);
    if (!normalized) throw new Error('Invalid or oversized magnet link.');
    // Fragments stay in the browser, rather than being sent in HTTP requests.
    return `${this.clientOrigin}/#magnet=${encodeURIComponent(normalized)}`;
  }
});
