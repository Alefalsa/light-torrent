import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebTorrent from 'webtorrent';
import { createApp } from '../server.js';
import { parseSource } from '../lib/queue.js';
import { isClientReady, startClient } from '../native/launcher.js';
import { readCompletedDirectory, saveCompletedDirectory, settingsPath } from '../lib/settings.js';

const offline = {
  dht: false, tracker: false, lsd: false, utPex: false,
  natUpnp: false, natPmp: false, torrentPort: 0
};
const magnet = `magnet:?xt=urn:btih:${'a'.repeat(40)}&dn=Example`;

async function waitFor(predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for torrent state.');
    await setTimeout(20);
  }
}

async function setup(t, { idleTimeoutMs = 120000 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'light-torrent-test-'));
  const settingsFile = path.join(root, 'settings.json');
  const apps = [];
  t.after(async () => {
    for (const app of apps) if (!app.closed) await app.close();
    await rm(root, { recursive: true, force: true });
  });
  async function open() {
    const client = new WebTorrent(offline);
    const app = await createApp({
      client, idleTimeoutMs, dataDir: path.join(root, 'data'), downloadDir: path.join(root, 'downloads'),
      completedDir: await readCompletedDirectory(settingsFile) || path.join(root, 'finished'), settingsFile
    });
    const close = app.close;
    app.close = async () => {
      try { await close(); } finally { app.closed = true; }
    };
    apps.push(app);
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${app.server.address().port}`;
    const initial = await (await fetch(`${url}/api/torrents`)).json();
    async function post(route, body = {}, headers = {}) {
      const response = await fetch(`${url}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Client-Token': initial.token, ...headers },
        body: JSON.stringify(body)
      });
      return { status: response.status, body: await response.json() };
    }
    return { app, url, post };
  }
  return { root, settingsFile, open, ...await open() };
}

async function completedFixture(t, contents = { 'complete.txt': 'A verified completion fixture.' }, options = {}) {
  const fixture = await setup(t, options);
  const added = await fixture.post('/api/torrents', { kind: 'magnet', value: magnet });
  const entry = fixture.app.queue.entries.get(added.body.id);
  // Exercise recovery of the previous staging-and-move workflow.
  delete entry.downloadDirectory;
  const files = Object.entries(contents).map(([file, content]) => ({ path: file, length: Buffer.byteLength(content) }));
  fixture.app.queue.prepareFiles(entry, files);
  for (const [file, content] of Object.entries(contents)) {
    const source = path.join(fixture.root, 'downloads', file);
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, content);
  }
  return { ...fixture, entry, files };
}

test('validates magnet links and rejects URLs, malformed uploads, and v2-only links', async () => {
  assert.equal((await parseSource({ kind: 'magnet', value: magnet })).parsed.infoHash, 'a'.repeat(40));
  for (const input of [
    null, {}, { kind: 'magnet', value: 'https://example.com/a.torrent' },
    { kind: 'magnet', value: 'magnet:?dn=MissingHash' },
    { kind: 'magnet', value: 'magnet:?xt=urn:btmh:1220' + 'a'.repeat(64) },
    { kind: 'file', value: 'invalid!base64' }, { kind: 'file', value: '' },
    { kind: 'file', value: Buffer.alloc(20).toString('base64') },
    { kind: 'file', value: Buffer.from('not a torrent').toString('base64') },
    { kind: 'file', value: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64') }
  ]) {
    await assert.rejects(parseSource(input), error => error.status === 400);
  }
});

test('serves UI and blocks unauthorized, cross-origin, and rebinding requests', async t => {
  const { url, post } = await setup(t);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Light Torrent/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const health = await fetch(url + '/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { app: 'light-torrent', apiVersion: 1, ready: true });
  for (const asset of ['/app.js', '/style.css']) assert.equal((await fetch(url + asset)).status, 200);
  const icon = await fetch(url + '/favicon.svg');
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get('content-type'), 'image/svg+xml');
  assert.match(await icon.text(), /<svg[^>]+viewBox="0 0 128 128"/);
  const input = { kind: 'magnet', value: magnet };
  assert.equal((await post('/api/torrents', input, { 'X-Client-Token': '' })).status, 403);
  assert.equal((await post('/api/torrents', input, { Origin: 'https://example.com' })).status, 403);
  const rebindingStatus = await new Promise((resolve, reject) => {
    http.get(url + '/api/torrents', { headers: { Host: 'evil.example' } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(rebindingStatus, 403);
  assert.equal((await post('/api/torrents', input, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post('/api/torrents', input, { 'Content-Type': 'text/plain' })).status, 415);
  const malformed = await fetch(url + '/api/torrents', {
    method: 'POST', headers: {
      'Content-Type': 'application/json',
      'X-Client-Token': (await (await fetch(url + '/api/torrents')).json()).token
    }, body: '{'
  });
  assert.equal(malformed.status, 400);
  assert.equal((await fetch(url + '/missing')).status, 404);
});

test('persists paused queue, rejects duplicates, resumes, and preserves files on removal', async t => {
  const fixture = await setup(t);
  const { app, post, root } = fixture;
  const added = await post('/api/torrents', { kind: 'magnet', value: magnet });
  assert.equal(added.status, 201);
  const id = added.body.id;
  assert.equal((await post('/api/torrents', { kind: 'magnet', value: magnet })).status, 409);
  assert.equal((await post(`/api/torrents/${id}/pause`)).body.status, 'Paused');
  await writeFile(path.join(root, 'downloads', 'kept.txt'), 'Keep this file.');
  await app.close();
  const reopened = await fixture.open();
  const entry = reopened.app.queue.snapshot().torrents[0];
  assert.equal(entry.id, id);
  assert.equal(entry.status, 'Paused');
  assert.equal((await reopened.post(`/api/torrents/${id}/resume`)).status, 200);
  assert.equal((await reopened.post(`/api/torrents/${id}/pause`)).body.status, 'Paused');
  assert.equal((await reopened.post(`/api/torrents/${id}/remove`)).body.removed, true);
  assert.equal(reopened.app.queue.snapshot().torrents.length, 0);
  assert.equal(await readFile(path.join(root, 'downloads', 'kept.txt'), 'utf8'), 'Keep this file.');
  assert.equal((await reopened.post(`/api/torrents/${id}/pause`)).status, 404);
  const saved = JSON.parse(await readFile(path.join(root, 'data', 'queue.json'), 'utf8'));
  assert.deepEqual(saved.torrents, []);
});

test('first extension use applies the chosen folder and legacy completion moves survive restart', async t => {
  const fixture = await completedFixture(t);
  const { app, root, entry, files, settingsFile, url } = fixture;
  const finalFolder = path.join(root, 'chosen final folder');
  await mkdir(finalFolder);
  let prompts = 0;
  const options = { url, settingsFile, chooseDirectory: async () => { prompts++; return finalFolder; } };
  assert.deepEqual(await startClient(options), { started: false });
  assert.equal(app.queue.completedDir, finalFolder);
  assert.deepEqual(await startClient(options), { started: false });
  assert.equal(prompts, 1);
  await app.queue.scheduleCompletion(entry, files);
  assert.equal(entry.completedDirectory, finalFolder);
  assert.equal(await readFile(path.join(finalFolder, 'complete.txt'), 'utf8'), 'A verified completion fixture.');
  await app.close();
  const reopened = await fixture.open();
  assert.equal(reopened.app.queue.completedDir, finalFolder);
  assert.equal(reopened.app.queue.snapshot().torrents[0].path, finalFolder);
});

test('toolbar folder changes apply to a running client and cancellation preserves its destination', async t => {
  const { app, root, settingsFile, url } = await setup(t);
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  await mkdir(first);
  await mkdir(second);
  await saveCompletedDirectory(first, settingsFile);
  await startClient({ url, settingsFile });
  assert.equal(app.queue.completedDir, first);
  const added = await app.queue.add({ kind: 'magnet', value: magnet });
  assert.equal(added.path, first);
  await assert.rejects(startClient({
    url, settingsFile, selectAgain: true, chooseDirectory: async () => undefined
  }), /selection canceled/);
  assert.equal(app.queue.completedDir, first);
  assert.equal(await readCompletedDirectory(settingsFile), first);
  assert.deepEqual(await startClient({
    url, settingsFile, selectAgain: true, chooseDirectory: async () => second
  }), { started: false });
  assert.equal(app.queue.completedDir, second);
  assert.equal(await readCompletedDirectory(settingsFile), second);
  assert.equal(app.queue.describe(app.queue.entries.get(added.id)).path, first);
  const newer = await app.queue.add({ kind: 'magnet', value: `magnet:?xt=urn:btih:${'b'.repeat(40)}` });
  assert.equal(newer.path, second);
  await app.close();
  const saved = JSON.parse(await readFile(path.join(root, 'data/queue.json'), 'utf8'));
  assert.deepEqual(saved.torrents.map(entry => entry.downloadDirectory), [first, second]);
});

test('folder settings reload is protected and never applies unselected or invalid folders', async t => {
  const { app, root, settingsFile, url, post } = await setup(t);
  const initial = await (await fetch(url + '/api/settings')).json();
  assert.equal(initial.completedDir, path.join(root, 'finished'));
  assert.match(initial.token, /^[a-f0-9]{64}$/);
  assert.equal((await post('/api/settings', {}, { 'X-Client-Token': '' })).status, 403);
  assert.equal((await post('/api/settings', {}, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await post('/api/settings')).status, 400);
  assert.equal((await post('/api/settings', { completedDir: root })).status, 400);
  await writeFile(settingsFile, 'invalid settings');
  assert.equal((await post('/api/settings')).status, 500);
  assert.equal(app.queue.completedDir, initial.completedDir);
  const finalFolder = path.join(root, 'selected');
  await mkdir(finalFolder);
  await saveCompletedDirectory(finalFolder, settingsFile);
  const changed = await post('/api/settings');
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.body, { completedDir: finalFolder });
  assert.equal(app.queue.completedDir, finalFolder);
});

test('concurrent duplicate additions create exactly one queue entry', async t => {
  const { app, post } = await setup(t);
  const results = await Promise.all([
    post('/api/torrents', { kind: 'magnet', value: magnet }),
    post('/api/torrents', { kind: 'magnet', value: magnet })
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
  assert.equal(app.queue.snapshot().torrents.length, 1);
});

test('failed saves do not pause, resume, remove, or add torrents', async t => {
  const { app, post, root } = await setup(t);
  const added = await post('/api/torrents', { kind: 'magnet', value: magnet });
  const entry = app.queue.entries.get(added.body.id);
  const dataDir = path.join(root, 'data');
  const backup = path.join(root, 'data-backup');
  async function withUnavailableData(operation) {
    const saved = await readFile(path.join(dataDir, 'queue.json'), 'utf8');
    await rename(dataDir, backup);
    try {
      await operation();
      assert.equal(await readFile(path.join(backup, 'queue.json'), 'utf8'), saved);
    } finally {
      await rename(backup, dataDir);
    }
  }
  const originalTorrent = entry.torrent;
  await withUnavailableData(async () => {
    assert.equal((await post(`/api/torrents/${entry.id}/pause`)).status, 500);
    assert.equal(entry.paused, false);
    assert.equal(entry.torrent, originalTorrent);
    assert.equal(originalTorrent.destroyed, false);
    assert.equal((await post(`/api/torrents/${entry.id}/remove`)).status, 500);
    assert.equal(app.queue.entries.get(entry.id), entry);
    assert.equal(originalTorrent.destroyed, false);
    assert.equal((await post('/api/torrents', {
      kind: 'magnet', value: `magnet:?xt=urn:btih:${'b'.repeat(40)}`
    })).status, 500);
    assert.equal(app.queue.entries.size, 1);
  });
  assert.equal((await post(`/api/torrents/${entry.id}/pause`)).status, 200);
  await withUnavailableData(async () => {
    assert.equal((await post(`/api/torrents/${entry.id}/resume`)).status, 500);
    assert.equal(entry.paused, true);
    assert.equal(entry.torrent, null);
    assert.equal(app.queue.client.torrents.length, 0);
  });
  assert.equal((await post(`/api/torrents/${entry.id}/resume`)).status, 200);
  assert.equal(entry.paused, false);
});

test('engine action failure is reported and persists the actual live state', async t => {
  const { app, post, root } = await setup(t);
  const added = await post('/api/torrents', { kind: 'magnet', value: magnet });
  const entry = app.queue.entries.get(added.body.id);
  const remove = app.queue.client.remove;
  app.queue.client.remove = async () => { throw new Error('Simulated engine failure'); };
  try {
    const result = await post(`/api/torrents/${entry.id}/remove`);
    assert.equal(result.status, 500);
    assert.match(result.body.error, /Simulated engine failure/);
    assert.equal(app.queue.entries.get(entry.id), entry);
    assert.equal(entry.paused, false);
    assert.equal(entry.torrent.destroyed, false);
    const saved = JSON.parse(await readFile(path.join(root, 'data', 'queue.json'), 'utf8'));
    assert.equal(saved.torrents[0].id, entry.id);
    assert.equal(saved.torrents[0].paused, false);
    assert.match(saved.torrents[0].error, /Simulated engine failure/);
  } finally {
    app.queue.client.remove = remove;
  }
});

test('a second instance cannot acquire the queue or overwrite its state', async t => {
  const fixture = await setup(t);
  const added = await fixture.post('/api/torrents', { kind: 'magnet', value: magnet });
  const stateFile = path.join(fixture.root, 'data', 'queue.json');
  const saved = await readFile(stateFile, 'utf8');
  await assert.rejects(fixture.open(), /queue is already in use/);
  assert.equal(await readFile(stateFile, 'utf8'), saved);
  assert.equal(fixture.app.queue.snapshot().torrents[0].id, added.body.id);
  await fixture.app.close();
  const reopened = await fixture.open();
  assert.equal(reopened.app.queue.snapshot().torrents[0].id, added.body.id);
});

test('an expired lock from a crashed instance is reclaimed', async t => {
  const fixture = await setup(t);
  await fixture.app.close();
  const lockPath = path.join(fixture.root, 'data', 'queue.lock');
  await mkdir(lockPath);
  const expired = new Date(Date.now() - 60000);
  await utimes(lockPath, expired, expired);
  const reopened = await fixture.open();
  assert.equal(reopened.app.queue.snapshot().torrents.length, 0);
});

test('losing queue ownership shuts down without overwriting saved state', async t => {
  const fixture = await setup(t);
  const added = await fixture.post('/api/torrents', { kind: 'magnet', value: magnet });
  const stateFile = path.join(fixture.root, 'data', 'queue.json');
  const saved = await readFile(stateFile, 'utf8');
  await rm(path.join(fixture.root, 'data', 'queue.lock'), { recursive: true });
  await waitFor(() => fixture.app.queue.client.destroyed);
  assert.match(fixture.app.queue.persistenceError.message, /Queue lock lost/);
  await assert.rejects(fixture.app.close(), /Queue lock lost/);
  assert.equal(await readFile(stateFile, 'utf8'), saved);
  const reopened = await fixture.open();
  assert.equal(reopened.app.queue.snapshot().torrents[0].id, added.body.id);
});

test('empty client shuts down at its idle deadline even while stats and health are polled', async t => {
  const { app, url, root } = await setup(t, { idleTimeoutMs: 250 });
  const initial = await (await fetch(url + '/api/torrents')).json();
  assert.ok(initial.idleShutdownAt > Date.now());
  for (let i = 0; i < 3; i++) {
    await setTimeout(30);
    assert.equal((await (await fetch(url + '/api/torrents')).json()).idleShutdownAt, initial.idleShutdownAt);
    assert.equal(await isClientReady(url), true);
  }
  assert.equal(app.server.listening, true);
  await waitFor(() => !app.server.listening);
  assert.ok(Date.now() >= initial.idleShutdownAt);
  await app.close();
  assert.equal(app.queue.client.destroyed, true);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'data', 'queue.json'), 'utf8')).torrents, []);
});

test('opening the page or native-helper review intent resets the idle grace period', async t => {
  const { app, url } = await setup(t, { idleTimeoutMs: 250 });
  async function deadline() { return (await (await fetch(url + '/api/torrents')).json()).idleShutdownAt; }
  const first = await deadline();
  await setTimeout(60);
  assert.equal((await fetch(url)).status, 200);
  const second = await deadline();
  assert.ok(second > first);
  await setTimeout(60);
  assert.equal(await isClientReady(url, true), true);
  const third = await deadline();
  assert.ok(third > second);
  await setTimeout(60);
  assert.equal(await isClientReady(url), true);
  assert.equal(await deadline(), third);
  assert.equal(app.server.listening, true);
  await waitFor(() => !app.server.listening);
});

test('metadata waits stay active; pause starts idle shutdown and resume cancels it', async t => {
  const fixture = await setup(t, { idleTimeoutMs: 250 });
  const added = await fixture.post('/api/torrents', { kind: 'magnet', value: magnet });
  const id = added.body.id;
  await setTimeout(300);
  assert.equal(fixture.app.server.listening, true);
  assert.equal(fixture.app.queue.snapshot().torrents[0].status, 'Finding metadata');
  assert.equal((await (await fetch(fixture.url + '/api/torrents')).json()).idleShutdownAt, null);
  await fixture.post(`/api/torrents/${id}/pause`);
  await setTimeout(50);
  await fixture.post(`/api/torrents/${id}/resume`);
  await setTimeout(300);
  assert.equal(fixture.app.server.listening, true);
  await fixture.post(`/api/torrents/${id}/pause`);
  await waitFor(() => !fixture.app.server.listening);
  await fixture.app.close();
  const reopened = await fixture.open();
  assert.equal(reopened.app.queue.snapshot().torrents[0].status, 'Paused');
  await reopened.post(`/api/torrents/${id}/resume`);
  await reopened.post(`/api/torrents/${id}/remove`);
  await waitFor(() => !reopened.app.server.listening);
});

test('errored torrents do not prevent idle shutdown', async t => {
  const { app, post } = await setup(t, { idleTimeoutMs: 250 });
  const added = await post('/api/torrents', { kind: 'magnet', value: magnet });
  const entry = app.queue.entries.get(added.body.id);
  await waitFor(() => entry.torrent.infoHash);
  entry.torrent._destroy(new Error('Simulated torrent failure'));
  assert.equal(app.queue.snapshot().torrents[0].status, 'Error');
  await waitFor(() => !app.server.listening);
  await app.close();
  assert.equal(app.queue.client.destroyed, true);
});

test('standalone exits after idle or signal cleanup despite lingering handles, and reports failures', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'light-torrent-process-'));
  const children = [];
  t.after(async () => {
    for (const { child, completed } of children) {
      if (child.pid && child.exitCode === null && child.signalCode === null) process.kill(child.pid, 'SIGKILL');
      await completed;
    }
    await rm(root, { recursive: true, force: true });
  });
  const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
  const finalFolder = path.join(root, 'chosen final folder');
  await mkdir(finalFolder);
  for (const trigger of ['idle', 'SIGTERM', 'SIGINT', 'save-failure', 'startup-failure']) {
    const directory = path.join(root, trigger);
    const dataDir = path.join(directory, 'data');
    await mkdir(dataDir, { recursive: true });
    const initial = JSON.stringify({ version: 2, torrents: [], files: {} });
    await writeFile(path.join(dataDir, 'queue.json'), initial);
    await saveCompletedDirectory(finalFolder, settingsPath({ home: directory, localAppData: directory }));
    const preload = path.join(directory, 'linger.mjs');
    await writeFile(preload, `
      setInterval(() => {}, 1000);
      ${process.platform === 'win32' ? "process.on('message', signal => process.emit(signal));" : ''}
      ${trigger === 'idle' ? `
        const original = globalThis.setTimeout;
        globalThis.setTimeout = (callback, delay, ...args) =>
          original(callback, delay === 120000 ? 200 : delay, ...args);
      ` : ''}
    `);
    const listener = http.createServer();
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    let stdout = '';
    let stderr = '';
    let spawnError;
    const env = { ...process.env, PORT: trigger === 'startup-failure' ? 'invalid' : String(port),
      DATA_DIR: dataDir, DOWNLOAD_DIR: path.join(directory, 'downloads'),
      HOME: directory, USERPROFILE: directory, LOCALAPPDATA: directory };
    delete env.COMPLETED_DIR;
    const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, serverPath], {
      env,
      stdio: process.platform === 'win32' ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { spawnError = error; });
    const completed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    children.push({ child, completed });
    if (trigger !== 'startup-failure') {
      await waitFor(() => spawnError ||
        (stdout.includes('Light Torrent is ready') && stdout.includes('New downloads:')) ||
        child.exitCode !== null, 5000);
      if (spawnError) throw spawnError;
      assert.match(stdout, /Light Torrent is ready/, stderr);
      assert.ok(stdout.includes(`New downloads: ${finalFolder}`), stdout);
      if (trigger === 'save-failure') await rename(dataDir, path.join(directory, 'saved-data'));
      if (trigger !== 'idle') {
        const signal = trigger === 'save-failure' ? 'SIGTERM' : trigger;
        // Windows process.kill terminates immediately instead of delivering cleanup signals.
        if (process.platform === 'win32') child.send(signal);
        else process.kill(child.pid, signal);
      }
    }
    await waitFor(() => spawnError || child.exitCode !== null || child.signalCode !== null, 5000);
    if (spawnError) throw spawnError;
    const result = await completed;
    assert.equal(result.signal, null, stderr);
    assert.equal(result.code, trigger.endsWith('failure') ? 1 : 0, stderr);
    if (trigger === 'startup-failure') {
      assert.match(stderr, /PORT must be/);
    } else if (trigger === 'save-failure') {
      assert.match(stderr, /ENOENT/);
      assert.equal(await readFile(path.join(directory, 'saved-data/queue.json'), 'utf8'), initial);
    } else {
      assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, 'queue.json'), 'utf8')),
        { version: 3, torrents: [], files: {} });
      assert.equal((await readdir(dataDir)).includes('queue.lock'), false);
      if (trigger === 'idle') assert.match(stdout, /No active torrents/);
    }
  }
});

test('rejects unsupported filenames in every path component before reserving files', async t => {
  const { app } = await setup(t);
  const queue = app.queue;
  const entry = { infoHash: 'a'.repeat(40) };
  const invalid = ['invalid:directory/child.txt', 'folder/bad?.txt', 'bad|folder/child.txt', 'folder/control\x01.txt'];
  if (process.platform === 'win32') {
    invalid.push('NUL', 'folder/CON.txt', 'AUX/child.txt', 'COM1.log', 'lpt9/child.txt',
      'COM\u00b9.txt', 'CONIN$', 'CONOUT$.txt', 'folder./child.txt', 'folder /child.txt', 'file.txt.', 'file.txt ');
    assert.equal(queue.fileKey('Folder\\File.txt'), queue.fileKey('folder/file.txt'));
    for (const valid of ['console.txt', 'COM10.txt', 'LPT0.txt', '.hidden/file.txt']) {
      assert.ok(queue.filePath(valid).startsWith(queue.downloadDir));
    }
  }
  for (const file of invalid) {
    assert.throws(() => queue.prepareFiles(entry, [{ path: file }]), /unsupported file path/, file);
    assert.equal(queue.fileOwners.size, 0);
  }
});

test('downloads a real magnet directly into its final folder, stops seeding, and restores completed state', async t => {
  const fixture = await setup(t, { idleTimeoutMs: 500 });
  const seeder = new WebTorrent(offline);
  t.after(() => new Promise(resolve => seeder.destroy(resolve)));
  const content = Buffer.from('A local test torrent, shared with permission.\n'.repeat(3000));
  const sourcePath = path.join(fixture.root, 'sample.txt');
  await writeFile(sourcePath, content);
  const seed = await new Promise((resolve, reject) => {
    seeder.once('error', reject);
    const torrent = seeder.seed(sourcePath, { announce: [] }, resolve);
    torrent.once('error', reject);
  });
  const added = await fixture.post('/api/torrents', { kind: 'magnet', value: seed.magnetURI });
  assert.equal(added.status, 201);
  const entry = fixture.app.queue.entries.get(added.body.id);
  assert.equal(entry.torrent.path, path.join(fixture.root, 'finished'));
  fixture.app.queue.copyCompletedSource = async () => { throw new Error('Direct downloads must not be copied'); };
  fixture.app.queue.stageCompletedFile = async () => { throw new Error('Direct downloads must not be staged'); };
  await waitFor(() => entry.torrent.infoHash);
  entry.torrent.addPeer(`127.0.0.1:${seeder.address().port}`);
  await waitFor(() => entry.completed);
  const destination = path.join(fixture.root, 'finished', 'sample.txt');
  assert.equal(added.body.path, path.join(fixture.root, 'finished'));
  assert.deepEqual(await readdir(path.join(fixture.root, 'downloads')), []);
  assert.deepEqual(await readFile(destination), content);
  assert.equal(fixture.app.queue.snapshot().torrents[0].status, 'Completed');
  assert.equal(fixture.app.queue.snapshot().torrents[0].path, path.dirname(destination));
  assert.equal(fixture.app.queue.client.torrents.length, 0);
  assert.equal(fixture.app.queue.snapshot().torrents[0].progress, 1);
  assert.equal(entry.source.kind, 'file');
  assert.equal((await fixture.post('/api/torrents', entry.source)).status, 409);
  await waitFor(() => !fixture.app.server.listening);
  await fixture.app.close();
  const reopened = await fixture.open();
  assert.equal(reopened.app.queue.snapshot().torrents[0].status, 'Completed');
  assert.equal(reopened.app.queue.client.torrents.length, 0);
  assert.deepEqual(await readFile(destination), content);
  assert.equal((await reopened.post(`/api/torrents/${entry.id}/resume`)).status, 409);
  assert.equal((await reopened.post(`/api/torrents/${entry.id}/remove`)).status, 200);
  assert.deepEqual(await readFile(destination), content);
});

test('verifies existing destination data before reuse and never overwrites unrelated files', async t => {
  for (const scenario of [
    { name: 'matching single file', contents: { 'existing.txt': 'Verified data.\n'.repeat(3000) } },
    { name: 'same-size mismatch', contents: { 'existing.txt': 'Verified data.\n'.repeat(3000) }, mismatch: true },
    { name: 'ownership save failure', contents: { 'existing.txt': 'Verified data.\n'.repeat(3000) }, saveFailure: true },
    { name: 'different size', contents: { 'existing.txt': 'Verified data.\n'.repeat(3000) }, truncate: true },
    { name: 'matching cross-file pieces and empty file', contents: { 'one.txt': 'a'.repeat(12000), 'two.txt': 'b'.repeat(12000), 'empty.txt': '' } },
    { name: 'unverifiable cross-file boundary', contents: { 'one.txt': 'a'.repeat(12000), 'two.txt': 'b'.repeat(12000) }, missingNeighbor: true }
  ]) {
    await t.test(scenario.name, async t => {
      const fixture = await setup(t);
      const seeder = new WebTorrent(offline);
      t.after(() => new Promise(resolve => seeder.destroy(resolve)));
      const source = path.join(fixture.root, 'source', 'bundle');
      await mkdir(source, { recursive: true });
      for (const [name, content] of Object.entries(scenario.contents)) await writeFile(path.join(source, name), content);
      const names = Object.keys(scenario.contents);
      const seedPath = names.length === 1 ? path.join(source, names[0]) : source;
      const seed = await new Promise((resolve, reject) => {
        seeder.seed(seedPath, { announce: [], pieceLength: 16384 }, resolve).once('error', reject);
      });
      const existing = [];
      for (const file of seed.files) {
        if (scenario.missingNeighbor && existing.length) continue;
        const target = path.join(fixture.root, 'finished', file.path);
        let content = Buffer.from(scenario.contents[path.basename(file.path)]);
        if (scenario.mismatch) content[0] ^= 0xff;
        if (scenario.truncate) content = content.subarray(0, content.length - 1);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content);
        existing.push({ target, content, stat: await fs.lstat(target, { bigint: true }) });
      }
      const { parsed } = await parseSource({ kind: 'file', value: Buffer.from(seed.torrentFile).toString('base64') });
      const prepare = () => fixture.app.queue.prepareFiles({
        infoHash: parsed.infoHash, downloadDirectory: path.join(fixture.root, 'finished')
      }, parsed.files, { verifyExisting: true });
      if (scenario.truncate) assert.throws(prepare, /cannot be safely reused/);
      else assert.equal(prepare().size, existing.length);
      // Unknown files must never acquire persisted ownership before verification.
      for (const { target } of existing) {
        const relative = path.relative(path.join(fixture.root, 'finished'), target);
        assert.equal(fixture.app.queue.fileOwners.has(fixture.app.queue.fileKey(relative, path.join(fixture.root, 'finished'))), false);
      }
      if (scenario.saveFailure) {
        const prepareFiles = fixture.app.queue.prepareFiles;
        fixture.app.queue.prepareFiles = function (entry, files, options) {
          if (!options?.verifiedFiles?.size) return prepareFiles.call(this, entry, files, options);
          const save = this.save;
          this.save = () => { throw new Error('Verified ownership could not be saved'); };
          try {
            return prepareFiles.call(this, entry, files, options);
          } finally {
            this.save = save;
          }
        };
      }
      const input = scenario.mismatch ? { kind: 'magnet', value: seed.magnetURI } :
        { kind: 'file', value: Buffer.from(seed.torrentFile).toString('base64') };
      const added = await fixture.post('/api/torrents', input);
      const entry = fixture.app.queue.entries.get(added.body.id);
      if (scenario.mismatch) {
        await waitFor(() => entry.torrent?.infoHash);
        entry.torrent.addPeer(`127.0.0.1:${seeder.address().port}`);
      }
      const fails = scenario.mismatch || scenario.truncate || scenario.missingNeighbor || scenario.saveFailure;
      await waitFor(() => entry.completed || entry.error);
      if (fails) {
        assert.match(entry.error, /cannot be safely reused|does not match verified torrent data|ownership could not be saved/);
        assert.equal(entry.completed, undefined);
        assert.equal(entry.paused, true);
        assert.equal(entry.torrent, null);
      } else {
        assert.equal(entry.error, null);
        assert.equal(entry.completed, true);
      }
      if (scenario.mismatch) await waitFor(() => seeder.torrents[0].numPeers === 0);
      else assert.equal(seeder.torrents[0].numPeers, 0);
      assert.deepEqual(await readdir(path.join(fixture.root, 'downloads')), []);
      for (const { target, content, stat } of existing) {
        assert.deepEqual(await readFile(target), content);
        const current = await fs.lstat(target, { bigint: true });
        assert.equal(current.ino, stat.ino);
        assert.equal(current.mtimeNs, stat.mtimeNs);
        if (fails) {
          const key = fixture.app.queue.fileKey(path.relative(path.join(fixture.root, 'finished'), target), path.join(fixture.root, 'finished'));
          assert.equal(fixture.app.queue.fileOwners.has(key), false);
        }
      }
    });
  }
});

test('directory-scoped ownership allows identical relative names and survives restart', async t => {
  const fixture = await setup(t);
  const { app, root, post } = fixture;
  const added = await post('/api/torrents', { kind: 'magnet', value: magnet });
  const first = app.queue.entries.get(added.body.id);
  const secondDirectory = path.join(root, 'second');
  app.queue.completedDir = secondDirectory;
  const newer = await post('/api/torrents', { kind: 'magnet', value: `magnet:?xt=urn:btih:${'b'.repeat(40)}` });
  const second = app.queue.entries.get(newer.body.id);
  const files = [{ path: 'same.txt', length: 0 }];
  app.queue.prepareFiles(first, files);
  app.queue.prepareFiles(second, files);
  const alias = path.join(root, 'same-folder-alias');
  await mkdir(first.downloadDirectory, { recursive: true });
  await symlink(first.downloadDirectory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  app.queue.completedDir = alias;
  const third = await app.queue.add({ kind: 'magnet', value: `magnet:?xt=urn:btih:${'c'.repeat(40)}` });
  assert.throws(() => app.queue.prepareFiles(app.queue.entries.get(third.id), files), /already belongs/);
  await app.queue.action(third.id, 'remove');
  await app.queue.action(first.id, 'pause');
  await app.queue.action(second.id, 'pause');
  await app.close();
  const reopened = await fixture.open();
  const queue = reopened.app.queue;
  assert.equal(queue.fileOwners.get(queue.fileKey('same.txt', first.downloadDirectory)), first.infoHash);
  assert.equal(queue.fileOwners.get(queue.fileKey('same.txt', secondDirectory)), second.infoHash);
  assert.equal(queue.describe(queue.entries.get(first.id)).path, first.downloadDirectory);
  assert.equal(queue.describe(queue.entries.get(second.id)).path, secondDirectory);
  await queue.scheduleCompletion(queue.entries.get(first.id), files);
  await queue.scheduleCompletion(queue.entries.get(second.id), files);
  assert.equal((await fs.stat(path.join(first.downloadDirectory, 'same.txt'))).size, 0);
  assert.equal((await fs.stat(path.join(secondDirectory, 'same.txt'))).size, 0);
});

test('version two restores pin unfinished downloads and upgrade relative ownership', async t => {
  const fixture = await setup(t);
  const added = await fixture.post('/api/torrents', { kind: 'magnet', value: magnet });
  await fixture.post(`/api/torrents/${added.body.id}/pause`);
  await fixture.app.close();
  const stateFile = path.join(fixture.root, 'data/queue.json');
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  state.version = 2;
  state.files = { 'legacy.txt': 'a'.repeat(40) };
  for (const record of state.torrents) delete record.downloadDirectory;
  await writeFile(stateFile, JSON.stringify(state));
  const reopened = await fixture.open();
  const queue = reopened.app.queue;
  const entry = queue.entries.get(added.body.id);
  assert.equal(entry.downloadDirectory, path.join(fixture.root, 'downloads'));
  assert.equal(queue.fileOwners.get(queue.fileKey('legacy.txt')), entry.infoHash);
  queue.completedDir = path.join(fixture.root, 'a different selection');
  const content = 'Legacy retained data.';
  await writeFile(path.join(entry.downloadDirectory, 'legacy.txt'), content);
  await queue.scheduleCompletion(entry, [{ path: 'legacy.txt', length: Buffer.byteLength(content) }]);
  assert.equal(entry.completedDirectory, entry.downloadDirectory);
  assert.equal(await readFile(path.join(entry.downloadDirectory, 'legacy.txt'), 'utf8'), content);
  const upgraded = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(upgraded.version, 3);
  assert.equal(upgraded.torrents[0].downloadDirectory, entry.downloadDirectory);
  assert.equal(upgraded.files[queue.fileKey('legacy.txt')], entry.infoHash);
});

test('completion collisions preserve both files and Retry move finishes without reconnecting peers', async t => {
  const fixture = await completedFixture(t, { 'one.txt': 'First verified file.', 'two.txt': 'Second verified file.' });
  const { app, root, entry, files, post } = fixture;
  await mkdir(path.join(root, 'finished'));
  await writeFile(path.join(root, 'finished/two.txt'), 'An unrelated existing file.');
  await app.queue.scheduleCompletion(entry, files);
  assert.match(entry.error, /already exists/);
  assert.equal(entry.paused, true);
  assert.equal(entry.torrent, null);
  assert.equal(await readFile(path.join(root, 'downloads/one.txt'), 'utf8'), 'First verified file.');
  assert.equal(await readFile(path.join(root, 'downloads/two.txt'), 'utf8'), 'Second verified file.');
  assert.equal(await readFile(path.join(root, 'finished/two.txt'), 'utf8'), 'An unrelated existing file.');
  assert.deepEqual(await readdir(path.join(root, 'finished')), ['two.txt']);
  assert.equal((await post(`/api/torrents/${entry.id}/remove`)).status, 409);
  await rename(path.join(root, 'finished/two.txt'), path.join(root, 'retained-unrelated.txt'));
  assert.equal((await post(`/api/torrents/${entry.id}/resume`)).status, 200);
  await waitFor(() => entry.completed);
  assert.equal(app.queue.client.torrents.length, 0);
  assert.deepEqual(await readdir(path.join(root, 'downloads')), []);
  assert.deepEqual(await readdir(path.join(root, 'finished')), ['one.txt', 'two.txt']);
  assert.equal(await readFile(path.join(root, 'retained-unrelated.txt'), 'utf8'), 'An unrelated existing file.');
});

test('cross-volume completion uses a bounded copy and removes only its original and temporary files', async t => {
  const content = 'Cross-volume verified data.\n'.repeat(10000);
  const { app, root, entry, files } = await completedFixture(t, { 'copy.txt': content });
  const link = fs.link;
  let copied = false;
  fs.link = async (source, target) => {
    if (source === path.join(root, 'downloads/copy.txt')) {
      copied = true;
      throw Object.assign(new Error('Different filesystem'), { code: 'EXDEV' });
    }
    return link(source, target);
  };
  const watchdog = globalThis.setTimeout(() => app.queue.moveAbort.abort(new Error('Copy did not finish')), 4000);
  try {
    await app.queue.scheduleCompletion(entry, files);
  } finally {
    clearTimeout(watchdog);
    fs.link = link;
  }
  assert.equal(entry.error, null);
  assert.equal(copied, true);
  assert.equal(entry.completed, true);
  assert.equal(await readFile(path.join(root, 'finished/copy.txt'), 'utf8'), content);
  assert.deepEqual(await readdir(path.join(root, 'finished')), ['copy.txt']);
  assert.deepEqual(await readdir(path.join(root, 'downloads')), []);
});

test('moving files keep the server awake and graceful shutdown waits for the move', async t => {
  const { app, root, entry, files, post, url } = await completedFixture(t, undefined, { idleTimeoutMs: 100 });
  const stage = app.queue.stageCompletedFile;
  let release;
  let started;
  const blocked = new Promise(resolve => { release = resolve; });
  const watchdog = globalThis.setTimeout(() => release(), 3000);
  const entered = new Promise(resolve => { started = resolve; });
  app.queue.stageCompletedFile = async function (...args) { started(); await blocked; return stage.apply(this, args); };
  const task = app.queue.scheduleCompletion(entry, files);
  await entered;
  await setTimeout(160);
  assert.equal(app.server.listening, true);
  assert.equal(app.queue.client.torrents.length, 0);
  assert.equal((await (await fetch(url + '/api/torrents')).json()).idleShutdownAt, null);
  assert.equal((await post(`/api/torrents/${entry.id}/remove`)).status, 409);
  assert.equal((await post(`/api/torrents/${entry.id}/resume`)).body.status, 'Moving');
  let stopped = false;
  const closing = app.close().then(() => { stopped = true; });
  await setTimeout(30);
  assert.equal(stopped, false);
  release();
  await task;
  await closing;
  clearTimeout(watchdog);
  assert.equal(entry.completed, true);
  assert.equal(stopped, true);
  assert.equal(JSON.parse(await readFile(path.join(root, 'data/queue.json'), 'utf8')).torrents[0].completed, true);
  assert.equal((await readdir(path.join(root, 'data'))).includes('queue.lock'), false);
});

test('a failed final save leaves a recoverable move journal after the files have moved', async t => {
  const fixture = await completedFixture(t);
  const { app, root, entry, files } = fixture;
  const save = app.queue.save;
  app.queue.save = function (records = this.entries.values()) {
    const list = [...records];
    if (list.some(record => record.completed)) throw new Error('Final save failed');
    return save.call(this, list);
  };
  await app.queue.scheduleCompletion(entry, files);
  assert.match(entry.error, /Final save failed/);
  assert.equal(entry.completed, undefined);
  assert.ok(entry.transfer.files[0].identity);
  assert.deepEqual(await readdir(path.join(root, 'downloads')), []);
  assert.equal(await readFile(path.join(root, 'finished/complete.txt'), 'utf8'), 'A verified completion fixture.');
  app.queue.save = save;
  await app.close();
  const reopened = await fixture.open();
  const restored = reopened.app.queue.entries.get(entry.id);
  await waitFor(() => restored.completed);
  assert.equal(restored.error, null);
  assert.equal(reopened.app.queue.client.torrents.length, 0);
  assert.deepEqual(await readdir(path.join(root, 'finished')), ['complete.txt']);
});

test('completion journal save failure stops seeding without moving source data', async t => {
  const { app, root, entry, files } = await completedFixture(t);
  const save = app.queue.save;
  app.queue.save = () => { throw new Error('Move journal save failed'); };
  try {
    await app.queue.scheduleCompletion(entry, files);
    assert.match(entry.error, /Move journal save failed/);
    assert.equal(entry.torrent, null);
    assert.equal(entry.paused, true);
    assert.equal(await readFile(path.join(root, 'downloads/complete.txt'), 'utf8'), 'A verified completion fixture.');
    assert.equal((await readdir(root)).includes('finished'), false);
  } finally {
    app.queue.save = save;
  }
});

test('interrupted copies are restored from verified sources, not accepted by file size alone', async t => {
  const content = 'Correct recovery contents.\n'.repeat(1000);
  const fixture = await completedFixture(t, { 'recovered.txt': content });
  const { app, root, entry, files } = fixture;
  const directory = path.join(root, 'finished');
  await mkdir(directory);
  const source = path.join(root, 'downloads/recovered.txt');
  const staging = path.join(directory, `.light-torrent-${entry.id}-0.part`);
  await writeFile(staging, Buffer.alloc(Buffer.byteLength(content), 120));
  const sourceStat = await fs.lstat(source, { bigint: true });
  const stagingStat = await fs.lstat(staging, { bigint: true });
  entry.transfer = { directory, files: [{ ...files[0],
    source: { dev: String(sourceStat.dev), ino: String(sourceStat.ino), mtime: String(sourceStat.mtimeNs) },
    identity: { dev: String(stagingStat.dev), ino: String(stagingStat.ino) }, ready: false }] };
  entry.paused = true;
  app.queue.save();
  await app.close();
  const reopened = await fixture.open();
  const restored = reopened.app.queue.entries.get(entry.id);
  await waitFor(() => restored.completed);
  assert.equal(restored.error, null);
  assert.equal(await readFile(path.join(directory, 'recovered.txt'), 'utf8'), content);
  assert.deepEqual(await readdir(directory), ['recovered.txt']);
  assert.deepEqual(await readdir(path.join(root, 'downloads')), []);
});

test('zero-length files complete and an already-final download directory needs no move', async t => {
  const { app, root, entry, files } = await completedFixture(t, { 'nested/empty.txt': '' });
  app.queue.completedDir = path.join(root, 'downloads');
  await app.queue.scheduleCompletion(entry, files);
  assert.equal(entry.completed, true);
  assert.equal(entry.progress, 1);
  assert.equal(entry.length, 0);
  assert.equal(entry.completedDirectory, path.join(root, 'downloads'));
  assert.equal(await readFile(path.join(root, 'downloads/nested/empty.txt'), 'utf8'), '');
  assert.equal((await readdir(root)).includes('finished'), false);
});

test('a destination edited after an interrupted install is retained and cannot consume the original source', async t => {
  const { app, root, entry, files, post } = await completedFixture(t);
  const directory = path.join(root, 'finished');
  const source = path.join(root, 'downloads/complete.txt');
  const target = path.join(directory, 'complete.txt');
  await mkdir(directory);
  await writeFile(target, 'A verified completion fixture.');
  const sourceStat = await fs.lstat(source, { bigint: true });
  const targetStat = await fs.lstat(target, { bigint: true });
  entry.transfer = { directory, files: [{ ...files[0], ready: true,
    source: { dev: String(sourceStat.dev), ino: String(sourceStat.ino), mtime: String(sourceStat.mtimeNs) },
    identity: { dev: String(targetStat.dev), ino: String(targetStat.ino), mtime: String(targetStat.mtimeNs) } }] };
  app.queue.save();
  const edited = 'x'.repeat(files[0].length);
  await writeFile(target, edited);
  await utimes(target, new Date(), new Date(Date.now() + 1000));
  await app.queue.scheduleCompletion(entry);
  assert.match(entry.error, /already exists/);
  assert.equal(await readFile(source, 'utf8'), 'A verified completion fixture.');
  assert.equal(await readFile(target, 'utf8'), edited);
  await rename(target, path.join(root, 'edited-retained.txt'));
  await post(`/api/torrents/${entry.id}/resume`);
  await waitFor(() => entry.completed);
  assert.equal(await readFile(target, 'utf8'), 'A verified completion fixture.');
  assert.equal(await readFile(path.join(root, 'edited-retained.txt'), 'utf8'), edited);
});

test('destination symbolic links are not overwritten and loss of ownership cancels a pending move', async t => {
  const { app, root, entry, files } = await completedFixture(t);
  await mkdir(path.join(root, 'finished'));
  await writeFile(path.join(root, 'foreign.txt'), 'Keep this unrelated file.');
  await symlink(process.platform === 'win32' ? root : path.join(root, 'foreign.txt'),
    path.join(root, 'finished', 'complete.txt'), process.platform === 'win32' ? 'junction' : 'file');
  await app.queue.scheduleCompletion(entry, files);
  assert.match(entry.error, /already exists/);
  assert.equal(await readFile(path.join(root, 'foreign.txt'), 'utf8'), 'Keep this unrelated file.');
  await rm(path.join(root, 'finished/complete.txt'));
  const stage = app.queue.stageCompletedFile;
  let release;
  let started;
  const blocked = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const watchdog = globalThis.setTimeout(() => release(), 3000);
  app.queue.stageCompletedFile = async function (...args) { started(); await blocked; return stage.apply(this, args); };
  const task = app.queue.scheduleCompletion(entry);
  await entered;
  const saved = await readFile(app.queue.stateFile, 'utf8');
  const failure = new Error('Queue ownership lost during move');
  app.queue.persistenceError = failure;
  app.queue.moveAbort.abort(failure);
  release();
  await task;
  clearTimeout(watchdog);
  assert.match(entry.error, /ownership lost/);
  assert.equal(await readFile(app.queue.stateFile, 'utf8'), saved);
  assert.equal(await readFile(path.join(root, 'downloads/complete.txt'), 'utf8'), 'A verified completion fixture.');
  assert.deepEqual(await readdir(path.join(root, 'finished')), []);
  delete app.queue.persistenceError;
});

test('claims shared paths safely, preserves legacy copies, and never overwrites unknown files', async t => {
  const { app, root, post } = await setup(t);
  const queue = app.queue;
  const downloads = path.join(root, 'downloads');
  const added = await post('/api/torrents', { kind: 'magnet', value: magnet });
  const entry = queue.entries.get(added.body.id);
  delete entry.downloadDirectory;
  const files = [{ path: 'bundle/nested/file.txt' }];
  const old = path.join(downloads, entry.id);
  entry.legacyDirectory = entry.id;
  await mkdir(path.join(old, 'bundle/nested'), { recursive: true });
  await writeFile(path.join(old, files[0].path), 'retained partial data');
  queue.prepareFiles(entry, files);
  assert.equal(entry.legacyDirectory, undefined);
  assert.equal(await readFile(path.join(downloads, files[0].path), 'utf8'), 'retained partial data');
  assert.deepEqual(await readdir(downloads), ['bundle']);
  assert.throws(() => queue.prepareFiles({ infoHash: 'b'.repeat(40) }, files), /already belongs/);
  assert.throws(() => queue.prepareFiles({ infoHash: 'b'.repeat(40) }, [{ path: 'bundle' }]), /blocked/);
  assert.throws(() => queue.prepareFiles(entry, [{ path: '../escape.txt' }]), /outside/);
  assert.throws(() => queue.prepareFiles(entry, [{ path: 'colon:name.txt' }]), /unsupported/);
  if (process.platform === 'darwin' || process.platform === 'win32') {
    assert.throws(() => queue.prepareFiles({ infoHash: 'b'.repeat(40) }, [{ path: 'BUNDLE/nested/FILE.txt' }]), /already belongs/);
  }
  await mkdir(old);
  await writeFile(path.join(old, 'unknown.txt'), 'old copy');
  await writeFile(path.join(downloads, 'unknown.txt'), 'unrecognized root copy');
  entry.legacyDirectory = entry.id;
  assert.throws(() => queue.prepareFiles(entry, [{ path: 'unknown.txt' }]), /cannot be safely reused/);
  assert.equal(await readFile(path.join(old, 'unknown.txt'), 'utf8'), 'old copy');
  assert.equal(await readFile(path.join(downloads, 'unknown.txt'), 'utf8'), 'unrecognized root copy');
  await mkdir(path.join(old, 'bundle/nested'), { recursive: true });
  await writeFile(path.join(old, files[0].path), 'another retained copy');
  queue.prepareFiles(entry, files);
  assert.equal(await readFile(path.join(old, files[0].path), 'utf8'), 'another retained copy');
  assert.equal(await readFile(path.join(downloads, files[0].path), 'utf8'), 'retained partial data');
  await symlink(old, path.join(downloads, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => queue.prepareFiles(entry, [{ path: 'linked/new.txt' }]), /symbolic link/);
  const save = queue.save;
  queue.save = () => { throw new Error('Ownership save failed'); };
  assert.throws(() => queue.prepareFiles(entry, [{ path: 'another.txt' }]), /Ownership save failed/);
  assert.equal(queue.fileOwners.has(queue.fileKey('another.txt')), false);
  assert.equal((await readdir(downloads)).includes('another.txt'), false);
  queue.save = save;
  queue.prepareFiles(entry, [{ path: 'reserved' }]);
  assert.throws(() => queue.prepareFiles({ infoHash: 'b'.repeat(40) }, [{ path: 'reserved/child.txt' }]), /Conflicting file and directory/);
  queue.prepareFiles(entry, [{ path: 'future/child.txt' }]);
  assert.throws(() => queue.prepareFiles({ infoHash: 'b'.repeat(40) }, [{ path: 'future' }]), /Conflicting file and directory/);
});

test('releases missing unqueued paths atomically but protects queued owners and normalized retained names', async t => {
  const { app, root, post } = await setup(t);
  const queue = app.queue;
  const first = await post('/api/torrents', { kind: 'magnet', value: magnet });
  const owner = queue.entries.get(first.body.id);
  delete owner.downloadDirectory;
  const second = await post('/api/torrents', { kind: 'magnet', value: `magnet:?xt=urn:btih:${'b'.repeat(40)}` });
  const replacement = queue.entries.get(second.body.id);
  delete replacement.downloadDirectory;
  const files = [{ path: 'missing.txt' }, { path: 'missing-directory/child.txt' }];
  queue.prepareFiles(owner, files);
  await post(`/api/torrents/${owner.id}/pause`);
  assert.throws(() => queue.prepareFiles(replacement, files), /already belongs/);
  owner.error = 'Simulated failure';
  assert.throws(() => queue.prepareFiles(replacement, files), /already belongs/);
  await post(`/api/torrents/${owner.id}/remove`);
  const saved = await readFile(queue.stateFile, 'utf8');
  const save = queue.save;
  queue.save = () => { throw new Error('Cannot save reclaimed ownership'); };
  assert.throws(() => queue.prepareFiles(replacement, [{ path: 'missing.txt' }, { path: 'missing-directory' }]), /Cannot save/);
  assert.equal(queue.fileOwners.get(queue.fileKey('missing.txt')), owner.infoHash);
  assert.equal(await readFile(queue.stateFile, 'utf8'), saved);
  queue.save = save;
  queue.prepareFiles(replacement, [{ path: 'missing.txt' }, { path: 'missing-directory' }]);
  assert.equal(queue.fileOwners.get(queue.fileKey('missing.txt')), replacement.infoHash);
  assert.equal(queue.fileOwners.has(queue.fileKey('missing-directory/child.txt')), false);
  const state = JSON.parse(await readFile(queue.stateFile, 'utf8'));
  assert.equal(state.files[queue.fileKey('missing.txt')], replacement.infoHash);
  await mkdir(path.join(root, 'downloads', 'was-file'));
  queue.fileOwners.set(queue.fileKey('was-file'), owner.infoHash);
  queue.save();
  queue.prepareFiles(replacement, [{ path: 'was-file/child.txt' }]);
  assert.equal(queue.fileOwners.has(queue.fileKey('was-file')), false);
  assert.equal(queue.fileOwners.get(queue.fileKey('was-file/child.txt')), replacement.infoHash);

  const filename = 'Caf\u00e9.txt'.normalize('NFD');
  const retained = path.join(root, 'downloads', filename);
  await writeFile(retained, 'Preserve this retained file.');
  queue.fileOwners.set(queue.fileKey(filename), owner.infoHash);
  queue.save();
  const fileStat = queue.fileStat;
  // Exercise normalized-name lookup even on a case-insensitive filesystem.
  const canonical = queue.fileKey(filename);
  queue.fileStat = file => file === canonical ? null : fileStat.call(queue, file);
  assert.throws(() => queue.prepareFiles(replacement, [{ path: filename }]), /already belongs/);
  queue.fileStat = fileStat;
  assert.equal(queue.fileOwners.get(queue.fileKey(filename)), owner.infoHash);
  assert.equal(await readFile(retained, 'utf8'), 'Preserve this retained file.');
  queue.fileStat = () => { throw Object.assign(new Error('Permission denied'), { code: 'EACCES' }); };
  assert.throws(() => queue.prepareFiles(replacement, [{ path: filename }]), { code: 'EACCES' });
  assert.equal(queue.fileOwners.get(queue.fileKey(filename)), owner.infoHash);
  queue.fileStat = fileStat;
  await rm(retained);
  queue.prepareFiles(replacement, [{ path: filename }]);
  assert.equal(queue.fileOwners.get(queue.fileKey(filename)), replacement.infoHash);
});

test('multi-file downloads preserve torrent structure and legacy queue restores migrate partial files', async t => {
  const fixture = await setup(t);
  fixture.app.queue.completedDir = path.join(fixture.root, 'downloads');
  const seeder = new WebTorrent(offline);
  t.after(() => new Promise(resolve => seeder.destroy(resolve)));
  const source = path.join(fixture.root, 'bundle');
  await mkdir(path.join(source, 'nested'), { recursive: true });
  const content = Buffer.from('Multi-file torrent fixture.\n'.repeat(3000));
  await writeFile(path.join(source, 'one.txt'), content);
  await writeFile(path.join(source, 'nested/two.txt'), content);
  const seed = await new Promise((resolve, reject) => {
    seeder.once('error', reject);
    seeder.seed(source, { announce: [] }, resolve).once('error', reject);
  });
  const added = await fixture.post('/api/torrents', { kind: 'file', value: Buffer.from(seed.torrentFile).toString('base64') });
  const entry = fixture.app.queue.entries.get(added.body.id);
  await waitFor(() => entry.torrent.ready);
  const downloads = path.join(fixture.root, 'downloads');
  await fixture.post(`/api/torrents/${entry.id}/pause`);
  await mkdir(path.join(downloads, 'bundle/nested'), { recursive: true });
  await writeFile(path.join(downloads, 'bundle/one.txt'), content);
  await writeFile(path.join(downloads, 'bundle/nested/two.txt'), content);
  await fixture.app.close();
  const old = path.join(downloads, entry.id);
  await mkdir(old);
  await rename(path.join(downloads, 'bundle'), path.join(old, 'bundle'));
  // A truncated legacy file must be preserved and verified, not treated as complete.
  const partial = content.subarray(0, 20000);
  await writeFile(path.join(old, 'bundle/one.txt'), partial);
  const stateFile = path.join(fixture.root, 'data/queue.json');
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  state.version = 1;
  delete state.files;
  for (const record of state.torrents) delete record.downloadDirectory;
  await writeFile(stateFile, JSON.stringify(state));
  const reopened = await fixture.open();
  assert.equal(reopened.app.queue.snapshot().torrents[0].status, 'Paused');
  assert.deepEqual(await readdir(downloads), ['bundle']);
  assert.deepEqual(await readFile(path.join(downloads, 'bundle/one.txt')), partial);
  await reopened.post(`/api/torrents/${entry.id}/resume`);
  const restored = reopened.app.queue.entries.get(entry.id);
  await waitFor(() => restored.torrent.ready);
  assert.equal(restored.torrent.done, false);
  restored.torrent.addPeer(`127.0.0.1:${seeder.address().port}`);
  await waitFor(() => restored.completed);
  assert.deepEqual(await readFile(path.join(downloads, 'bundle/one.txt')), content);
  assert.deepEqual(await readFile(path.join(downloads, 'bundle/nested/two.txt')), content);
  assert.deepEqual(await readdir(downloads), ['bundle']);
  assert.equal(restored.completedDirectory, downloads);
});

test('metadata path conflicts stop the engine before existing data can be changed, even after removal', async t => {
  const fixture = await setup(t);
  const seeder = new WebTorrent(offline);
  t.after(() => new Promise(resolve => seeder.destroy(resolve)));
  const uploads = [];
  for (const [index, text] of ['First content.', 'Different content.'].entries()) {
    const directory = path.join(fixture.root, `seed-${index}`);
    await mkdir(directory);
    const file = path.join(directory, 'shared.txt');
    await writeFile(file, text);
    const torrent = await new Promise((resolve, reject) => {
      seeder.once('error', reject);
      seeder.seed(file, { announce: [] }, resolve).once('error', reject);
    });
    uploads.push({ kind: 'file', value: Buffer.from(torrent.torrentFile).toString('base64') });
  }
  const first = await fixture.post('/api/torrents', uploads[0]);
  const original = fixture.app.queue.entries.get(first.body.id);
  await waitFor(() => original.torrent.ready);
  await fixture.post(`/api/torrents/${original.id}/pause`);
  const target = path.join(fixture.root, 'finished/shared.txt');
  await writeFile(target, 'First content.');
  const second = await fixture.post('/api/torrents', uploads[1]);
  const conflict = fixture.app.queue.entries.get(second.body.id);
  await waitFor(() => conflict.error);
  assert.match(conflict.error, /already belongs/);
  assert.equal(conflict.torrent, null);
  assert.equal(conflict.paused, true);
  assert.equal(await readFile(target, 'utf8'), 'First content.');
  await fixture.post(`/api/torrents/${conflict.id}/remove`);
  await fixture.post(`/api/torrents/${original.id}/remove`);
  await fixture.app.close();
  const reopened = await fixture.open();
  const retry = await reopened.post('/api/torrents', uploads[1]);
  await waitFor(() => reopened.app.queue.entries.get(retry.body.id).error);
  assert.equal(await readFile(target, 'utf8'), 'First content.');
});

test('uploads a .torrent file and fails explicitly on corrupt persisted state', async t => {
  const fixture = await setup(t);
  const seeder = new WebTorrent(offline);
  t.after(() => new Promise(resolve => seeder.destroy(resolve)));
  const sourcePath = path.join(fixture.root, 'upload.txt');
  await writeFile(sourcePath, 'A file upload fixture.');
  const seed = await new Promise((resolve, reject) => {
    seeder.once('error', reject);
    seeder.seed(sourcePath, { announce: [] }, resolve).once('error', reject);
  });
  const added = await fixture.post('/api/torrents', {
    kind: 'file', value: Buffer.from(seed.torrentFile).toString('base64')
  });
  assert.equal(added.status, 201);
  assert.equal(added.body.name, 'upload.txt');
  await fixture.app.close();
  await writeFile(path.join(fixture.root, 'data', 'queue.json'), '{broken');
  await assert.rejects(fixture.open(), /Unable to restore queue/);
});
