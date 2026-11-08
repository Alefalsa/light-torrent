import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const clientURL = 'http://127.0.0.1:3000';

export async function isClientReady(url = clientURL, opening = false) {
  let response;
  try {
    response = await fetch(`${url}/api/health${opening ? '?open=1' : ''}`, {
      signal: AbortSignal.timeout(1000), redirect: 'error'
    });
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED' || error.name === 'TimeoutError') return false;
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

export async function startClient({
  url = clientURL,
  serverPath = path.join(projectDir, 'server.js'),
  cwd = projectDir,
  logPath = path.join(os.homedir(), 'Library', 'Logs', 'Light Torrent', 'client.log'),
  timeoutMs = 15000
} = {}) {
  if (await isClientReady(url, true)) return { started: false };
  mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  const log = openSync(logPath, 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [serverPath], {
      cwd, detached: true,
      stdio: ['ignore', log, log],
      env: {
        ...process.env, PORT: new URL(url).port,
        DATA_DIR: path.join(cwd, 'data'), DOWNLOAD_DIR: path.join(cwd, 'downloads')
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
    if (await isClientReady(url, true)) return { started: true };
    await setTimeout(200);
  }
  const detail = exitCode === undefined ? '' : ` (process exit ${exitCode})`;
  throw new Error(`The client did not become ready${detail}. See ${logPath}.`);
}
