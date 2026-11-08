# Light Torrent Magnet Links

A dependency-free Manifest V3 extension for Chrome, Chromium, Edge, and Brave.
It is a companion to the local client, not a torrent engine inside the browser.
Requires Chromium 111 or newer for the open-shadow-root notification hook.

## Requirements

- **macOS**: the current native helper installer supports macOS only.
- **Node.js 22 or newer**, with npm. Install a current LTS release from
  [nodejs.org](https://nodejs.org/en/download), reopen your terminal, and verify:

  ```sh
  node --version
  npm --version
  ```

- **Chrome, Chromium, Edge, or Brave**. Firefox and Safari are not supported.
- The local client's dependencies, installed below.

The extension itself needs no npm packages, bundler, or build command. It is
loaded directly from source. **The extension and native helper are both required
for the browser download flow**, even when the local client is already running.
The extension always contacts the helper before opening the dashboard; there
is no helper-free or Windows/Linux startup fallback.

## Install

1. Download the source and install the local client's dependencies:

   ```sh
   git clone https://github.com/Alefalsa/light-torrent.git
   cd light-torrent
   npm ci
   ```

   If you already have the source, open a terminal in the project directory
   and run `npm ci`. Do not run it inside `extension`. Keep the project in a
   stable location: the native helper records its path.
2. Open your browser's extensions page:

   | Browser | Extensions page | Helper installer argument |
   | --- | --- | --- |
   | Chrome | `chrome://extensions` | `chrome` |
   | Chromium | `chrome://extensions` | `chromium` |
   | Edge | `edge://extensions` | `edge` |
   | Brave | `brave://extensions` | `brave` |

3. Enable **Developer mode**, choose **Load unpacked**, and select the project's
   `extension` directory, containing `manifest.json`. Do not select the project
   root or a ZIP file. Ensure the extension's enabled toggle is on.
4. Copy the 32-letter extension ID shown on its card. From the project root,
   replace `YOUR_EXTENSION_ID` with that ID and run:

   ```sh
   npm run install:helper -- YOUR_EXTENSION_ID chrome
   ```

   Use `chromium`, `edge`, or `brave` instead of `chrome` for those browsers.
   The helper installer supports **macOS**, uses your current Node.js executable,
   and registers access only for the supplied extension ID. It needs no sudo.
   Install it separately for each browser you use, with that browser's ID and
   installer argument.
5. Reload the extension using its reload button, accept any browser permission
   prompt, and reload existing website tabs. In the extension's **Details**,
   allow site access on the HTTP/HTTPS websites where you want to use magnets.
6. Click a normal magnet link on a website and approve the confirmation.
   The helper starts the local client if needed and opens its dashboard with
   the download added automatically. You do not need to run `npm start` first,
   pin a toolbar icon, or launch an extension popup.

For manual client startup or debugging, use `npm start` from the project root
and keep the terminal open. The native helper is still required for extension
handoffs.

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

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `node` or `npm` is not found | Install Node.js 22 or newer, reopen the terminal, and check both version commands under Requirements. |
| Missing package/module when starting the client | Run `npm ci` from the project root, not from `extension` or `native`. |
| Load unpacked cannot find the manifest | Select the extracted `extension` directory containing `manifest.json`, not the project root or a ZIP. |
| Magnet links are not highlighted or intercepted | Ensure the extension is enabled and has site access, then reload the website tab. Only real `magnet:` links on HTTP/HTTPS pages are supported; plain text, custom JavaScript buttons, and closed shadow roots are not. |
| Auto-start is unavailable or the native host is not found | Run `npm run install:helper -- YOUR_EXTENSION_ID BROWSER` from the project root with the actual extension ID and browser argument from the table above. Reload the extension and website tabs. Starting the client manually alone does not fix a missing helper. |
| Native host exits or startup fails after moving the project or updating Node.js | Run `npm ci` and rerun the helper installer with the current extension ID. It records the project and Node.js executable paths. Check `~/Library/Logs/Light Torrent/client.log` if the client launched. |
| Port 3000 is occupied by another service or an older client | Stop the specific conflicting process, then approve the magnet again. A manually started client can be stopped with Ctrl+C in its terminal. The helper always uses port 3000; changing `PORT` for a manual launch does not change the extension's target. |
| Queue is already in use | Stop the other Light Torrent instance before retrying. After a crash, wait 30 seconds for the stale lock to expire. Do not delete the queue lock while a client is running. |
| Dashboard says Sleeping | This is normal after two idle minutes. Approve another magnet through the extension to start the client again. |
| Dashboard reports that a magnet could not be added | Read the displayed error, resolve it, and approve the link again to retry. The fragment is consumed once, so reloading the dashboard does not resubmit it. |
| Download stays at Finding metadata or has tracker warnings | Metadata needs reachable peers. Check connectivity and firewall restrictions; a torrent with no seeders may wait indefinitely. A tracker warning alone does not mean the download has failed. |

If a browser suppresses repeated confirmation dialogs, reload the website
before clicking the link again. For local client errors, run `npm start` in a
terminal to see its output directly, or inspect the helper-launched client's
log path above.

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
