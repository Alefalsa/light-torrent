import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import parseTorrent from 'parse-torrent';

function normalizePath(value) {
  // Ownership checks must match the filename equivalence of common local filesystems.
  const normalized = value.normalize('NFC');
  return process.platform === 'darwin' || process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function canonicalDirectory(directory) {
  let parent = path.resolve(directory);
  const missing = [];
  while (true) {
    try {
      return path.join(realpathSync(parent), ...missing);
    } catch (error) {
      if (error.code !== 'ENOENT' || parent === path.dirname(parent)) throw error;
      missing.unshift(path.basename(parent));
      parent = path.dirname(parent);
    }
  }
}

function identity(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function sameIdentity(stat, expected) {
  return stat && expected && String(stat.dev) === expected.dev && String(stat.ino) === expected.ino;
}

function unchangedFile(stat, expected) {
  return sameIdentity(stat, expected) && (!expected.mtime || String(stat.mtimeNs) === expected.mtime);
}

function validIdentity(value) {
  return value && /^\d+$/.test(value.dev) && /^\d+$/.test(value.ino) &&
    typeof value.dev === 'string' && typeof value.ino === 'string' &&
    (value.mtime === undefined || (typeof value.mtime === 'string' && /^-?\d+$/.test(value.mtime)));
}

export class InputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export async function parseSource(input) {
  if (!input || typeof input !== 'object') throw new InputError('Provide a magnet link or .torrent file.');
  let source;
  if (input.kind === 'magnet') {
    if (typeof input.value !== 'string' || input.value.length > 16384 ||
        !input.value.trim().startsWith('magnet:?')) {
      throw new InputError('Enter a valid magnet link.');
    }
    source = input.value.trim();
  } else if (input.kind === 'file') {
    // Magnet downloads become file sources once metadata is saved for offline resume.
    if (typeof input.value !== 'string' || input.value.length > 2796204 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.value)) {
      throw new InputError('The .torrent file must be valid and no larger than 2 MiB.');
    }
    source = Buffer.from(input.value, 'base64');
    if (!source.length || source.length > 2 * 1024 * 1024) {
      throw new InputError('The .torrent file must be valid and no larger than 2 MiB.');
    }
  } else {
    throw new InputError('Only magnet links and .torrent files are supported.');
  }
  let parsed;
  try {
    parsed = await parseTorrent(source);
  } catch (error) {
    throw new InputError(`Invalid torrent: ${error.message}`);
  }
  if (!/^[a-f0-9]{40}$/i.test(parsed.infoHash ?? '')) {
    throw new InputError('Use a BitTorrent v1 or hybrid torrent; v2-only torrents are not supported.');
  }
  if (input.kind === 'file' && !parsed.info) throw new InputError('Upload a .torrent file, not a raw info hash.');
  // Pass the parsed object to the engine, never a user-supplied URL or disk path.
  return { parsed, source: { kind: input.kind, value: input.kind === 'magnet' ? source : input.value } };
}

export class TorrentQueue extends EventEmitter {
  constructor({ client, dataDir, downloadDir, completedDir = path.join(os.homedir(), 'Downloads'), logger = console }) {
    super();
    this.client = client;
    this.dataDir = dataDir;
    this.downloadDir = downloadDir;
    this.completedDir = path.resolve(completedDir);
    this.completions = new Map();
    this.moveAbort = new AbortController();
    this.logger = logger;
    this.entries = new Map();
    this.fileOwners = new Map();
    this.error = null;
    this.closing = false;
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(downloadDir, { recursive: true });
    this.stateFile = path.join(dataDir, 'queue.json');
    client.on('error', error => this.report(error));
    client.on('warning', error => {
      this.logger.warn(`Torrent engine warning: ${error.message}`);
      this.error = error.message;
    });
  }

  report(error) {
    this.error = error.message;
    this.logger.error(error);
  }

  save(entries = this.entries.values()) {
    if (this.persistenceError) throw this.persistenceError;
    const records = [...entries].map(({ torrent, ...record }) => record);
    const temporary = `${this.stateFile}.tmp`;
    writeFileSync(temporary, JSON.stringify({
      version: 3, torrents: records, files: Object.fromEntries(this.fileOwners)
    }, null, 2), { mode: 0o600 });
    renameSync(temporary, this.stateFile);
  }

  saveFromEvent() {
    if (this.closing) return;
    try {
      this.save();
    } catch (error) {
      this.report(new Error(`Could not save the torrent queue: ${error.message}`));
    }
  }

  async restore() {
    let contents;
    try {
      contents = readFileSync(this.stateFile, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    const state = JSON.parse(contents);
    if (![1, 2, 3].includes(state.version) || !Array.isArray(state.torrents)) throw new Error('Invalid saved queue.');
    if (state.version >= 2) {
      if (!state.files || typeof state.files !== 'object' || Array.isArray(state.files)) throw new Error('Invalid saved file ownership.');
      for (const [file, hash] of Object.entries(state.files)) {
        const key = state.version === 2 ? this.fileKey(file) : file;
        if ((state.version === 2 ? normalizePath(path.relative(path.resolve(this.downloadDir), this.filePath(file))) !== file :
          !path.isAbsolute(file) || normalizePath(path.resolve(file)) !== file) ||
          !/^[a-f0-9]{40}$/.test(hash)) throw new Error('Invalid saved file ownership.');
        this.fileOwners.set(key, hash);
      }
    }
    const prepared = [];
    const hashes = new Set();
    for (const record of state.torrents) {
      if (!/^[a-f0-9-]{36}$/.test(record.id ?? '') || typeof record.paused !== 'boolean' ||
          typeof record.name !== 'string' || this.entries.has(record.id) ||
          (record.downloadDirectory !== undefined &&
            (typeof record.downloadDirectory !== 'string' || !path.isAbsolute(record.downloadDirectory))) ||
          (record.completed !== undefined && typeof record.completed !== 'boolean') ||
          (record.completed && (!record.paused || !path.isAbsolute(record.completedDirectory ?? '') || record.transfer)) ||
          (record.legacyDirectory !== undefined && !/^[a-f0-9-]{36}$/.test(record.legacyDirectory))) {
        throw new Error('Invalid saved torrent entry.');
      }
      const { parsed, source } = await parseSource(record.source);
      if (record.transfer) {
        const transfer = record.transfer;
        if (typeof transfer.directory !== 'string' || !path.isAbsolute(transfer.directory) ||
            !Array.isArray(transfer.files) || !transfer.files.length) throw new Error('Invalid saved completed-file move.');
        const paths = new Set();
        for (const file of transfer.files) {
          this.filePath(file.path, transfer.directory);
          const key = this.fileKey(file.path);
          if (paths.has(key) || !Number.isSafeInteger(file.length) || file.length < 0 ||
              (file.identity && !validIdentity(file.identity)) ||
              (file.source && (!validIdentity(file.source) || typeof file.source.mtime !== 'string' || !/^-?\d+$/.test(file.source.mtime))) ||
              (file.ready !== undefined && typeof file.ready !== 'boolean')) {
            throw new Error('Invalid saved completed-file move.');
          }
          paths.add(key);
        }
      }
      if (hashes.has(parsed.infoHash) || prepared.some(item => item.record.id === record.id)) {
        throw new Error('Duplicate torrent in saved queue.');
      }
      hashes.add(parsed.infoHash);
      prepared.push({
        record: {
          ...record, source, infoHash: parsed.infoHash,
          downloadDirectory: state.version < 3 ? path.resolve(this.downloadDir) :
            record.downloadDirectory ?? path.resolve(this.downloadDir),
          ...(state.version === 1 ? { legacyDirectory: record.id } : {})
        }, parsed
      });
    }
    for (const { record } of prepared) this.entries.set(record.id, record);
    for (const { record, parsed } of prepared) {
      if (record.completed) continue;
      if (record.transfer) {
        this.scheduleCompletion(record);
        continue;
      }
      if (parsed.files) {
        try {
          this.prepareFiles(record, parsed.files, { verifyExisting: true });
        } catch (error) {
          record.error = error.message;
          record.paused = true;
          this.logger.error(error);
          this.saveFromEvent();
          continue;
        }
      }
      if (!record.paused) this.start(record, parsed);
    }
  }

  filePath(file, base = this.downloadDir) {
    if (typeof file !== 'string' || !file || path.isAbsolute(file)) {
      throw new InputError('The torrent contains an unsupported file path.');
    }
    const target = path.resolve(base, file);
    const relative = path.relative(path.resolve(base), target);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new InputError('The torrent contains a file path outside the download directory.');
    }
    const parts = file.split(process.platform === 'win32' ? /[\\/]/ : /\//);
    if (parts.some(part => /[<>:"\\|?*\x00-\x1f]/.test(part) ||
        (process.platform === 'win32' && part !== '.' && part !== '..' &&
          (/[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3]|conin\$|conout\$)(?:\.|$)/i.test(part))))) {
      throw new InputError('The torrent contains an unsupported file path.');
    }
    return target;
  }

  fileKey(file, base = this.downloadDir) {
    const relative = path.relative(path.resolve(base), this.filePath(file, base));
    return normalizePath(path.join(canonicalDirectory(base), relative));
  }

  fileStat(file) {
    try {
      return lstatSync(file);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    }
  }

  retainedFileExists(key, directories) {
    const direct = this.fileStat(key);
    if (direct && !direct.isDirectory()) return true;
    // Ownership keys are normalized; check actual names too, including on case-sensitive volumes.
    const bases = [this.downloadDir, ...[...this.entries.values()].map(entry => entry.downloadDirectory).filter(Boolean)];
    const base = bases.map(canonicalDirectory)
      .filter(directory => key.startsWith(`${normalizePath(directory)}${path.sep}`))
      .sort((a, b) => b.length - a.length)[0];
    const root = base ?? path.parse(key).root;
    let parents = [root];
    const relative = base ? path.relative(normalizePath(base), key) : key.slice(root.length);
    for (const part of relative.split(path.sep)) {
      const matches = [];
      for (const parent of parents) {
        const stat = this.fileStat(parent);
        if (stat?.isSymbolicLink()) return true;
        if (!stat?.isDirectory()) continue;
        if (!directories.has(parent)) {
          const names = new Map();
          for (const name of readdirSync(parent)) {
            const normalized = normalizePath(name);
            if (!names.has(normalized)) names.set(normalized, []);
            names.get(normalized).push(name);
          }
          directories.set(parent, names);
        }
        for (const name of directories.get(parent).get(part) ?? []) {
          const target = path.join(parent, name);
          const targetStat = this.fileStat(target);
          if (targetStat?.isSymbolicLink()) return true;
          if (targetStat) matches.push(target);
        }
      }
      if (!matches.length) return false;
      parents = matches;
    }
    return parents.some(file => {
      const stat = this.fileStat(file);
      return stat && !stat.isDirectory();
    });
  }

  checkParents(file, base) {
    for (let parent = path.dirname(file); parent !== path.resolve(base); parent = path.dirname(parent)) {
      const stat = this.fileStat(parent);
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
        throw new InputError(`The download path is blocked by a file or symbolic link: ${parent}`, 409);
      }
    }
  }

  prepareFiles(entry, files, { verifyExisting = false, verifiedFiles = new Map() } = {}) {
    const base = entry.downloadDirectory ?? this.downloadDir;
    const candidates = new Map();
    const proposed = new Map(this.fileOwners);
    const queuedHashes = new Set([...this.entries.values()].filter(record => !record.completed).map(record => record.infoHash));
    const directories = new Map();
    for (const [file, owner] of proposed) {
      if (!queuedHashes.has(owner) && !this.retainedFileExists(file, directories)) proposed.delete(file);
    }
    const keys = new Set();
    const legacy = entry.legacyDirectory ? path.join(base, entry.legacyDirectory) : null;
    if (legacy && this.fileStat(legacy)?.isSymbolicLink()) throw new InputError('The old download folder is a symbolic link.');
    const moves = [];
    for (const file of files) {
      const target = this.filePath(file.path, base);
      const key = this.fileKey(file.path, base);
      if (keys.has(key)) throw new InputError(`The torrent contains conflicting filenames: ${file.path}`, 409);
      keys.add(key);
      if (proposed.has(key) && proposed.get(key) !== entry.infoHash &&
          (queuedHashes.has(proposed.get(key)) || (!verifyExisting && !verifiedFiles.has(key)))) {
        throw new InputError(`This download path already belongs to another torrent: ${file.path}`, 409);
      }
      this.checkParents(target, base);
      const targetStat = this.fileStat(target);
      if (targetStat && (!targetStat.isFile() || targetStat.isSymbolicLink())) {
        throw new InputError(`The download path is blocked by a file or symbolic link: ${file.path}`, 409);
      }
      if (targetStat && this.fileOwners.get(key) !== entry.infoHash) {
        const fingerprint = `${targetStat.dev}:${targetStat.ino}:${targetStat.size}:${targetStat.mtimeMs}:${targetStat.ctimeMs}`;
        if (targetStat.size !== file.length ||
            (verifiedFiles.has(key) ? verifiedFiles.get(key) !== fingerprint : !verifyExisting)) {
          throw new InputError(`A file already exists at ${file.path} and cannot be safely reused. Move it before retrying.`, 409);
        }
        if (!verifiedFiles.has(key)) {
          candidates.set(key, fingerprint);
          continue;
        }
      } else if (verifiedFiles.has(key)) {
        throw new InputError(`The existing file changed during verification: ${file.path}`, 409);
      }
      if (legacy) {
        const source = this.filePath(file.path, legacy);
        this.checkParents(source, legacy);
        const stat = this.fileStat(source);
        if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new InputError(`Cannot migrate the old download: ${file.path}`, 409);
        if (stat && !targetStat) moves.push({ source, target });
      }
      proposed.set(key, entry.infoHash);
    }
    const reserved = new Set([...proposed.keys(), ...keys]);
    for (const key of reserved) {
      for (let parent = path.dirname(key); parent !== path.dirname(parent); parent = path.dirname(parent)) {
        if (reserved.has(parent)) throw new InputError(`Conflicting file and directory paths: ${key}`, 409);
      }
    }
    // Persist ownership before the engine can open shared files or migration moves data.
    if (proposed.size !== this.fileOwners.size ||
        [...proposed].some(([file, owner]) => this.fileOwners.get(file) !== owner)) {
      const previous = this.fileOwners;
      this.fileOwners = proposed;
      try {
        this.save();
      } catch (error) {
        this.fileOwners = previous;
        throw error;
      }
    }
    const oldDirectories = new Set();
    for (const { source, target } of moves) {
      mkdirSync(path.dirname(target), { recursive: true });
      linkSync(source, target);
      unlinkSync(source);
      for (let parent = path.dirname(source); ; parent = path.dirname(parent)) {
        oldDirectories.add(parent);
        if (parent === path.resolve(legacy)) break;
      }
    }
    for (const directory of [...oldDirectories].sort((a, b) => b.length - a.length)) {
      try {
        rmdirSync(directory);
      } catch (error) {
        if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) this.logger.warn(`Could not remove empty old folder: ${error.message}`);
      }
    }
    if (legacy) {
      delete entry.legacyDirectory;
      this.save();
    }
    return candidates;
  }

  async add(input) {
    const { parsed, source } = await parseSource(input);
    if ([...this.entries.values()].some(entry => entry.infoHash === parsed.infoHash)) {
      throw new InputError('This torrent is already in your queue.', 409);
    }
    const entry = {
      id: randomUUID(), infoHash: parsed.infoHash, name: parsed.name || parsed.infoHash,
      source, paused: false, addedAt: new Date().toISOString(),
      downloadDirectory: this.completedDir,
      downloaded: 0, length: parsed.length || 0, progress: 0, error: null, warning: null
    };
    this.entries.set(entry.id, entry);
    try {
      this.save();
    } catch (error) {
      this.entries.delete(entry.id);
      throw error;
    }
    this.start(entry, parsed);
    return this.describe(entry);
  }

  start(entry, parsed) {
    entry.error = null;
    entry.warning = null;
    let torrent;
    try {
      torrent = this.client.add(parsed, {
        path: entry.downloadDirectory ?? this.downloadDir,
        addUID: false
      });
    } catch (error) {
      entry.error = error.message;
      entry.paused = true;
      this.saveFromEvent();
      throw error;
    }
    entry.torrent = torrent;
    let existingFiles = new Map();
    torrent.on('warning', error => {
      entry.warning = error.message;
      this.logger.warn(`Torrent ${entry.infoHash}: ${error.message}`);
    });
    torrent.on('error', error => {
      entry.error = error.message;
      entry.paused = true;
      this.logger.error(`Torrent ${entry.infoHash}: ${error.message}`);
      this.capture(entry);
      entry.torrent = null;
      this.saveFromEvent();
    });
    torrent.on('metadata', () => {
      try {
        existingFiles = this.prepareFiles(entry, torrent.files, { verifyExisting: true });
        if (existingFiles.size) {
          const store = torrent.store;
          const put = store.put;
          // Verification only reads. Keep writes blocked until every existing file is validated.
          store.put = (index, buffer, callback) => {
            if (existingFiles.size) {
              queueMicrotask(() => callback(new InputError('Existing destination files have not passed verification.', 409)));
            } else {
              put.call(store, index, buffer, callback);
            }
          };
        }
      } catch (error) {
        // Metadata arrives before storage verification/writes, so conflicts cannot damage existing files.
        torrent.destroy();
        torrent.emit('error', error);
      }
    });
    torrent.on('ready', () => {
      try {
        for (const file of torrent.files) {
          const key = this.fileKey(file.path, entry.downloadDirectory ?? this.downloadDir);
          if (!existingFiles.has(key) || !file.length) continue;
          const first = Math.floor(file.offset / torrent.pieceLength);
          const last = Math.floor((file.offset + file.length - 1) / torrent.pieceLength);
          for (let index = first; index <= last; index++) {
            if (!torrent.bitfield.get(index)) {
              throw new InputError(`The existing file does not match verified torrent data: ${file.path}. Move it before retrying.`, 409);
            }
          }
        }
        if (existingFiles.size) this.prepareFiles(entry, torrent.files, { verifiedFiles: existingFiles });
        existingFiles.clear();
      } catch (error) {
        torrent.destroy();
        torrent.emit('error', error);
        return;
      }
      entry.name = torrent.name;
      // Retain metadata so a restart can verify existing files without finding peers first.
      const metadata = Buffer.from(torrent.torrentFile).toString('base64');
      if (metadata.length <= 2796204) entry.source = { kind: 'file', value: metadata };
      this.capture(entry);
      this.saveFromEvent();
    });
    torrent.on('done', () => {
      this.capture(entry);
      this.scheduleCompletion(entry, torrent.files.map(file => ({ path: file.path, length: file.length })));
    });
  }

  scheduleCompletion(entry, files) {
    if (this.closing || entry.completed) return Promise.resolve();
    if (this.completions.has(entry.id)) return this.completions.get(entry.id);
    const task = Promise.resolve().then(async () => {
      if (!entry.transfer) {
        const next = { ...entry, paused: true, transfer: { directory: entry.downloadDirectory ?? this.completedDir, files } };
        this.save([...this.entries.values()].map(record => record === entry ? next : record));
        Object.assign(entry, next);
      }
      entry.error = null;
      await this.stop(entry);
      await this.moveCompleted(entry);
    }).catch(async error => {
      entry.error = `Could not finish completed download: ${error.message}`;
      this.logger.error(error);
      try {
        await this.stop(entry);
      } catch (stopError) {
        entry.error += ` Could not stop the torrent: ${stopError.message}`;
        this.logger.error(stopError);
      }
      entry.paused = !entry.torrent || entry.torrent.destroyed;
      this.saveFromEvent();
    }).finally(() => {
      this.completions.delete(entry.id);
      this.emit('activity');
    });
    this.completions.set(entry.id, task);
    this.emit('activity');
    return task;
  }

  async moveStat(file) {
    try {
      return await fs.lstat(file, { bigint: true });
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    }
  }

  async copyCompletedSource(source, handle, file) {
    const input = await fs.open(source, 'r');
    try {
      const stat = await input.stat({ bigint: true });
      if (!unchangedFile(stat, file.source)) throw new Error('Completed source changed.');
      this.moveAbort.signal.throwIfAborted();
      await handle.truncate(0);
      const buffer = Buffer.alloc(64 * 1024);
      let position = 0;
      while (true) {
        this.moveAbort.signal.throwIfAborted();
        const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
        if (!bytesRead) break;
        let written = 0;
        while (written < bytesRead) {
          this.moveAbort.signal.throwIfAborted();
          const { bytesWritten } = await handle.write(buffer, written, bytesRead - written, position + written);
          if (!bytesWritten) throw new Error('Could not write the completed file copy.');
          written += bytesWritten;
        }
        position += bytesRead;
      }
      if (position !== file.length) throw new Error('Completed source length changed while copying.');
      await handle.sync();
    } finally {
      await input.close();
    }
  }

  async stageCompletedFile(entry, file, source, staging) {
    this.moveAbort.signal.throwIfAborted();
    const sourceStat = await this.moveStat(source);
    if (!sourceStat?.isFile() || sourceStat.isSymbolicLink() || sourceStat.size !== BigInt(file.length)) {
      throw new Error(`The completed source file is missing or has changed: ${file.path}`);
    }
    if (file.source && !unchangedFile(sourceStat, file.source)) {
      throw new Error(`The completed source file has changed: ${file.path}`);
    }
    file.source ??= { ...identity(sourceStat), mtime: String(sourceStat.mtimeNs) };
    let stagingStat = await this.moveStat(staging);
    let copied = false;
    if (!stagingStat) {
      delete file.identity;
      delete file.ready;
      try {
        await fs.link(source, staging);
      } catch (error) {
        if (error.code !== 'EXDEV') throw error;
        const handle = await fs.open(staging, 'wx', 0o600);
        try {
          file.identity = identity(await handle.stat({ bigint: true }));
          this.save();
          await this.copyCompletedSource(source, handle, file);
          copied = true;
        } finally {
          await handle.close();
        }
      }
      stagingStat = await this.moveStat(staging);
    }
    if (!stagingStat?.isFile() || stagingStat.isSymbolicLink() ||
        (file.identity && !sameIdentity(stagingStat, file.identity)) ||
        (file.ready && !unchangedFile(stagingStat, file.identity)) ||
        (!file.identity && !sameIdentity(stagingStat, file.source))) {
      throw new Error(`An unrecognized temporary move file exists. Rename it before retrying: ${staging}`);
    }
    file.identity ??= identity(stagingStat);
    if (!file.ready && !sameIdentity(stagingStat, file.source) && !copied) {
      const handle = await fs.open(staging, 'r+');
      try {
        if (!sameIdentity(await handle.stat({ bigint: true }), file.identity)) throw new Error('Temporary move file changed.');
        await this.copyCompletedSource(source, handle, file);
      } finally {
        await handle.close();
      }
    }
    const currentSource = await this.moveStat(source);
    const currentStage = await this.moveStat(staging);
    if (!unchangedFile(currentSource, file.source) ||
        !sameIdentity(currentStage, file.identity) || currentStage.size !== BigInt(file.length)) {
      throw new Error(`The completed file changed while moving: ${file.path}`);
    }
    file.ready = true;
    file.identity.mtime = String(currentStage.mtimeNs);
    this.save();
  }

  async moveCompleted(entry) {
    this.moveAbort.signal.throwIfAborted();
    const { directory, files } = entry.transfer;
    const base = entry.downloadDirectory ?? this.downloadDir;
    const sameDirectory = path.resolve(directory) === path.resolve(base);
    for (const file of files) {
      const target = this.filePath(file.path, directory);
      this.checkParents(target, directory);
      const stat = await this.moveStat(target);
      if (!sameDirectory && stat && (!file.ready || !unchangedFile(stat, file.identity) || !stat.isFile())) {
        throw new InputError(`A file already exists in ${directory}: ${file.path}. Rename or move it, then retry the move.`, 409);
      }
    }
    const oldDirectories = new Set();
    for (const [index, file] of files.entries()) {
      const source = this.filePath(file.path, base);
      const target = this.filePath(file.path, directory);
      this.checkParents(source, base);
      const staging = path.join(path.dirname(target), `.light-torrent-${entry.id}-${index}.part`);
      if (!(await this.moveStat(source)) && file.length === 0 && !file.source) {
        await fs.mkdir(path.dirname(source), { recursive: true });
        await fs.writeFile(source, '', { flag: 'wx', mode: 0o600 });
      }
      if (sameDirectory) {
        const stat = await this.moveStat(source);
        if (!stat?.isFile() || stat.isSymbolicLink() || stat.size !== BigInt(file.length)) throw new Error(`Completed file changed: ${file.path}`);
        continue;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      if (!(await this.moveStat(target))) {
        await this.stageCompletedFile(entry, file, source, staging);
        this.moveAbort.signal.throwIfAborted();
        await fs.link(staging, target);
      }
      const targetStat = await this.moveStat(target);
      if (!unchangedFile(targetStat, file.identity) || targetStat.size !== BigInt(file.length)) throw new Error(`Completed destination changed: ${file.path}`);
      const sourceStat = await this.moveStat(source);
      if (sourceStat) {
        if (!unchangedFile(sourceStat, file.source)) throw new Error(`Source changed; both copies were retained: ${file.path}`);
        this.moveAbort.signal.throwIfAborted();
        await fs.unlink(source);
      }
      const stagingStat = await this.moveStat(staging);
      if (stagingStat) {
        if (!sameIdentity(stagingStat, file.identity)) throw new Error(`Temporary move file changed: ${staging}`);
        this.moveAbort.signal.throwIfAborted();
        await fs.unlink(staging);
      }
      for (let parent = path.dirname(source); parent !== path.resolve(base); parent = path.dirname(parent)) oldDirectories.add(parent);
    }
    for (const directory of [...oldDirectories].sort((a, b) => b.length - a.length)) {
      try {
        await fs.rmdir(directory);
      } catch (error) {
        if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) this.logger.warn(`Could not remove empty staging folder: ${error.message}`);
      }
    }
    const length = files.reduce((sum, file) => sum + file.length, 0);
    const next = { ...entry, completed: true, completedDirectory: directory, paused: true,
      progress: 1, downloaded: length, length, error: null, warning: null };
    delete next.transfer;
    this.save([...this.entries.values()].map(record => record === entry ? next : record));
    Object.assign(entry, next);
    delete entry.transfer;
  }

  capture(entry) {
    const torrent = entry.torrent;
    if (!torrent || torrent.destroyed) return;
    entry.downloaded = torrent.downloaded || 0;
    entry.length = torrent.length || entry.length;
    entry.progress = torrent.progress || 0;
  }

  describe(entry) {
    this.capture(entry);
    const torrent = entry.torrent;
    const directory = entry.downloadDirectory ?? this.downloadDir;
    const pendingMove = Boolean(entry.transfer && path.resolve(entry.transfer.directory) !== path.resolve(directory));
    return {
      id: entry.id, name: entry.name, infoHash: entry.infoHash,
      status: entry.error ? 'Error' : this.completions.has(entry.id) ? pendingMove ? 'Moving' : 'Completing' : entry.completed ? 'Completed' : entry.paused ? 'Paused' :
        !torrent?.ready ? 'Finding metadata' : torrent.done ? 'Seeding' : 'Downloading',
      progress: entry.progress, downloaded: entry.downloaded, length: entry.length,
      downloadSpeed: torrent?.downloadSpeed || 0, uploadSpeed: torrent?.uploadSpeed || 0,
      peers: torrent?.numPeers || 0, paused: entry.paused,
      error: entry.error, warning: entry.warning,
      completed: Boolean(entry.completed), moving: this.completions.has(entry.id), pendingMove,
      pendingCompletion: Boolean(entry.transfer && !pendingMove),
      path: entry.completed ? entry.completedDirectory : directory
    };
  }

  snapshot() {
    return {
      torrents: [...this.entries.values()].map(entry => this.describe(entry)),
      downloadDir: this.downloadDir, completedDir: this.completedDir, error: this.error
    };
  }

  async stop(entry) {
    this.capture(entry);
    if (entry.torrent && !entry.torrent.destroyed) {
      const torrent = entry.torrent;
      await new Promise((resolve, reject) => {
        this.client.remove(torrent, { destroyStore: false }, error => error ? reject(error) : resolve())
          .catch(reject);
      });
    }
    entry.torrent = null;
  }

  async action(id, action) {
    const entry = this.entries.get(id);
    if (!entry) throw new InputError('Torrent not found.', 404);
    if (!['pause', 'resume', 'remove'].includes(action)) throw new InputError('Unknown torrent action.');
    if (this.completions.has(id)) {
      if (action === 'resume') return this.describe(entry);
      throw new InputError('The download is being finalized. Wait for it to finish.', 409);
    }
    if (entry.completed && action !== 'remove') throw new InputError('This torrent is completed and no longer seeds. Remove it from the queue to add it again.', 409);
    if (entry.transfer) {
      if (action !== 'resume') throw new InputError('Finish finalizing the completed files before removing this torrent.', 409);
      this.scheduleCompletion(entry);
      return this.describe(entry);
    }
    if (action === 'resume' && !entry.paused && entry.torrent && !entry.torrent.destroyed) {
      return this.describe(entry);
    }
    const parsed = action === 'resume' ? (await parseSource(entry.source)).parsed : null;
    this.capture(entry);
    const next = {
      ...entry, paused: action !== 'resume',
      error: action === 'resume' ? null : entry.error,
      warning: action === 'resume' ? null : entry.warning
    };
    const proposed = new Map(this.entries);
    if (action === 'remove') proposed.delete(id);
    else proposed.set(id, next);
    // Commit intent before changing connections or membership: a failed write has no side effects.
    this.save(proposed.values());
    if (action === 'remove') this.entries.delete(id);
    else Object.assign(entry, next);
    try {
      if (action === 'resume') this.start(entry, parsed);
      else await this.stop(entry);
    } catch (error) {
      // A failed engine operation may have partially stopped the torrent; persist its actual state.
      this.entries.set(id, entry);
      entry.paused = !entry.torrent || entry.torrent.destroyed;
      if (entry.paused) entry.torrent = null;
      entry.error = error.message;
      this.saveFromEvent();
      throw error;
    }
    return action === 'remove' ? { removed: true } : this.describe(entry);
  }

  async close() {
    this.closing = true;
    await Promise.all(this.completions.values());
    let saveError;
    try {
      for (const entry of this.entries.values()) this.capture(entry);
      this.save();
    } catch (error) {
      saveError = error;
      this.report(error);
    }
    if (!this.client.destroyed) {
      await new Promise((resolve, reject) => this.client.destroy(error => error ? reject(error) : resolve()));
    }
    if (saveError) throw saveError;
  }
}
