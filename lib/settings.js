import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function settingsPath({
  platform = process.platform, home = os.homedir(),
  localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
} = {}) {
  const support = platform === 'win32' ? localAppData :
    platform === 'darwin' ? path.join(home, 'Library', 'Application Support') :
      path.join(home, '.config');
  return path.join(support, 'Light Torrent', 'settings.json');
}

export async function validateCompletedDirectory(directory) {
  if (typeof directory !== 'string' || !directory || directory.includes('\0') || !path.isAbsolute(directory)) {
    throw new Error('The final download folder must be an absolute directory path.');
  }
  const resolved = path.resolve(directory);
  try {
    if (!(await stat(resolved)).isDirectory()) throw new Error('The selected path is not a folder.');
    const probe = path.join(resolved, `.light-torrent-${randomUUID()}.tmp`);
    const file = await open(probe, 'wx', 0o600);
    try {
      await file.close();
    } finally {
      await unlink(probe);
    }
  } catch (error) {
    throw new Error(`Cannot use the final download folder "${resolved}": ${error.message}`, { cause: error });
  }
  return resolved;
}

export async function readCompletedDirectory(file = settingsPath()) {
  let contents;
  try {
    contents = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error(`Could not read download folder settings: ${error.message}`, { cause: error });
  }
  let settings;
  try {
    settings = JSON.parse(contents);
  } catch (error) {
    throw new Error('Invalid download folder settings. Remove settings.json to choose a folder again.', { cause: error });
  }
  if (!settings || settings.version !== 1 || typeof settings.completedDir !== 'string') {
    throw new Error('Invalid download folder settings. Remove settings.json to choose a folder again.');
  }
  return validateCompletedDirectory(settings.completedDir);
}

export async function saveCompletedDirectory(directory, file = settingsPath()) {
  const completedDir = await validateCompletedDirectory(directory);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: 1, completedDir }, null, 2) + '\n', { mode: 0o600 });
  try {
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary);
    throw new Error(`Could not save the final download folder: ${error.message}`, { cause: error });
  }
  return completedDir;
}
