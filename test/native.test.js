import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { readMessage, writeMessage, handleRequest } from '../native/host.js';
import { isClientReady, startClient } from '../native/launcher.js';
import { installHelper, hostName } from '../native/install.js';

const root = fileURLToPath(new URL('..', import.meta.url));

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

test('installer registers only the requested extension and safely quotes executable paths', async t => {
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
  await assert.rejects(installHelper({ extensionId: 'invalid', home, platform: 'darwin' }), /extension ID/);
  await assert.rejects(installHelper({ extensionId, home, platform: 'linux' }), /macOS/);
  await assert.rejects(installHelper({ extensionId, home, platform: 'darwin', browser: 'unknown' }), /Browser/);
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
      writeFileSync('last-request', request.url);
      response.setHeader('Content-Type', 'application/json');
      response.setHeader('Connection', 'close');
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
      const pid = Number(await readFile(pidPath, 'utf8'));
      process.kill(pid, 'SIGTERM');
      const deadline = Date.now() + 5000;
      while (await isClientReady(url)) {
        if (Date.now() > deadline) throw new Error('Fixture process did not stop.');
        await setTimeout(20);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  assert.equal(await isClientReady(url), false);
  const options = { cwd, url, serverPath, logPath };
  assert.deepEqual(await startClient(options), { started: true });
  assert.deepEqual(await startClient(options), { started: false });
  assert.equal(await readFile(path.join(cwd, 'last-request'), 'utf8'), '/api/health?open=1');
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

test('launcher surfaces failed startup and points to the client log', async t => {
  const cwd = await temporary(t);
  const port = await freePort();
  const serverPath = path.join(cwd, 'server.mjs');
  const logPath = path.join(cwd, 'logs', 'client.log');
  await writeFile(serverPath, "console.error('Fixture startup failure'); process.exit(17);");
  await assert.rejects(startClient({
    cwd, serverPath, logPath, url: `http://127.0.0.1:${port}`, timeoutMs: 500
  }), error => /process exit 17/.test(error.message) && error.message.includes(logPath));
  assert.match(await readFile(logPath, 'utf8'), /Fixture startup failure/);
});
