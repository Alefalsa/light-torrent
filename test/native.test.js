import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import http from 'node:http';
import { copyFile, link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readMessage, writeMessage, handleRequest } from '../native/host.js';
import { clientLogPath, isClientReady, startClient } from '../native/launcher.js';
import { browserRegistryKeys, installHelper, hostName } from '../native/install.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const execute = promisify(execFile);

function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

async function temporary(t) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'light-torrent-native-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('native protocol handles split frames and writes exactly one framed response', async () => {
  const input = frame({ action: 'start-client' });
  assert.deepEqual(await readMessage(Readable.from([input.subarray(0, 2), input.subarray(2, 7), input.subarray(7)])),
    { action: 'start-client' });
  const chunks = [];
  const output = new Writable({ write(chunk, encoding, callback) { chunks.push(chunk); callback(); } });
  await writeMessage(output, { ok: true, started: false });
  assert.deepEqual(Buffer.concat(chunks), frame({ ok: true, started: false }));
});

test('native protocol rejects bad framing, invalid JSON, and arbitrary commands', async () => {
  const oversize = Buffer.alloc(4);
  oversize.writeUInt32LE(4097);
  for (const input of [Buffer.from([1]), oversize, frame({}).subarray(0, 5), Buffer.concat([frame({}), frame({})])]) {
    await assert.rejects(readMessage(Readable.from([input])));
  }
  const invalidJson = Buffer.from([2, 0, 0, 0, 123, 123]);
  await assert.rejects(readMessage(Readable.from([invalidJson])), SyntaxError);
  let launches = 0;
  for (const request of [null, {}, { action: 'exec' }, { action: 'start-client', command: 'anything' },
    { action: 'start-client', magnet: 'magnet:?' }]) {
    await assert.rejects(handleRequest(request, async () => { launches++; }));
  }
  assert.equal(launches, 0);
  assert.deepEqual(await handleRequest({ action: 'start-client' }, async () => ({ started: false })),
    { ok: true, started: false });
});

test('real native host emits framed failures, never unframed stdout', async () => {
  const child = spawn(process.execPath, [path.join(root, 'native', 'host.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  child.stdin.end(frame({ action: 'unknown' }));
  assert.equal(await exited, 1);
  const response = await readMessage(Readable.from([Buffer.concat(stdout)]));
  assert.equal(response.ok, false);
  assert.match(response.error, /Only the start-client/);
  assert.match(Buffer.concat(stderr).toString(), /Only the start-client/);
});

test('macOS installer registers only the requested extension and safely quotes executable paths',
  { skip: process.platform === 'win32' }, async t => {
  const home = await temporary(t);
  const executable = path.join(home, "node's executable");
  await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const extensionId = 'a'.repeat(32);
  const installed = await installHelper({ extensionId, home, executable, root, platform: 'darwin' });
  const manifest = JSON.parse(await readFile(installed.manifestPath, 'utf8'));
  assert.equal(manifest.name, hostName);
  assert.equal(manifest.path, installed.launcher);
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionId}/`]);
  assert.equal((await stat(installed.launcher)).mode & 0o777, 0o700);
  assert.equal((await stat(installed.manifestPath)).mode & 0o777, 0o600);
  const child = spawn(installed.launcher, [], { stdio: 'ignore' });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, 0);
});

test('installer rejects unsupported platforms, extension IDs, and browsers before registering', async t => {
  const home = await temporary(t);
  const extensionId = 'a'.repeat(32);
  for (const platform of ['darwin', 'win32']) {
    await assert.rejects(installHelper({ extensionId: 'invalid', home, platform }), /extension ID/);
    await assert.rejects(installHelper({ extensionId, home, platform, browser: 'unknown' }), /Browser/);
  }
  await assert.rejects(installHelper({ extensionId, home, platform: 'linux' }), /macOS and Windows/);
});

test('Windows installer keeps browser manifests separate and registers their per-user paths', async t => {
  const home = await temporary(t);
  const calls = [];
  const manifests = new Set();
  for (const [index, browser] of Object.keys(browserRegistryKeys).entries()) {
    const extensionId = String.fromCharCode(97 + index).repeat(32);
    const installed = await installHelper({
      extensionId, browser, home, root, platform: 'win32', localAppData: path.join(home, 'AppData', 'Local'),
      run: async (...args) => { calls.push(args); }
    });
    const manifest = JSON.parse(await readFile(installed.manifestPath, 'utf8'));
    assert.equal(manifest.name, hostName);
    assert.equal(manifest.type, 'stdio');
    assert.equal(manifest.path, installed.launcher);
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionId}/`]);
    assert.deepEqual(calls.at(-1), [
      'reg.exe', ['add', `${browserRegistryKeys[browser]}\\${hostName}`, '/ve', '/t', 'REG_SZ',
        '/d', installed.manifestPath, '/f', '/reg:32'], { windowsHide: true }
    ]);
    manifests.add(installed.manifestPath);
  }
  assert.equal(manifests.size, 4);
  let index = 0;
  for (const manifestPath of manifests) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${String.fromCharCode(97 + index++).repeat(32)}/`]);
  }
  await assert.rejects(installHelper({
    extensionId: 'a'.repeat(32), home, root, platform: 'win32', localAppData: home,
    run: async () => { throw new Error('Registry access denied'); }
  }), /Could not register.*Registry access denied/);
});

test('Windows installed batch host preserves framing and handles special and Unicode paths',
  { skip: process.platform !== 'win32' }, async t => {
    const home = await temporary(t);
    const project = path.join(home, "project %PATH% ! & ^ ' \u00e9");
    await mkdir(path.join(project, 'native'), { recursive: true });
    await mkdir(path.join(project, 'lib'), { recursive: true });
    await copyFile(path.join(root, 'native', 'host.js'), path.join(project, 'native', 'host.js'));
    await copyFile(path.join(root, 'native', 'launcher.js'), path.join(project, 'native', 'launcher.js'));
    await copyFile(path.join(root, 'native', 'folders.js'), path.join(project, 'native', 'folders.js'));
    await copyFile(path.join(root, 'lib', 'settings.js'), path.join(project, 'lib', 'settings.js'));
    await writeFile(path.join(project, 'package.json'), '{"type":"module"}');
    await writeFile(path.join(project, 'server.js'), '');
    const executable = path.join(project, "node %PATH% ! & ^ ' \u00e9.exe");
    await link(process.execPath, executable);
    const key = `HKCU\\Software\\LightTorrentTests\\${path.basename(home)}`;
    t.after(() => execute('reg.exe', ['delete', key, '/f', '/reg:32'], { windowsHide: true }));
    const installed = await installHelper({
      extensionId: 'a'.repeat(32), home, executable, root: project, localAppData: home,
      run: (command, args, options) => execute(command, args.map((arg, index) => index === 1 ? key : arg), options)
    });
    const { stdout: registered } = await execute('reg.exe', ['query', key, '/ve', '/reg:32'], { windowsHide: true });
    assert.ok(registered.includes(installed.manifestPath));
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${installed.launcher}""`], {
      windowsVerbatimArguments: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    const exited = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    child.stdin.end(frame({ action: 'unknown' }));
    assert.equal(await exited, 1, Buffer.concat(stderr).toString());
    const response = await readMessage(Readable.from([Buffer.concat(stdout)]));
    assert.equal(response.ok, false);
    assert.match(response.error, /Only the start-client/);
  });

test('client logs use the platform-specific per-user directory', () => {
  const home = path.resolve('test-home');
  const localAppData = path.join(home, 'custom-local-data');
  assert.equal(clientLogPath({ platform: 'win32', home, localAppData }),
    path.join(localAppData, 'Light Torrent', 'Logs', 'client.log'));
  assert.equal(clientLogPath({ platform: 'darwin', home }),
    path.join(home, 'Library', 'Logs', 'Light Torrent', 'client.log'));
});

test('readiness retries connection resets but surfaces unexpected network failures', async t => {
  let failure;
  t.mock.method(globalThis, 'fetch', async () => { throw failure; });
  for (const code of ['ECONNREFUSED', 'ECONNRESET']) {
    failure = new TypeError('fetch failed', { cause: { code } });
    assert.equal(await isClientReady(), false);
  }
  failure = new DOMException('Timed out', 'TimeoutError');
  assert.equal(await isClientReady(), false);
  failure = new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
  await assert.rejects(isClientReady(), /Could not check the local client/);
});

test('launcher starts a detached local process, waits for readiness, and reuses it', async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'light-torrent-native-'));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const serverPath = path.join(cwd, 'server.mjs');
  const logPath = path.join(cwd, 'logs', 'client.log');
  const pidPath = path.join(cwd, 'pid');
  await writeFile(serverPath, `
    import http from 'node:http';
    import { writeFileSync } from 'node:fs';
    const server = http.createServer((request, response) => {
      if (request.url === '/shutdown') {
        response.setHeader('Connection', 'close');
        response.end('Stopping');
        server.close(() => setTimeout(() => process.exit(0), 100));
        return;
      }
      writeFileSync('last-request', request.url);
      response.setHeader('Content-Type', 'application/json');
      response.setHeader('Connection', 'close');
      if (request.url === '/api/settings') {
        response.end(JSON.stringify({ completedDir: process.env.COMPLETED_DIR, token: 'a'.repeat(64) }));
        return;
      }
      response.end(JSON.stringify({ app: 'light-torrent', apiVersion: 1, ready: true }));
    });
    server.listen(Number(process.env.PORT), '127.0.0.1', () => {
      writeFileSync('pid', String(process.pid));
      console.log('Fixture ready');
    });
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  `);
  t.after(async () => {
    try {
      await fetch(url + '/shutdown');
    } finally {
      const pid = Number(await readFile(pidPath, 'utf8'));
      if (await isClientReady(url)) process.kill(pid, 'SIGKILL');
      // Windows keeps the working directory and log locked until the process exits.
      const deadline = Date.now() + 5000;
      while (true) {
        try {
          process.kill(pid, 0);
        } catch (error) {
          if (error.code === 'ESRCH') break;
          throw error;
        }
        if (Date.now() > deadline) throw new Error('Fixture process did not stop.');
        await setTimeout(20);
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });
  assert.equal(await isClientReady(url), false);
  let choices = 0;
  const options = { cwd, url, serverPath, logPath, settingsFile: path.join(cwd, 'settings.json'),
    chooseDirectory: async () => { choices++; return cwd; } };
  assert.deepEqual(await startClient(options), { started: true });
  assert.deepEqual(await startClient(options), { started: false });
  assert.equal(await readFile(path.join(cwd, 'last-request'), 'utf8'), '/api/settings');
  assert.equal(choices, 1);
  assert.match(await readFile(logPath, 'utf8'), /Fixture ready/);
});

test('launcher refuses an unrelated server instead of starting another process', async t => {
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ app: 'another-app' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(startClient({ url }), /another service or an older client/);
});

test('canceling first-use folder selection does not launch a client or create its log', async t => {
  const cwd = await temporary(t);
  const url = `http://127.0.0.1:${await freePort()}`;
  const logPath = path.join(cwd, 'logs', 'client.log');
  await assert.rejects(startClient({
    cwd, url, logPath, settingsFile: path.join(cwd, 'settings.json'),
    chooseDirectory: async () => undefined
  }), /Folder selection canceled/);
  assert.equal(await isClientReady(url), false);
  await assert.rejects(readFile(logPath), error => error.code === 'ENOENT');
});

test('older running clients are reported before opening the first-use picker', async t => {
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url.startsWith('/api/health')) {
      response.end(JSON.stringify({ app: 'light-torrent', apiVersion: 1, ready: true }));
    } else {
      response.writeHead(404);
      response.end(JSON.stringify({ error: 'Not found.' }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  let prompts = 0;
  await assert.rejects(startClient({
    url: `http://127.0.0.1:${server.address().port}`,
    chooseDirectory: async () => { prompts++; return os.homedir(); }
  }), /restarted to support final-folder selection/);
  assert.equal(prompts, 0);
});

test('launcher surfaces failed startup and points to the client log', async t => {
  const cwd = await temporary(t);
  const port = await freePort();
  const serverPath = path.join(cwd, 'server.mjs');
  const logPath = path.join(cwd, 'logs', 'client.log');
  await writeFile(serverPath, "console.error('Fixture startup failure'); process.exit(17);");
  await assert.rejects(startClient({
    cwd, serverPath, logPath, url: `http://127.0.0.1:${port}`, timeoutMs: 500,
    settingsFile: path.join(cwd, 'settings.json'), chooseDirectory: async () => cwd
  }), error => /process exit 17/.test(error.message) && error.message.includes(logPath));
  assert.match(await readFile(logPath, 'utf8'), /Fixture startup failure/);
});
