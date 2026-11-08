import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { readCompletedDirectory, saveCompletedDirectory, settingsPath } from '../lib/settings.js';

const execute = promisify(execFile);
const canceledMessage = 'Folder selection canceled. No download was started. Approve the magnet again to choose a final folder.';
const windowsPicker = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$owner = New-Object System.Windows.Forms.Form
try {
  $dialog.Description = 'Choose where Light Torrent saves completed downloads'
  $dialog.ShowNewFolderButton = $true
  $dialog.SelectedPath = [Environment]::GetFolderPath('UserProfile')
  $owner.TopMost = $true
  $owner.ShowInTaskbar = $false
  $owner.Opacity = 0
  $owner.Show()
  $owner.Activate()
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath)))
  }
} finally {
  $dialog.Dispose()
  $owner.Dispose()
}
`;

export async function pickCompletedDirectory({ platform = process.platform, run = execute } = {}) {
  let result;
  try {
    if (platform === 'win32') {
      result = await run('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand',
        Buffer.from(windowsPicker, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 300000, maxBuffer: 16384 });
      const encoded = result.stdout.trim();
      if (!encoded) throw new Error(canceledMessage);
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        throw new Error('The folder picker returned an invalid response.');
      }
      return Buffer.from(encoded, 'base64').toString('utf8');
    }
    if (platform === 'darwin') {
      result = await run('/usr/bin/osascript', ['-e',
        'POSIX path of (choose folder with prompt "Choose where Light Torrent saves completed downloads")'],
      { timeout: 300000, maxBuffer: 16384 });
      const directory = result.stdout.replace(/\r?\n$/, '');
      if (!directory) throw new Error(canceledMessage);
      return directory;
    }
    throw new Error('The folder picker supports Windows and macOS only.');
  } catch (error) {
    if (error.message === canceledMessage || (platform === 'darwin' && /\(-128\)/.test(error.stderr || ''))) {
      throw new Error(canceledMessage);
    }
    throw new Error(`Could not choose the final download folder: ${error.message}`, { cause: error });
  }
}

export async function ensureCompletedDirectory({
  settingsFile = settingsPath(), chooseDirectory = pickCompletedDirectory, selectAgain = false
} = {}) {
  const saved = selectAgain ? undefined : await readCompletedDirectory(settingsFile);
  if (saved) return saved;
  await mkdir(path.dirname(settingsFile), { recursive: true, mode: 0o700 });
  const { default: lockfile } = await import('proper-lockfile');
  let lockError;
  const release = await lockfile.lock(path.dirname(settingsFile), {
    lockfilePath: `${settingsFile}.lock`,
    stale: 30000, update: 5000,
    retries: { retries: 300, minTimeout: 1000, maxTimeout: 1000 },
    onCompromised(error) { lockError = error; }
  });
  try {
    const selected = selectAgain ? undefined : await readCompletedDirectory(settingsFile);
    if (selected) return selected;
    const directory = await chooseDirectory();
    if (lockError) throw lockError;
    if (!directory) throw new Error(canceledMessage);
    return await saveCompletedDirectory(directory, settingsFile);
  } finally {
    if (!lockError) await release();
  }
}
