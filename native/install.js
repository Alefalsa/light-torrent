import { constants } from 'node:fs';
import { access, chmod, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const hostName = 'com.lighttorrent.launcher';
const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const browserFolders = {
  chrome: ['Google', 'Chrome'],
  chromium: ['Chromium'],
  edge: ['Microsoft Edge'],
  brave: ['BraveSoftware', 'Brave-Browser']
};

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export async function installHelper({
  extensionId, browser = 'chrome', home = os.homedir(),
  platform = process.platform, executable = process.execPath, root = projectDir
}) {
  if (platform !== 'darwin') throw new Error('This native helper installer currently supports macOS only.');
  if (!/^[a-p]{32}$/.test(extensionId || '')) throw new Error('Provide the 32-letter extension ID from your browser extensions page.');
  if (!Object.hasOwn(browserFolders, browser)) throw new Error('Browser must be chrome, chromium, edge, or brave.');
  await access(executable, constants.X_OK);
  const hostScript = path.join(root, 'native', 'host.js');
  await access(hostScript, constants.R_OK);
  await access(path.join(root, 'server.js'), constants.R_OK);
  const support = path.join(home, 'Library', 'Application Support');
  const helperDir = path.join(support, 'Light Torrent');
  const manifestDir = path.join(support, ...browserFolders[browser], 'NativeMessagingHosts');
  const launcher = path.join(helperDir, 'native-host');
  const manifestPath = path.join(manifestDir, `${hostName}.json`);
  await mkdir(helperDir, { recursive: true, mode: 0o700 });
  await mkdir(manifestDir, { recursive: true });
  await writeFile(launcher, `#!/bin/sh\nexec ${shellQuote(executable)} ${shellQuote(hostScript)}\n`, { mode: 0o700 });
  await chmod(launcher, 0o700);
  await writeFile(manifestPath, JSON.stringify({
    name: hostName,
    description: 'Start the local Light Torrent client after extension approval',
    path: launcher,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`]
  }, null, 2) + '\n', { mode: 0o600 });
  await chmod(manifestPath, 0o600);
  return { launcher, manifestPath };
}

async function main() {
  const [extensionId, browser = 'chrome', ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('Usage: npm run install:helper -- EXTENSION_ID [chrome|chromium|edge|brave]');
  const installed = await installHelper({ extensionId, browser });
  console.log(`Native helper installed: ${installed.manifestPath}`);
  console.log(`Launcher: ${installed.launcher}`);
  console.log('Reload the extension and website tabs. Approved magnet links can now start the client.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
