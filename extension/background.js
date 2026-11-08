importScripts('shared.js');

let clientStartup;

async function ensureClientRunning() {
  if (!clientStartup) {
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
      port.postMessage({ action: 'start-client' });
    }).finally(() => { clientStartup = undefined; });
  }
  return clientStartup;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'open-light-torrent') return false;
  const source = sender.origin && sender.origin !== 'null' ? sender.origin : sender.url;
  // About:blank frames inherit a web origin even though their own URL is not HTTP.
  if (sender.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id) ||
      !/^https?:\/\//.test(source || '')) {
    sendResponse({ ok: false, error: 'Only magnet links clicked on web pages are accepted.' });
    return false;
  }
  let url;
  try {
    url = LightTorrentBridge.clientURL(message.magnet);
  } catch (error) {
    sendResponse({ ok: false, error: error.message });
    return false;
  }
  ensureClientRunning()
    .then(() => chrome.tabs.create({ url, active: true }))
    .then(() => sendResponse({ ok: true }))
    .catch(error => {
      console.error('Light Torrent could not start or open the client:', error);
      sendResponse({ ok: false, error: error.message });
    });
  return true;
});
