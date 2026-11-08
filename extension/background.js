importScripts('shared.js');

async function ensureClientRunning() {
  let result;
  try {
    result = await chrome.runtime.sendNativeMessage('com.lighttorrent.launcher', { action: 'start-client' });
  } catch (error) {
    throw new Error(`Client auto-start is unavailable: ${error.message}. Install the native helper and reload the extension.`, { cause: error });
  }
  if (!result?.ok) throw new Error(result?.error || 'The native helper did not confirm that the client is ready.');
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
