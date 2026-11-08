import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ensureCompletedDirectory, pickCompletedDirectory } from './folders.js';
import { settingsPath } from '../lib/settings.js';

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const clientURL = 'http://127.0.0.1:3000';

export function clientLogPath({
  platform = process.platform, home = os.homedir(),
  localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
} = {}) {
  return platform === 'win32' ?
    path.join(localAppData, 'Light Torrent', 'Logs', 'client.log') :
    path.join(home, 'Library', 'Logs', 'Light Torrent', 'client.log');
}

export async function isClientReady(url = clientURL, opening = false) {
  let response;
  try {
    response = await fetch(`${url}/api/health${opening ? '?open=1' : ''}`, {
      signal: AbortSignal.timeout(1000), redirect: 'error'
    });
  } catch (error) {
    if (['ECONNREFUSED', 'ECONNRESET'].includes(error.cause?.code) || error.name === 'TimeoutError') return false;
    throw new Error(`Could not check the local client: ${error.message}`, { cause: error });
  }
  let health;
  try {
    health = await response.json();
  } catch (error) {
    throw new Error('Port 3000 is occupied by an incompatible service. Stop it before starting Light Torrent.', { cause: error });
  }
  if (health.app !== 'light-torrent' || health.apiVersion !== 1) {
    throw new Error('Port 3000 is occupied by another service or an older client. Restart Light Torrent.');
  }
  if (!response.ok && response.status !== 503) throw new Error(`Client health check failed (${response.status}).`);
  return response.ok && health.ready === true;
}

async function getClientSettings(url) {
  const response = await fetch(`${url}/api/settings`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok) throw new Error('The running client needs to be restarted to support final-folder selection. Pause downloads and let it shut down, then approve the magnet again.');
  const settings = await response.json();
  if (typeof settings.completedDir !== 'string' || !/^[a-f0-9]{64}$/.test(settings.token || '')) {
    throw new Error('The running client returned incompatible folder settings. Restart Light Torrent.');
  }
  return settings;
}

async function applyCompletedDirectory(url, directory, settings) {
  settings ??= await getClientSettings(url);
  if (settings.completedDir === directory) return;
  const response = await fetch(`${url}/api/settings`, {
    method: 'POST', signal: AbortSignal.timeout(5000), redirect: 'error',
    headers: { 'Content-Type': 'application/json', 'X-Client-Token': settings.token },
    body: '{}'
  });
  const result = await response.json();
  if (!response.ok || result.completedDir !== directory) {
    throw new Error(result.error || 'The running client could not apply the selected final folder.');
  }
}

export async function startClient({
  url = clientURL,
  serverPath = path.join(projectDir, 'server.js'),
  cwd = projectDir,
  logPath = clientLogPath(),
  timeoutMs = 15000,
  settingsFile = settingsPath(),
  chooseDirectory = pickCompletedDirectory,
  selectAgain = false
} = {}) {
  const ready = await isClientReady(url, true);
  const runningSettings = ready ? await getClientSettings(url) : undefined;
  const completedDir = await ensureCompletedDirectory({ settingsFile, chooseDirectory, selectAgain });
  if (ready) {
    await applyCompletedDirectory(url, completedDir, runningSettings);
    return { started: false };
  }
  mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  const log = openSync(logPath, 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [serverPath], {
      cwd, detached: true, windowsHide: true,
      stdio: ['ignore', log, log],
      env: {
        ...process.env, PORT: new URL(url).port,
        DATA_DIR: path.join(cwd, 'data'), DOWNLOAD_DIR: path.join(cwd, 'downloads'),
        COMPLETED_DIR: completedDir
      }
    });
  } finally {
    closeSync(log);
  }
  let startupError;
  let exitCode;
  child.on('error', error => { startupError = error; });
  child.on('exit', code => { exitCode = code; });
  child.unref();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (startupError) throw new Error(`Could not launch the client: ${startupError.message}`, { cause: startupError });
    // Concurrent launches can lose the queue lock while another process becomes ready.
    if (await isClientReady(url, true)) {
      await applyCompletedDirectory(url, completedDir);
      return { started: true };
    }
    await setTimeout(200);
  }
  const detail = exitCode === undefined ? '' : ` (process exit ${exitCode})`;
  throw new Error(`The client did not become ready${detail}. See ${logPath}.`);
}
