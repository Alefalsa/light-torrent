importScripts('shared.js');

let clientStartup;
let startupAction;

async function ensureClientRunning(action = 'start-client') {
  if (clientStartup && action !== 'start-client' && action !== startupAction) {
    await clientStartup;
    return ensureClientRunning(action);
  }
  if (!clientStartup) {
    startupAction = action;
    // A native port keeps the service worker alive while the user chooses a folder.
    clientStartup = new Promise((resolve, reject) => {
      const port = chrome.runtime.connectNative('com.lighttorrent.launcher');
      port.onMessage.addListener(result => {
        if (!result?.ok) reject(new Error(result?.error || 'The native helper did not confirm that the client is ready.'));
        else resolve();
        port.disconnect();
      });
      port.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError;
        reject(new Error(`Client auto-start is unavailable: ${error?.message || 'The native helper disconnected before confirming readiness'}. Install the native helper and reload the extension.`));
      });
      port.postMessage({ action });
    }).finally(() => { clientStartup = undefined; });
  }
  return clientStartup;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!['open-light-torrent', 'client-control'].includes(message?.type)) return false;
  let url;
  let action = 'start-client';
  try {
    if (message.type === 'client-control') {
      if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html') ||
          !['open', 'change-folder'].includes(message.action) ||
          Object.keys(message).some(key => !['type', 'action'].includes(key))) {
        throw new Error('Only the extension toolbar can control the client.');
      }
      if (message.action === 'open') url = `${LightTorrentBridge.clientOrigin}/`;
      else action = 'change-folder';
    } else {
      const source = sender.origin && sender.origin !== 'null' ? sender.origin : sender.url;
      // About:blank frames inherit a web origin even though their own URL is not HTTP.
      if (sender.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id) ||
          !/^https?:\/\//.test(source || '')) {
        throw new Error('Only magnet links clicked on web pages are accepted.');
      }
      url = LightTorrentBridge.clientURL(message.magnet);
    }
  } catch (error) {
    sendResponse({ ok: false, error: error.message });
    return false;
  }
  ensureClientRunning(action)
    .then(() => url ? chrome.tabs.create({ url, active: true }) : undefined)
    .then(() => sendResponse({ ok: true }))
    .catch(error => {
      console.error('Light Torrent could not start or open the client:', error);
      sendResponse({ ok: false, error: error.message });
    });
  return true;
});
