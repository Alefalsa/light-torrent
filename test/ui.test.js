import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import vm from 'node:vm';

async function createUI({ hash = '', idleShutdownAt = null, addError = null } = {}) {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const elements = new Map();
  function element(selector, scope = elements) {
    if (scope === elements && selector.startsWith('#') && !html.includes(`id="${selector.slice(1)}"`)) return null;
    if (!scope.has(selector)) {
      const classes = new Set();
      const children = new Map();
      scope.set(selector, {
        textContent: '', hidden: true, value: '',
        dataset: {}, attributes: {},
        classList: {
          add: name => classes.add(name), remove: name => classes.delete(name),
          contains: name => classes.has(name),
          toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name)
        },
        addEventListener() {},
        setAttribute(name, value) { this.attributes[name] = value; },
        querySelector: name => element(name, children),
        append() {},
        remove() {},
        focus() { this.focused = true; },
        content: { firstElementChild: { cloneNode: () => element('row', new Map()) } }
      });
    }
    return scope.get(selector);
  }
  let offline = false;
  let offlineError = new Error('Network unavailable');
  let now = Date.now();
  const clearedIntervals = [];
  let intervalId = 0;
  const location = { hash, pathname: '/', search: '' };
  const historyChanges = [];
  const requests = [];
  const windowHandlers = new Map();
  const context = vm.createContext({
    document: { querySelector: element },
    window: { addEventListener: (name, handler) => windowHandlers.set(name, handler) },
    location,
    history: { replaceState(state, title, url) { historyChanges.push(url); location.hash = ''; } },
    URLSearchParams,
    TypeError,
    Date: class extends Date { static now() { return now; } },
    AbortSignal,
    setInterval() { return ++intervalId; },
    clearInterval(id) { clearedIntervals.push(id); },
    fetch: async (url, options) => {
      requests.push({ url, method: options.method, headers: options.headers, body: options.body });
      if (offline) throw offlineError;
      if (options.method === 'POST' && addError) {
        return { ok: false, json: async () => ({ error: addError }) };
      }
      return {
        ok: true,
        json: async () => ({ token: 'session', torrents: [], downloadDir: '/downloads', error: null, idleShutdownAt })
      };
    }
  });
  vm.runInContext(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  await setImmediate();
  return {
    element, context, location, historyChanges, requests, windowHandlers, clearedIntervals,
    setOffline(value, error = new Error('Network unavailable')) { offline = value; offlineError = error; },
    setNow(value) { now = value; }
  };
}

test('reconnection clears connection alerts without clearing action errors', async () => {
  const { element, context, setOffline } = await createUI();
  assert.equal(element('#connection').textContent, 'Local & connected');
  setOffline(true);
  await vm.runInContext('refresh()', context);
  assert.equal(element('#message').hidden, false);
  assert.match(element('#message').textContent, /Cannot connect/);
  setOffline(false);
  await vm.runInContext('refresh()', context);
  assert.equal(element('#connection').textContent, 'Local & connected');
  assert.equal(element('#message').hidden, true);
  vm.runInContext("message('Invalid magnet link.')", context);
  await vm.runInContext('refresh()', context);
  assert.equal(element('#message').hidden, false);
  assert.equal(element('#message').textContent, 'Invalid magnet link.');
});

test('warning explanations distinguish tracker timeouts, other tracker issues, and generic warnings', async () => {
  const { context } = await createUI();
  const timeout = vm.runInContext("warningDetails('tracker request timed out (udp://example.com)')", context);
  assert.equal(timeout.label, 'Tracker warning');
  assert.match(timeout.explanation, /did not respond in time/);
  assert.match(timeout.explanation, /downloading can continue/);
  const tracker = vm.runInContext("warningDetails('Invalid tracker response')", context);
  assert.equal(tracker.label, 'Tracker warning');
  assert.match(tracker.explanation, /reported a problem/);
  const generic = vm.runInContext("warningDetails('Unable to fetch metadata')", context);
  assert.equal(generic.label, 'Torrent warning');
  assert.match(generic.explanation, /non-fatal issue/);
});

test('warning rendering keeps technical details in an accessible tooltip and errors distinct', async () => {
  const { context } = await createUI();
  const torrent = {
    id: 'example', name: 'Example', status: 'Downloading', progress: 0.5,
    length: 100, downloaded: 50, downloadSpeed: 10, uploadSpeed: 0, peers: 2,
    paused: false, error: null, warning: 'tracker request timed out (udp://example.com)', path: '/downloads/example'
  };
  context.state = { torrents: [torrent], downloadDir: '/downloads', error: null };
  vm.runInContext('render(state)', context);
  const row = vm.runInContext("rows.get('example')", context);
  assert.equal(row.querySelector('progress').attributes['aria-label'], 'Download progress for Example');
  assert.equal(row.querySelector('.torrent-error').hidden, true);
  assert.equal(row.querySelector('.torrent-warning').hidden, false);
  assert.equal(row.querySelector('.warning-label').textContent, 'Tracker warning');
  assert.equal(row.querySelector('.warning-trigger').attributes['aria-describedby'], 'warning-example');
  assert.match(row.querySelector('.warning-explanation').textContent, /did not respond in time/);
  assert.equal(row.querySelector('.warning-details').textContent, `Details: ${torrent.warning}`);
  torrent.error = 'Disk is full';
  vm.runInContext('render(state)', context);
  assert.equal(row.querySelector('.torrent-error').hidden, false);
  assert.equal(row.querySelector('.torrent-error').textContent, 'Disk is full');
  assert.equal(row.querySelector('.torrent-warning').hidden, true);
  torrent.error = null;
  torrent.warning = null;
  vm.runInContext('render(state)', context);
  assert.equal(row.querySelector('.torrent-error').hidden, true);
  assert.equal(row.querySelector('.torrent-warning').hidden, true);
});

test('completed and moving torrents show accurate locations and safe action buttons', async () => {
  const { context, element } = await createUI();
  const torrent = {
    id: 'finished', name: 'Finished file', status: 'Completed', completed: true,
    paused: true, progress: 1, downloaded: 10, length: 10, downloadSpeed: 0, uploadSpeed: 0,
    peers: 0, path: '/home/Downloads', error: null, warning: null
  };
  context.state = { torrents: [torrent], downloadDir: '/app/downloads', completedDir: '/home/Downloads' };
  vm.runInContext('render(state)', context);
  const row = vm.runInContext("rows.get('finished')", context);
  assert.equal(row.querySelector('.toggle').hidden, true);
  assert.equal(row.querySelector('.remove').disabled, false);
  assert.equal(row.querySelector('.file-path').textContent, '/home/Downloads');
  assert.equal(element('#active-count').textContent, 0);
  assert.match(element('#download-dir').textContent, /unfinished.*completed/);
  Object.assign(torrent, { length: 0, downloaded: 0 });
  vm.runInContext('render(state)', context);
  assert.match(row.querySelector('.size').textContent, /100%.*0 B of 0 B/);
  Object.assign(torrent, { completed: false, moving: true, pendingMove: true, status: 'Moving', path: '/app/downloads' });
  vm.runInContext('render(state)', context);
  assert.equal(row.querySelector('.toggle').hidden, false);
  assert.equal(row.querySelector('.toggle').disabled, true);
  assert.equal(row.querySelector('.remove').disabled, true);
  assert.equal(element('#active-count').textContent, 1);
  Object.assign(torrent, { moving: false, status: 'Error', error: 'Destination file exists' });
  vm.runInContext('render(state)', context);
  assert.equal(row.querySelector('.toggle').textContent, 'Retry move');
  assert.equal(row.querySelector('.toggle').disabled, false);
  assert.equal(row.querySelector('.toggle').dataset.action, 'resume');
  assert.equal(row.querySelector('.remove').disabled, true);
});

test('dashboard has no manual input panel and directs users to the extension', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /add-panel|magnet-form|torrent-file|Drop a link|Add torrent/);
  assert.match(html, /Approve a magnet link in the browser extension/);
  assert.match(html, /<link rel="icon" href="\/favicon.svg" type="image\/svg\+xml">/);
  assert.match(html, /<meta name="description" content="[^"]+">/);
  assert.match(html, /<meta name="theme-color" content="#287f68">/);
});

test('extension handoff adds the magnet with a session token and consumes the fragment once', async () => {
  const magnet = `magnet:?xt=urn:btih:${'a'.repeat(40)}&dn=Example%20File&tr=udp%3A%2F%2Fexample.test`;
  const fixture = await createUI({ hash: `#magnet=${encodeURIComponent(magnet)}` });
  assert.equal(fixture.element('#message').hidden, true);
  assert.equal(fixture.location.hash, '');
  assert.deepEqual(fixture.historyChanges, ['/']);
  let submissions = fixture.requests.filter(request => request.method === 'POST');
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].url, '/api/torrents');
  assert.equal(submissions[0].headers['X-Client-Token'], 'session');
  assert.deepEqual(JSON.parse(submissions[0].body), { kind: 'magnet', value: magnet });
  await fixture.windowHandlers.get('hashchange')();
  assert.equal(fixture.requests.filter(request => request.method === 'POST').length, 1);
  fixture.location.hash = `#magnet=${encodeURIComponent(magnet + '&dn=Second')}`;
  await fixture.windowHandlers.get('hashchange')();
  submissions = fixture.requests.filter(request => request.method === 'POST');
  assert.equal(submissions.length, 2);
  assert.deepEqual(JSON.parse(submissions[1].body), { kind: 'magnet', value: magnet + '&dn=Second' });
});

test('failed magnet submission stays visible across refreshes with retry guidance', async () => {
  const magnet = `magnet:?xt=urn:btih:${'a'.repeat(40)}`;
  const fixture = await createUI({ hash: `#magnet=${encodeURIComponent(magnet)}`, addError: 'Queue could not be saved' });
  assert.equal(fixture.location.hash, '');
  assert.match(fixture.element('#message').textContent, /Could not add.*Queue could not be saved/);
  assert.match(fixture.element('#message').textContent, /extension again to retry/);
  await vm.runInContext('refresh()', fixture.context);
  assert.equal(fixture.element('#message').hidden, false);
});

test('invalid and oversized fragment links are rejected without submission', async () => {
  for (const value of ['https://example.test/file.torrent', 'magnet:?' + 'a'.repeat(16384)]) {
    const fixture = await createUI({ hash: `#magnet=${encodeURIComponent(value)}` });
    assert.match(fixture.element('#message').textContent, /invalid or too long/);
    assert.equal(fixture.element('#message').classList.contains('info'), false);
    assert.equal(fixture.location.hash, '');
    assert.equal(fixture.requests.every(request => request.method === 'GET'), true);
  }
});

test('idle shutdown shows sleeping state and stops polling, without masking early connection failures', async () => {
  const deadline = Date.now() + 120000;
  const fixture = await createUI({ idleShutdownAt: deadline });
  assert.equal(fixture.element('#idle-note').hidden, false);
  assert.match(fixture.element('#idle-note').textContent, /Client stops in/);
  fixture.setOffline(true, new TypeError('Failed to fetch'));
  await vm.runInContext('refresh()', fixture.context);
  assert.equal(fixture.element('#connection').textContent, 'Disconnected');
  assert.equal(fixture.clearedIntervals.length, 0);
  fixture.setNow(deadline + 1);
  await vm.runInContext('refresh()', fixture.context);
  assert.equal(fixture.element('#connection').textContent, 'Sleeping');
  assert.equal(fixture.element('#message').classList.contains('info'), true);
  assert.match(fixture.element('#message').textContent, /Approve a magnet link/);
  assert.equal(fixture.clearedIntervals.length, 1);
  fixture.setOffline(false);
  await vm.runInContext('refresh()', fixture.context);
  assert.equal(fixture.element('#connection').textContent, 'Local & connected');
  assert.equal(fixture.element('#message').hidden, true);
  assert.equal(vm.runInContext('refreshTimer', fixture.context), 2);
});
