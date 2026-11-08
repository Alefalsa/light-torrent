# Light Torrent

A small local web app for magnet links approved through its browser extension. One Node.js process,
an embedded WebTorrent engine, and a plain HTML/CSS/JavaScript interface. No
account, cloud service, Electron shell, or separate torrent daemon.

## Run

The browser-extension workflow requires **macOS**, **Node.js 22 or newer**,
and **Chrome, Chromium, Edge, or Brave** (Chromium 111 or newer). Firefox and
Safari are not supported. The Node.js client can run on other platforms, but
the native helper installer and current extension download flow support macOS
only.

Install a current Node.js LTS release from [nodejs.org](https://nodejs.org/en/download),
then reopen your terminal and check `node --version` and `npm --version`.

```sh
git clone https://github.com/Alefalsa/light-torrent.git
cd light-torrent
npm ci
```

If you already have the source, run `npm ci` from its directory.

Next, follow the [extension installation guide](extension/README.md#install):
enable Developer mode, load the `extension` directory, and install the native
helper for its extension ID. **Both the extension and helper are required for
the browser workflow, even if the client is already running.**

Approve a magnet link on a website. The helper starts the client automatically
and opens **http://127.0.0.1:3000**, where the download appears in the queue.
The dashboard has no manual input or `.torrent` upload panel. The extension
itself has no npm dependencies or separate build step; `npm ci` installs the
local client's dependencies.

For manual startup or debugging, run this from the project directory:

```sh
npm start
```

Keep that terminal open while the client runs. Manual startup does not replace
the extension's native-helper installation.

- Live progress, download/upload speeds, and peer counts.
- Pause stops the torrent's connections, including uploads; resume verifies and
  reuses existing data.
- Remove clears the queue entry **without deleting downloaded files**.
- The queue survives restarts, including paused state and received metadata.
- Once verified complete, torrents stop seeding and move to **`~/Downloads`**.
  The queue shows **Completed** and the new file location. Completed entries do
  not resume seeding after restart; removing them does not delete their files.
- Stop with **Ctrl+C** to save progress and close connections cleanly.
- With no active torrents, the server saves the queue and exits after **two
  minutes**. Paused, errored, and completed torrents do not keep it running;
  downloading, finding metadata, and moving completed files do. Opening the client page or approving a
  magnet through the extension resets the idle review window. Stats polling
  does not keep the server alive. The UI shows the countdown and stops polling
  after the idle shutdown. Use the extension to start it again, or run
  `npm start` and reload the page.
  The standalone Node.js process exits after queue persistence, engine cleanup,
  and lock release, even if a dependency leaves background handles alive.

Unfinished files are saved directly in the app's `downloads/`, without
client-generated UUID folders. Completed files move into your main Downloads
folder. Multi-file torrents retain their own directory structure. Pause/resume
verifies and reuses unfinished data instead of creating another folder.
Staging-file ownership is retained with the queue to prevent a different
torrent from overwriting the same path, including after removal from the queue.
When preparing another torrent, stale reservations are released only if the
file is gone and no queued torrent owns it. Paused and errored entries still
reserve their filenames. Unrecognized existing files are not overwritten.

Completion moves never overwrite an existing destination. If a name conflicts,
both files are kept and the torrent shows an error: rename or move the conflicting
destination, then choose **Retry move**. The torrent remains stopped during this
process. A small persisted move journal makes interrupted moves recoverable and
prevents accidentally seeding or redownloading files that have already moved.
Temporary hidden `.light-torrent-*.part` files may appear in the destination
while moving and are removed after installation. Same-volume moves use hard
links without copying the payload; cross-volume moves use a bounded 64 KiB
buffer. Shutdown waits for moves, and loss of queue ownership cancels them.
Completed entries cannot resume; remove an entry before adding it again.
Re-adding a torrent whose final files still exist will report a destination
conflict rather than overwriting them.

Queued downloads from the old UUID-folder layout are moved into `downloads/`
before being resumed. Empty migrated directories are removed, but old unqueued
folders and duplicate copies are left untouched. If a destination conflicts,
the torrent shows an error instead of overwriting either file.
Each torrent shows its location.
Queue state is in `data/queue.json`. Do not edit it while the client is running.
Keep the same download directory between runs to resume existing downloads.
The data directory is locked: a second instance cannot open the same queue,
even on a different port. Clean shutdown releases the lock. After a crash,
allow 30 seconds for a stale lock to expire before retrying. Do not delete
`data/queue.lock` while an instance is running. If the lock is lost, the app
stops and reports an error rather than continuing to write unprotected state.

Queue changes are saved before changing torrent connections or removing entries.
If a save fails (for example, a full disk), the action fails without applying
those changes. Engine failures are reported separately and the actual state is
saved when possible.

Optional configuration:

```sh
PORT=3001 DOWNLOAD_DIR="$HOME/Downloads/LightTorrent" npm start
```

`DOWNLOAD_DIR` selects unfinished-file storage; `COMPLETED_DIR` selects the
completed-file destination (default `$HOME/Downloads`). If both are the same,
the torrent simply stops and is marked Completed without moving files.

`DATA_DIR` can also select a different queue directory. Relative paths are resolved
from the current working directory. The web interface binds only to IPv4 loopback,
with host/origin checks and session-token protection for changes. It is not a
remote-access server and should not be exposed through a reverse proxy.

## Notes

- Supports conventional BitTorrent v1 and hybrid torrents, not v2-only torrents.
- Magnet links need reachable peers to supply metadata. With no seeders, a download
  may wait indefinitely; tracker and engine warnings are shown in the interface.
- Non-fatal warnings use an amber warning sign and a short label. Hover, focus,
  or tap the label for a plain-language explanation and the original details;
  Escape dismisses the tooltip. Actual torrent errors remain visible in red.
- The dashboard and extension share a green download-arrow icon. The dashboard
  includes a browser-tab favicon, theme color, and individually labeled progress bars.
- This is a real peer-to-peer client: it can connect to ordinary TCP BitTorrent
  peers, trackers, DHT, and WebRTC peers. It is not an anonymity tool or VPN.
- Automatic router port mapping is disabled; outbound connections still work.
  Firewall/NAT restrictions may limit peer availability.
- No file preview, selective downloading, browser file serving, or automatic
  opening of downloaded content. Open downloads from your file manager.
- Only download and share content you have permission to use. Downloaded files
  are untrusted; don't execute them without checking them.
- `npm audit` currently reports a high-severity advisory in WebTorrent's transitive
  `ip` dependency through `bittorrent-tracker` (GHSA-2p57-rm9w-gvfp). The current
  upstream version has no non-breaking fix, and this app does not configure a
  SOCKS proxy. Do not force-downgrade the engine to the obsolete version suggested
  by `npm audit fix --force`.

## Browser extension

The [Chromium extension](extension/README.md) is the normal way to add downloads.
It recognizes clicked magnet links on websites, asks for confirmation, and
opens the local client with the link in its URL fragment.
The client adds the magnet directly after extension
approval; there is no second confirmation on the dashboard.
Install the `extension` directory through your browser's **Load unpacked** option,
then install the macOS native-messaging helper using the guide linked above.
The extension always calls the helper before opening a client tab, including
when reusing a running client on port 3000. There is no helper-free fallback.
After updating the source, reload the extension and website tabs to apply new
icons, highlighting, and confirmation behavior.

For installation, permissions, startup, and download issues, see
[extension troubleshooting](extension/README.md#troubleshooting).

## Development

- `server.js`: loopback HTTP API, request protections, and idle shutdown.
- `lib/queue.js`: validation, persistence, engine lifecycle, and completion moves.
- `public/`: dashboard HTML, CSS, JavaScript, and SVG favicon.
- `extension/`: magnet highlighting, approval, and client handoff.
- `native/`: macOS native-messaging installer and client launcher.
- `test/`: isolated regression tests using temporary storage and local peers.

Runtime queue data, downloads, dependencies, local environment files, and logs
are excluded from Git. The lockfile is committed for reproducible installation.
After changing dependencies, verify `npm ci` in a clean checkout: an existing
`node_modules` directory can mask missing optional-dependency lockfile entries.
Configuration uses environment variables; the app does not load `.env` files.
The API retains `.torrent` source parsing for saved magnet metadata and existing
API clients, although uploads are no longer offered in the dashboard.

## Validate

```sh
npm run check
npm test
```

Tests use temporary directories and local peers, without downloading public
torrents. They cover HTTP protections, queue persistence, pause/resume/removal,
invalid input, failed persistence, single-instance locking, and a real local
magnet download.
GitHub Actions runs syntax checks and the full test suite on Linux and macOS
with Node.js 22 and 24.

## License

[MIT](LICENSE). Third-party dependencies retain their own licenses.
