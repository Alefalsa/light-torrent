import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import { readCompletedDirectory, saveCompletedDirectory, settingsPath, validateCompletedDirectory } from '../lib/settings.js';
import { ensureCompletedDirectory, pickCompletedDirectory } from '../native/folders.js';

async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'light-torrent-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, settingsFile: path.join(root, 'preferences', 'settings.json') };
}

test('folder preferences use per-user Windows and macOS locations', () => {
  const home = path.resolve('home');
  const localAppData = path.join(home, 'local');
  assert.equal(settingsPath({ platform: 'win32', home, localAppData }),
    path.join(localAppData, 'Light Torrent', 'settings.json'));
  assert.equal(settingsPath({ platform: 'darwin', home }),
    path.join(home, 'Library', 'Application Support', 'Light Torrent', 'settings.json'));
});

test('first use saves the selected final folder and subsequent uses do not prompt', async t => {
  const { root, settingsFile } = await temporary(t);
  const folder = path.join(root, "final files ' & \u00e9");
  await mkdir(folder);
  let prompts = 0;
  const options = { settingsFile, chooseDirectory: async () => { prompts++; return folder; } };
  assert.equal(await readCompletedDirectory(settingsFile), undefined);
  assert.equal(await ensureCompletedDirectory(options), folder);
  assert.equal(await ensureCompletedDirectory(options), folder);
  assert.equal(prompts, 1);
  assert.deepEqual(JSON.parse(await readFile(settingsFile, 'utf8')), { version: 1, completedDir: folder });
  assert.deepEqual(await readdir(folder), []);
  assert.deepEqual(await readdir(path.dirname(settingsFile)), ['settings.json']);
});

test('concurrent first-use requests share one saved folder choice', async t => {
  const { root, settingsFile } = await temporary(t);
  let prompts = 0;
  const options = { settingsFile, chooseDirectory: async () => {
    prompts++;
    await setTimeout(30);
    return root;
  } };
  assert.deepEqual(await Promise.all([ensureCompletedDirectory(options), ensureCompletedDirectory(options)]), [root, root]);
  assert.equal(prompts, 1);
});

test('explicit folder changes preserve the old preference on cancellation and replace it atomically on success', async t => {
  const { root, settingsFile } = await temporary(t);
  const next = path.join(root, 'next');
  await mkdir(next);
  await saveCompletedDirectory(root, settingsFile);
  const before = await readFile(settingsFile, 'utf8');
  await assert.rejects(ensureCompletedDirectory({
    settingsFile, selectAgain: true, chooseDirectory: async () => undefined
  }), /selection canceled/);
  assert.equal(await readFile(settingsFile, 'utf8'), before);
  await assert.rejects(ensureCompletedDirectory({
    settingsFile, selectAgain: true, chooseDirectory: async () => path.join(root, 'missing')
  }), /Cannot use/);
  assert.equal(await readFile(settingsFile, 'utf8'), before);
  assert.equal(await ensureCompletedDirectory({
    settingsFile, selectAgain: true, chooseDirectory: async () => next
  }), next);
  assert.equal(await readCompletedDirectory(settingsFile), next);
  assert.deepEqual(await readdir(path.dirname(settingsFile)), ['settings.json']);
});

test('explicit folder changes recover damaged preferences without deleting them first', async t => {
  const { root, settingsFile } = await temporary(t);
  await mkdir(path.dirname(settingsFile));
  await writeFile(settingsFile, 'invalid settings');
  assert.equal(await ensureCompletedDirectory({
    settingsFile, selectAgain: true, chooseDirectory: async () => root
  }), root);
  assert.equal(await readCompletedDirectory(settingsFile), root);
});

test('canceling does not save a preference and the next request prompts again', async t => {
  const { root, settingsFile } = await temporary(t);
  await assert.rejects(ensureCompletedDirectory({ settingsFile, chooseDirectory: async () => undefined }), /selection canceled/);
  assert.equal(await readCompletedDirectory(settingsFile), undefined);
  assert.deepEqual(await readdir(path.dirname(settingsFile)), []);
  assert.equal(await ensureCompletedDirectory({ settingsFile, chooseDirectory: async () => root }), root);
});

test('invalid, missing, or unusable saved folders are reported without silently changing destinations', async t => {
  const { root, settingsFile } = await temporary(t);
  await assert.rejects(validateCompletedDirectory('relative'), /absolute directory/);
  await assert.rejects(validateCompletedDirectory(path.join(root, 'missing')), /Cannot use/);
  const ordinaryFile = path.join(root, 'file.txt');
  await writeFile(ordinaryFile, 'not a directory');
  await assert.rejects(validateCompletedDirectory(ordinaryFile), /not a folder/);
  await mkdir(path.dirname(settingsFile));
  let prompts = 0;
  for (const contents of ['not JSON', '{"version":2,"completedDir":"invalid"}',
    JSON.stringify({ version: 1, completedDir: ordinaryFile })]) {
    await writeFile(settingsFile, contents);
    await assert.rejects(ensureCompletedDirectory({
      settingsFile, chooseDirectory: async () => { prompts++; return root; }
    }), /Invalid download folder settings|not a folder/);
  }
  assert.equal(prompts, 0);
});

test('failed preference installation cleans temporary settings files', async t => {
  const { root, settingsFile } = await temporary(t);
  await mkdir(settingsFile, { recursive: true });
  await assert.rejects(saveCompletedDirectory(root, settingsFile), /Could not save/);
  assert.deepEqual(await readdir(path.dirname(settingsFile)), ['settings.json']);
});

test('Windows folder picker uses STA and returns Unicode paths without shell interpolation', async () => {
  const directory = "C:\\Downloads\\user's files & \u00e9";
  let command;
  let args;
  const selected = await pickCompletedDirectory({ platform: 'win32', run: async (...parameters) => {
    [command, args] = parameters;
    return { stdout: Buffer.from(directory, 'utf8').toString('base64') };
  } });
  assert.equal(selected, directory);
  assert.equal(command, 'powershell.exe');
  assert.ok(args.includes('-STA'));
  const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /FolderBrowserDialog/);
  assert.match(script, /ShowNewFolderButton = \$true/);
  assert.match(script, /TopMost = \$true/);
  await assert.rejects(pickCompletedDirectory({ platform: 'win32', run: async () => ({ stdout: '' }) }), /selection canceled/);
  await assert.rejects(pickCompletedDirectory({ platform: 'win32', run: async () => ({ stdout: 'invalid!' }) }), /invalid response/);
  await assert.rejects(pickCompletedDirectory({ platform: 'win32', run: async () => { throw new Error('PowerShell failed'); } }), /PowerShell failed/);
});

test('macOS folder picker handles cancellation and preserves spaces in the chosen path', async () => {
  assert.equal(await pickCompletedDirectory({
    platform: 'darwin', run: async () => ({ stdout: '/Users/example/final files /\n' })
  }), '/Users/example/final files /');
  await assert.rejects(pickCompletedDirectory({
    platform: 'darwin', run: async () => { throw Object.assign(new Error('Canceled'), { stderr: 'User canceled. (-128)' }); }
  }), /selection canceled/);
  await assert.rejects(pickCompletedDirectory({ platform: 'linux' }), /Windows and macOS only/);
});

test('Windows picker script parses with Windows PowerShell', { skip: process.platform !== 'win32' }, async () => {
  let encoded;
  await pickCompletedDirectory({ platform: 'win32', run: async (command, args) => {
    encoded = args.at(-1);
    return { stdout: Buffer.from('C:\\Downloads').toString('base64') };
  } });
  const validation = `
    $tokens = $null
    $errors = $null
    $script = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))
    [System.Management.Automation.Language.Parser]::ParseInput($script, [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count) { $errors | Write-Error; exit 1 }
  `;
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-EncodedCommand',
    Buffer.from(validation, 'utf16le').toString('base64')], { windowsHide: true });
});
