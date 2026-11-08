import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const hostName = 'com.lighttorrent.launcher';
const execute = promisify(execFile);
const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const browserFolders = {
  chrome: ['Google', 'Chrome'],
  chromium: ['Chromium'],
  edge: ['Microsoft Edge'],
  brave: ['BraveSoftware', 'Brave-Browser']
};
export const browserRegistryKeys = {
  chrome: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
  chromium: 'HKCU\\Software\\Chromium\\NativeMessagingHosts',
  edge: 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
  brave: 'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts'
};

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function batchQuote(value) {
  if (/["\x00\r\n]/.test(value)) throw new Error('The Node.js or project path cannot be represented in a Windows launcher.');
  return `"${value.replace(/%/g, '%%')}"`;
}

export async function installHelper({
  extensionId, browser = 'chrome', home = os.homedir(),
  platform = process.platform, executable = process.execPath, root = projectDir,
  localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
  run = execute
}) {
  if (!['darwin', 'win32'].includes(platform)) throw new Error('This native helper installer supports macOS and Windows only.');
  if (!/^[a-p]{32}$/.test(extensionId || '')) throw new Error('Provide the 32-letter extension ID from your browser extensions page.');
  if (!Object.hasOwn(browserFolders, browser)) throw new Error('Browser must be chrome, chromium, edge, or brave.');
  executable = path.resolve(executable);
  root = path.resolve(root);
  await access(executable, platform === 'win32' ? constants.F_OK : constants.X_OK);
  const hostScript = path.join(root, 'native', 'host.js');
  await access(hostScript, constants.R_OK);
  await access(path.join(root, 'server.js'), constants.R_OK);
  const support = platform === 'win32' ? path.resolve(localAppData) : path.join(home, 'Library', 'Application Support');
  const helperDir = path.join(support, 'Light Torrent');
  const manifestDir = platform === 'win32' ?
    path.join(helperDir, 'NativeMessagingHosts', browser) :
    path.join(support, ...browserFolders[browser], 'NativeMessagingHosts');
  const launcher = path.join(helperDir, platform === 'win32' ? 'native-host.cmd' : 'native-host');
  const manifestPath = path.join(manifestDir, `${hostName}.json`);
  const script = platform === 'win32' ?
    `@echo off\r\nsetlocal DisableDelayedExpansion\r\nchcp 65001 >nul\r\n${batchQuote(executable)} ${batchQuote(hostScript)}\r\nexit /b %errorlevel%\r\n` :
    `#!/bin/sh\nexec ${shellQuote(executable)} ${shellQuote(hostScript)}\n`;
  await mkdir(helperDir, { recursive: true, mode: 0o700 });
  await mkdir(manifestDir, { recursive: true });
  await writeFile(launcher, script, { mode: 0o700 });
  if (platform !== 'win32') await chmod(launcher, 0o700);
  await writeFile(manifestPath, JSON.stringify({
    name: hostName,
    description: 'Start the local Light Torrent client after extension approval',
    path: launcher,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`]
  }, null, 2) + '\n', { mode: 0o600 });
  if (platform !== 'win32') await chmod(manifestPath, 0o600);
  const registryKey = platform === 'win32' ? `${browserRegistryKeys[browser]}\\${hostName}` : undefined;
  if (registryKey) {
    try {
      await run('reg.exe', ['add', registryKey, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f', '/reg:32'], { windowsHide: true });
    } catch (error) {
      throw new Error(`Could not register the native helper for ${browser}: ${error.message}`, { cause: error });
    }
  }
  return { launcher, manifestPath, ...(registryKey ? { registryKey } : {}) };
}

async function main() {
  const [extensionId, browser = 'chrome', ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('Usage: npm run install:helper -- EXTENSION_ID [chrome|chromium|edge|brave]');
  const installed = await installHelper({ extensionId, browser });
  console.log(`Native helper installed: ${installed.manifestPath}`);
  console.log(`Launcher: ${installed.launcher}`);
  if (installed.registryKey) console.log(`Registry key: ${installed.registryKey}`);
  console.log('Reload the extension and website tabs. Approved magnet links can now start the client.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
