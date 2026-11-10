import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { PassThrough, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchAgent, safariManifest } from '../safari/install.js';
import { runSafariHost } from '../safari/host.js';

test('Safari packaging preserves shared resources and replaces unsupported static injection', async () => {
  const original = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  const manifest = safariManifest(original);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.minimum_chrome_version, undefined);
  assert.equal(manifest.background.service_worker, 'safari-background.js');
  assert.deepEqual(manifest.permissions, ['nativeMessaging', 'scripting']);
  assert.deepEqual(manifest.host_permissions, ['http://*/*', 'https://*/*']);
  assert.equal(manifest.browser_specific_settings.safari.strict_min_version, '18.4');
  assert.deepEqual(manifest.action, original.action);
  assert.deepEqual(manifest.icons, original.icons);
  assert.equal(original.content_scripts[1].world, 'MAIN');
});

test('launch agent is on demand, safely escapes paths, and invokes only the installed helper', () => {
  const plist = launchAgent('/Users/a & b/Applications/Light Torrent Safari.app', '/Users/a & b/helper.log');
  assert.match(plist, /<key>MachServices<\/key>/);
  assert.match(plist, /com\.lighttorrent\.safari\.launcher/);
  assert.match(plist, /a &amp; b\/Applications/);
  assert.match(plist, /Light Torrent Helper\.app\/Contents\/MacOS/);
  assert.match(plist, /<string>--native-host<\/string>/);
  assert.doesNotMatch(plist, /RunAtLoad|KeepAlive|Sockets/);
});

async function registration(existing = [], error = null) {
  const registered = [];
  const updated = [];
  const errors = [];
  const context = vm.createContext({
    importScripts(name) { assert.equal(name, 'background.js'); },
    LightTorrentBridge: { api: { scripting: {
      async getRegisteredContentScripts() {
        if (error) throw error;
        return existing;
      },
      async registerContentScripts(scripts) { registered.push(...scripts); },
      async updateContentScripts(scripts) { updated.push(...scripts); }
    } } },
    console: { error: (...args) => errors.push(args) }
  });
  vm.runInContext(await readFile(new URL('../extension/safari-background.js', import.meta.url), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  return { registered, updated, errors };
}

test('Safari registers main-world shadow hooks and isolated content scripts at document start', async () => {
  const { registered, updated, errors } = await registration();
  assert.equal(registered.length, 2);
  assert.equal(updated.length, 0);
  assert.equal(errors.length, 0);
  assert.equal(registered[0].world, 'MAIN');
  assert.deepEqual([...registered[0].js], ['shadow-roots.js']);
  assert.equal(registered[1].world, 'ISOLATED');
  assert.deepEqual([...registered[1].js], ['shared.js', 'content.js']);
  for (const script of registered) {
    assert.equal(script.runAt, 'document_start');
    assert.equal(script.allFrames, true);
    assert.equal(script.matchOriginAsFallback, true);
    assert.equal(script.persistAcrossSessions, true);
    assert.deepEqual([...script.matches], ['http://*/*', 'https://*/*']);
  }
});

test('Safari updates existing registrations without duplicating them and reports registration errors', async () => {
  const fixture = await registration([{ id: 'light-torrent-shadow-roots' }, { id: 'light-torrent-magnets' }]);
  assert.equal(fixture.registered.length, 0);
  assert.equal(fixture.updated.length, 2);
  const failed = await registration([], new Error('Permission denied'));
  assert.equal(failed.registered.length, 0);
  assert.match(failed.errors[0][1].message, /Permission denied/);
});

async function nativeExchange(action, directory, launch) {
  const input = new PassThrough();
  const messages = [];
  const output = new Writable({
    write(chunk, encoding, callback) {
      const message = JSON.parse(chunk.toString());
      messages.push(message);
      if (message.type === 'choose-folder') input.write(JSON.stringify({ directory }) + '\n');
      callback();
    }
  });
  const pending = runSafariHost({ input, output, launch });
  input.write(JSON.stringify({ action }) + '\n');
  const response = await pending;
  input.destroy();
  return { messages, response };
}

test('Safari native host reuses launcher actions and gets folder choices from the macOS app', async () => {
  for (const action of ['start-client', 'change-folder']) {
    const result = await nativeExchange(action, '/tmp/Safari downloads', async options => {
      assert.equal(options.selectAgain, action === 'change-folder' ? true : undefined);
      assert.equal(await options.chooseDirectory(), '/tmp/Safari downloads');
      return { started: true };
    });
    assert.equal(result.messages[0].type, 'choose-folder');
    assert.deepEqual(result.response, { ok: true, started: true });
    assert.equal(result.messages.at(-1).type, 'result');
  }
});

test('Safari folder cancellation and invalid native actions fail explicitly without launching', async () => {
  const canceled = await nativeExchange('change-folder', null, async options => {
    await options.chooseDirectory();
    assert.fail('Canceled selection must not continue startup.');
  });
  assert.equal(canceled.response.ok, false);
  assert.match(canceled.response.error, /Folder selection canceled/);
  const invalid = await nativeExchange('exec', null, async () => assert.fail('Invalid action must not launch.'));
  assert.equal(invalid.messages.length, 1);
  assert.match(invalid.response.error, /Only the start-client/);
  const badFolder = await nativeExchange('start-client', 'relative/path', async options => options.chooseDirectory());
  assert.match(badFolder.response.error, /invalid response/);
});

test('real Safari host returns a JSON failure and exits when its input closes', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../safari/host.js', import.meta.url))],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  child.stdin.end('{"action":"exec"}\n');
  assert.equal(await exited, 1);
  const result = JSON.parse(Buffer.concat(stdout).toString());
  assert.equal(result.type, 'result');
  assert.equal(result.response.ok, false);
  assert.match(result.response.error, /Only the start-client/);
  assert.match(Buffer.concat(stderr).toString(), /Safari native helper failed/);
});
