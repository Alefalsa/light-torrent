# Light Torrent Magnet Links

A dependency-free Manifest V3 extension for Chrome, Chromium, Edge, and Brave.
It is a companion to the local client, not a torrent engine inside the browser.
Requires Chromium 111 or newer for the open-shadow-root notification hook.

## Install

1. Open `chrome://extensions` (or `edge://extensions` / `brave://extensions`).
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this `extension` directory, containing
   `manifest.json`.
4. Copy its extension ID, then run this from the parent project directory:

   ```sh
   npm run install:helper -- YOUR_EXTENSION_ID chrome
   ```

   Use `chromium`, `edge`, or `brave` instead of `chrome` for those browsers.
   The helper installer supports **macOS**, uses your current Node.js executable,
   and registers access only for the supplied extension ID. It needs no sudo.
5. Reload the extension to apply its `nativeMessaging` permission, accepting any
   browser permission prompt, and reload existing website tabs.

## Use

Magnet links receive a noticeable mint tint and crisp green underline instead
of a boxy outline. Hover strengthens the tint; keyboard focus adds a clear green
ring. Their text, foreground color, backgrounds, and layout are unchanged.
Links added later or whose `href`
changes are updated automatically, including ordinary frames and open shadow
roots. Plain-text magnets, custom JavaScript buttons, and closed shadow roots
are not highlighted. Reload the extension and existing website tabs after
updating it.

Click a normal `magnet:` link on a website. A browser confirmation dialog asks
whether to download the magnet. Choose **Cancel** to do nothing, or **OK**
to have the local helper start the client if needed, wait for readiness, then
open `http://127.0.0.1:3000` and add the magnet directly to the queue.
There is no second confirmation or manual input panel on the dashboard.

Left clicks, modifier clicks, middle clicks, and keyboard activation are
supported, including links inside ordinary frames and open shadow roots.
JavaScript-generated clicks are ignored. Custom buttons that launch magnets
without using a link, context-menu actions, and browser-internal pages are not
intercepted. Browsers may suppress repeated confirmation dialogs; if this
happens, reload the page and click the link again.

The helper reuses a running client on **port 3000**. New launches use this
project's default `data` and unfinished `downloads` directories; completed files
move to `~/Downloads` and stop seeding. The client continues running after the
browser closes while downloading or moving files, but shuts down after two idle
minutes if the queue is empty or all torrents are paused/errored/completed. Approving a new
link resets that review window, even when reusing an idle client.
Starting restores the queue: existing unpaused torrents may
resume downloading; completed entries remain stopped. The newly approved magnet
is added when the client page opens.
Concurrent launches are protected by the existing queue lock.

If startup fails, the extension shows an error rather than opening a broken tab.
Client output is appended to `~/Library/Logs/Light Torrent/client.log`. An older
running client without the health endpoint must be restarted before using
auto-start. The helper does not supervise/restart crashes without another
approved request. To stop the client, send SIGTERM to its Node.js process.

Rerun the installer if you move the project, remove/change the installed Node.js
version, or change the extension ID. To uninstall, remove only the
`com.lighttorrent.launcher.json` file from your browser's user
`NativeMessagingHosts` directory. The shared launcher is under
`~/Library/Application Support/Light Torrent/native-host` and can be removed
after unregistering it from all browsers.

This extension does not register as your operating system's magnet handler.

## Permissions and privacy

The content script needs access to HTTP/HTTPS pages to recognize clicked links.
You can restrict its site access using your browser's extension settings; it
will then work only on those sites. It locally examines link URLs to highlight magnets and the clicked link before
handoff, does not
collect page contents or browsing history, and uses no storage, analytics,
remote services, or third-party libraries.

Highlighting uses a shared stylesheet per frame and DOM mutation observers,
not polling. Detached shadow roots are no longer observed. A small page-world
hook delegates to the original `attachShadow` method and signals newly created
open roots; it has no extension API access and cannot start the client.

After confirmation, the magnet is sent only to the extension's own background
worker and placed in the local client's URL **fragment**, not a query string.
The client consumes and removes that fragment, then adds the magnet using its
own session token. Failures appear on the dashboard; approve the link again to
retry. The extension never accesses the client's API or token.
Its `nativeMessaging` permission is used only to send `{ "action": "start-client" }`
to the installed helper. The helper accepts no commands, paths, or magnet data
and checks a minimal local health endpoint without reading your torrent queue.

## Test

Use the public-domain/Creative Commons links on
[WebTorrent's free torrents page](https://webtorrent.io/free-torrents):

1. Click a magnet and cancel: no client tab should open.
2. Click again and approve: the client should open and add the magnet.
3. Verify that the download appears without another click on the dashboard.
4. Stop the client, approve another magnet, and verify it starts automatically.
5. Check the mint tint and underline on ordinary and dynamically added magnet
   links, including open shadow roots. Hover for a stronger tint or tab to a link
   for its focus ring. Changing its URL to an ordinary web link should remove
   the highlight.

Project regression tests also cover confirmation, synthetic clicks, sender
validation, URL encoding, native startup, failures, and direct magnet handoff. Real unpacked
extension loading must be checked in your chosen browser.
