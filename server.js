import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import WebTorrent from 'webtorrent';
import lockfile from 'proper-lockfile';
import { InputError, TorrentQueue } from './lib/queue.js';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']]
]);

async function readJson(request) {
  if (request.headers['content-type'] !== 'application/json') {
    throw new InputError('Expected application/json.', 415);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    // Saved torrent metadata also uses base64, whose JSON payload exceeds its binary size.
    if (size > 3 * 1024 * 1024) throw new InputError('Request is too large.', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new InputError('Invalid JSON.');
  }
}

export async function createApp({
  dataDir = path.join(rootDir, 'data'),
  downloadDir = path.join(rootDir, 'downloads'),
  completedDir = path.join(os.homedir(), 'Downloads'),
  client,
  idleTimeoutMs = 120000,
  logger = console
} = {}) {
  let queue;
  let release;
  let lockFailure;
  let closeOnLockLoss;
  try {
    if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 1) throw new Error('Idle timeout must be a positive number of milliseconds.');
    await mkdir(dataDir, { recursive: true });
    release = await lockfile.lock(dataDir, {
      lockfilePath: path.join(dataDir, 'queue.lock'),
      stale: 30000,
      update: 5000,
      onCompromised(error) {
        lockFailure = new Error(`Queue lock lost; stopping to protect saved state: ${error.message}`, { cause: error });
        if (queue) {
          queue.persistenceError = lockFailure;
          queue.moveAbort.abort(lockFailure);
          queue.report(lockFailure);
        } else {
          logger.error(lockFailure);
        }
        if (closeOnLockLoss) closeOnLockLoss().catch(error => logger.error(error));
      }
    });
    client ??= new WebTorrent({ maxConns: 40, natUpnp: false, natPmp: false });
    queue = new TorrentQueue({ client, dataDir, downloadDir, completedDir, logger });
    await queue.restore();
    if (lockFailure) throw lockFailure;
  } catch (error) {
    try {
      if (client && !client.destroyed) {
        await new Promise((resolve, reject) => client.destroy(error => error ? reject(error) : resolve()));
      }
    } finally {
      if (release && !lockFailure) await release();
    }
    const message = error.code === 'ELOCKED' ?
      'The queue is already in use. Stop the other instance, or wait 30 seconds after a crash and retry.' :
      `Unable to restore queue: ${error.message}`;
    throw new Error(message, { cause: error });
  }
  const token = randomBytes(32).toString('hex');
  let mutations = Promise.resolve();
  let closing;
  let notifyClosed;
  const shutdownComplete = new Promise(resolve => { notifyClosed = resolve; });
  let pendingOperations = 0;
  let idleTimer;
  let idleShutdownAt = null;

  function clearIdleTimer() {
    clearTimeout(idleTimer);
    idleTimer = undefined;
    idleShutdownAt = null;
  }

  function hasActivity() {
    // Paused torrents are removed from the engine; live torrents include metadata waits and seeds.
    return pendingOperations > 0 || queue.completions.size > 0 || (!client.destroyed && client.torrents.some(torrent => !torrent.destroyed));
  }

  function updateIdleTimer(reset = false) {
    if (closing || !server.listening || hasActivity()) {
      clearIdleTimer();
      return;
    }
    if (idleTimer && !reset) return;
    clearIdleTimer();
    idleShutdownAt = Date.now() + idleTimeoutMs;
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      if (hasActivity()) {
        updateIdleTimer();
        return;
      }
      logger.log('No active torrents. Saving the queue and shutting down.');
      close().catch(error => logger.error(error));
    }, idleTimeoutMs);
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (status, value) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(value));
    };
    let holdsIdleTimer = false;
    try {
      if (closing) throw new InputError('The client is shutting down. Open it again through the extension.', 503);
      const port = server.address()?.port;
      const hosts = [`localhost:${port}`, `127.0.0.1:${port}`];
      if (!hosts.includes(request.headers.host)) throw new InputError('Untrusted host.', 403);
      const origin = request.headers.origin;
      if (origin && !hosts.some(host => origin === `http://${host}`)) {
        throw new InputError('Untrusted origin.', 403);
      }
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new InputError('Cross-site request blocked.', 403);
      const url = new URL(request.url, `http://${request.headers.host}`);
      const pathname = url.pathname;
      if (request.method === 'GET' && assets.has(pathname)) {
        if (pathname === '/') updateIdleTimer(true);
        const [file, type] = assets.get(pathname);
        const content = await readFile(path.join(rootDir, 'public', file));
        response.writeHead(200, { 'Content-Type': type });
        response.end(content);
        return;
      }
      if (request.method === 'GET' && pathname === '/api/torrents') {
        json(200, { ...queue.snapshot(), token, idleShutdownAt });
        return;
      }
      if (request.method === 'GET' && pathname === '/api/health') {
        if (url.searchParams.get('open') === '1') updateIdleTimer(true);
        const ready = !client.destroyed && !queue.persistenceError;
        json(ready ? 200 : 503, { app: 'light-torrent', apiVersion: 1, ready });
        return;
      }
      if (request.method === 'POST') {
        const supplied = request.headers['x-client-token'];
        if (typeof supplied !== 'string' || supplied.length !== token.length ||
            Buffer.byteLength(supplied) !== Buffer.byteLength(token) ||
            !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
          throw new InputError('Missing or invalid session token. Refresh the page.', 403);
        }
        pendingOperations++;
        holdsIdleTimer = true;
        updateIdleTimer();
        const input = await readJson(request);
        const match = /^\/api\/torrents\/([a-f0-9-]{36})\/(pause|resume|remove)$/.exec(pathname);
        if (pathname !== '/api/torrents' && !match) throw new InputError('Not found.', 404);
        // Serialize queue mutations without letting a failed action block later requests.
        const operation = mutations.then(() => match ? queue.action(match[1], match[2]) : queue.add(input));
        mutations = operation.catch(error => logger.error(`Torrent action failed: ${error.message}`));
        json(match ? 200 : 201, await operation);
        return;
      }
      throw new InputError('Not found.', 404);
    } catch (error) {
      if (!(error instanceof InputError)) logger.error(error);
      if (!response.destroyed) json(error.status || 500, {
        error: error instanceof InputError ? error.message : `Operation failed: ${error.message}`
      });
    } finally {
      if (holdsIdleTimer) {
        pendingOperations--;
        updateIdleTimer();
      }
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  const activityChanged = () => updateIdleTimer();
  client.on('add', activityChanged);
  client.on('remove', activityChanged);
  client.on('error', activityChanged);
  queue.on('activity', activityChanged);
  server.once('listening', activityChanged);
  function close() {
    clearIdleTimer();
    closing ??= (async () => {
      try {
        await new Promise((resolve, reject) => {
          if (!server.listening) return resolve();
          server.close(error => error ? reject(error) : resolve());
          server.closeIdleConnections();
        });
        await mutations;
        await queue.close();
      } finally {
        client.removeListener('add', activityChanged);
        client.removeListener('remove', activityChanged);
        client.removeListener('error', activityChanged);
        queue.removeListener('activity', activityChanged);
        if (!lockFailure) await release();
      }
    })().finally(() => notifyClosed());
    return closing;
  }
  closeOnLockLoss = close;
  return { server, queue, close, shutdownComplete };
}

async function main() {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  const app = await createApp({
    downloadDir: process.env.DOWNLOAD_DIR ? path.resolve(process.env.DOWNLOAD_DIR) : undefined,
    dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : undefined,
    completedDir: process.env.COMPLETED_DIR ? path.resolve(process.env.COMPLETED_DIR) : undefined
  });
  try {
    await new Promise((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) {
    await app.close();
    throw error;
  }
  console.log(`Light Torrent is ready at http://127.0.0.1:${port}`);
  console.log(`Downloads: ${app.queue.downloadDir}`);
  console.log(`Completed downloads: ${app.queue.completedDir}`);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await app.close();
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await app.shutdownComplete;
  await app.close();
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
