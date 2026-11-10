importScripts('background.js');

async function registerSafariScripts() {
  const scripts = [
    {
      id: 'light-torrent-shadow-roots',
      js: ['shadow-roots.js'],
      world: 'MAIN'
    },
    {
      id: 'light-torrent-magnets',
      js: ['shared.js', 'content.js'],
      world: 'ISOLATED'
    }
  ].map(script => ({
    ...script,
    matches: ['http://*/*', 'https://*/*'],
    allFrames: true,
    matchOriginAsFallback: true,
    runAt: 'document_start',
    persistAcrossSessions: true
  }));
  const registered = await LightTorrentBridge.api.scripting.getRegisteredContentScripts();
  const existing = new Set(registered.map(script => script.id));
  const updates = scripts.filter(script => existing.has(script.id));
  const additions = scripts.filter(script => !existing.has(script.id));
  if (updates.length) await LightTorrentBridge.api.scripting.updateContentScripts(updates);
  if (additions.length) await LightTorrentBridge.api.scripting.registerContentScripts(additions);
}

registerSafariScripts().catch(error => {
  console.error('Light Torrent could not register Safari content scripts:', error);
});
