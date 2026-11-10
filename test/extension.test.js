import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const folder = new URL('../extension/', import.meta.url);
const magnet = `magnet:?xt=urn:btih:${'a'.repeat(40)}&dn=Example%20File`;
const sender = { id: 'light-torrent-test', tab: { id: 1 }, url: 'https://example.test/' };

async function setup({ approved = true, tabError = null, nativeError = null, nativeResult = { ok: true },
  deferNative = false, safari = false, buildDOM = () => ({}) } = {}) {
  const tabs = [];
  const confirmations = [];
  const alerts = [];
  const errors = [];
  const handlers = new Map();
  const nativeRequests = [];
  const nativeReplies = [];
  const nativePorts = [];
  const observers = [];
  const rootNotifications = [];
  let onMessage;
  class Root {
    constructor(nodeType) {
      this.nodeType = nodeType;
      this.children = [];
      this.parentNode = null;
      this.adoptedStyleSheets = [];
      this.scans = 0;
    }
    get isConnected() {
      return this.nodeType === 9 || Boolean(this.host?.isConnected || this.parentNode?.isConnected);
    }
    querySelectorAll(selector) {
      assert.equal(selector, '*');
      this.scans++;
      const result = [];
      function visit(node) {
        for (const child of node.children) { result.push(child); visit(child); }
      }
      visit(this);
      return result;
    }
  }
  class ShadowRoot extends Root {
    constructor(host, mode) { super(11); this.host = host; this.mode = mode; }
  }
  class Element extends Root {
    constructor(href, localName = 'a') {
      super(1);
      this.href = href;
      this.localName = localName;
      this.shadowRoot = null;
      this.classes = new Set();
      this.classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
    }
    hasAttribute(name) { return name === 'href' && this.href !== null; }
    getAttribute(name) { return name === 'href' ? this.href : null; }
    attachShadow(options) {
      if (!['open', 'closed'].includes(options?.mode)) throw new TypeError('Invalid shadow mode.');
      const root = new ShadowRoot(this, options.mode);
      if (root.mode === 'open') this.shadowRoot = root;
      return root;
    }
    dispatchEvent(event) {
      rootNotifications.push(event);
      event.path = [];
      for (let node = this; node; node = node.host ?? node.parentNode) event.path.push(node);
      if (this.isConnected) handlers.get(event.type)?.(event);
      return true;
    }
  }
  class Event {
    constructor(type, options) { this.type = type; Object.assign(this, options); }
    composedPath() { return this.path; }
  }
  class CSSStyleSheet {
    replaceSync(text) { this.text = text; }
  }
  class MutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(root, options) { this.root = root; this.options = options; this.active = true; }
    disconnect() { this.active = false; }
  }
  const document = new Root(9);
  function append(parent, node) {
    if (node.parentNode) node.parentNode.children.splice(node.parentNode.children.indexOf(node), 1);
    parent.children.push(node);
    node.parentNode = parent;
    return node;
  }
  const built = buildDOM({ document, Element, append });
  function notify(root, records) {
    const observer = observers.find(observer => observer.root === root && observer.active);
    assert.ok(observer, 'Expected an active observer for this root.');
    observer.callback(records);
  }
  function dispatch(message, from = sender) {
    return new Promise(resolve => {
      const pending = onMessage(message, from, resolve);
      if (!pending) resolve(null);
    });
  }
  const chrome = {
    runtime: {
      id: sender.id,
      getURL: name => `${safari ? 'safari-web-extension' : 'chrome-extension'}://${sender.id}/${name}`,
      onMessage: { addListener(handler) { onMessage = handler; } },
      sendMessage: message => dispatch(message),
      async sendNativeMessage(host, request) {
        nativeRequests.push({ host, request });
        if (nativeError) throw new Error(nativeError);
        if (deferNative) return new Promise(resolve => nativeReplies.push(resolve));
        return nativeResult;
      },
      connectNative(host) {
        let messageListener;
        let disconnectListener;
        const port = {
          disconnected: false,
          onMessage: { addListener(listener) { messageListener = listener; } },
          onDisconnect: { addListener(listener) { disconnectListener = listener; } },
          disconnect() { port.disconnected = true; },
          postMessage(request) {
            nativeRequests.push({ host, request });
            const reply = (result = nativeResult) => {
              if (nativeError) {
                chrome.runtime.lastError = { message: nativeError };
                port.disconnected = true;
                disconnectListener();
                delete chrome.runtime.lastError;
              } else {
                messageListener(result);
              }
            };
            if (deferNative) nativeReplies.push(reply);
            else queueMicrotask(reply);
          }
        };
        nativePorts.push(port);
        return port;
      }
    },
    tabs: {
      async create(options) {
        if (tabError) throw new Error(tabError);
        tabs.push(options);
      }
    }
  };
  const browser = safari ? { ...chrome, runtime: { ...chrome.runtime } } : undefined;
  if (safari) chrome.runtime.sendNativeMessage = () => { throw new Error("Use Safari's promise-based browser namespace."); };
  const context = vm.createContext({
    chrome, browser, Element, ShadowRoot, Event, CSSStyleSheet, MutationObserver, document, URLSearchParams,
    window: { addEventListener(name, handler, capture) {
      assert.equal(capture, true);
      handlers.set(name, handler);
    } },
    confirm(text) { confirmations.push(text); return approved; },
    alert(text) { alerts.push(text); },
    console: { error: (...details) => errors.push(details) },
    importScripts(name) { assert.equal(name, 'shared.js'); }
  });
  for (const name of ['shared.js', 'background.js', 'content.js', 'shadow-roots.js']) {
    vm.runInContext(await readFile(new URL(name, folder), 'utf8'), context);
  }
  async function click({ type = 'click', button = 0, trusted = true, href = magnet } = {}) {
    const anchor = new Element(href);
    const event = {
      type, button, isTrusted: trusted, prevented: false, stopped: false,
      composedPath: () => [new Element(null, 'span'), anchor],
      preventDefault() { this.prevented = true; },
      stopImmediatePropagation() { this.stopped = true; }
    };
    await handlers.get(type)(event);
    return event;
  }
  return { context, tabs, confirmations, alerts, errors, nativeRequests, nativePorts,
    replyNative(result) { nativeReplies.shift()(result); }, dispatch, click,
    document, Element, observers, rootNotifications, append, notify, built };
}

test('manifest requests only native messaging and uses local scripts without external connections', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', folder), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['nativeMessaging']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.deepEqual(manifest.content_scripts[0].js, ['shared.js', 'content.js']);
  assert.equal(manifest.minimum_chrome_version, '111');
  assert.equal(manifest.content_scripts[1].world, 'MAIN');
  assert.deepEqual(manifest.content_scripts[1].js, ['shadow-roots.js']);
  for (const script of manifest.content_scripts) {
    assert.equal(script.all_frames, true);
    assert.equal(script.match_about_blank, true);
    assert.equal(script.run_at, 'document_start');
  }
  for (const name of [...manifest.content_scripts.flatMap(script => script.js), manifest.background.service_worker,
    manifest.action.default_popup, 'popup.css', 'popup.js']) {
    assert.ok((await readFile(new URL(name, folder), 'utf8')).length > 0);
  }
  for (const size of [16, 48, 128]) {
    const icon = await readFile(new URL(manifest.icons[size], folder));
    assert.deepEqual([...icon.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(icon.readUInt32BE(16), size);
    assert.equal(icon.readUInt32BE(20), size);
  }
  assert.doesNotMatch(await readFile(new URL('shadow-roots.js', folder), 'utf8'), /chrome\.|sendMessage|fetch\(/);
});

test('highlights existing magnets without boxes or text changes and keeps keyboard focus visible', async () => {
  const fixture = await setup({ buildDOM({ document, Element, append }) {
    const magnets = [magnet, ` MAGNET:${magnet.slice(7)} `].map(href => append(document, new Element(href)));
    const others = ['https://example.test/', null, 'magnet:?' + 'a'.repeat(16384)]
      .map(href => append(document, new Element(href)));
    const host = append(document, new Element(null, 'section'));
    const root = host.attachShadow({ mode: 'open' });
    const nested = append(root, new Element(magnet));
    const pageStyle = {};
    document.adoptedStyleSheets.push(pageStyle);
    return { magnets, others, root, nested, pageStyle };
  } });
  for (const anchor of fixture.built.magnets) assert.ok(anchor.classes.has('light-torrent-magnet-link'));
  for (const anchor of fixture.built.others) assert.equal(anchor.classes.size, 0);
  assert.ok(fixture.built.nested.classes.has('light-torrent-magnet-link'));
  assert.equal(fixture.document.adoptedStyleSheets[0], fixture.built.pageStyle);
  const sheet = fixture.document.adoptedStyleSheets[1];
  assert.equal(fixture.built.root.adoptedStyleSheets[0], sheet);
  const restingStyle = sheet.text.match(/a\.light-torrent-magnet-link\s*\{([^}]+)\}/)[1];
  assert.doesNotMatch(restingStyle, /outline\s*:/);
  assert.match(restingStyle, /rgba\(16, 185, 129, 0\.18\)/);
  assert.match(restingStyle, /text-decoration-line: underline/);
  assert.match(restingStyle, /text-decoration-color: rgba\(16, 185, 129, 0\.85\)/);
  assert.match(restingStyle, /text-decoration-thickness: 2px/);
  assert.match(sheet.text, /:hover.*:focus-visible/);
  assert.match(sheet.text, /rgba\(16, 185, 129, 0\.28\)/);
  assert.match(sheet.text, /:focus-visible\s*\{\s*outline: 2px solid #10b981/);
  assert.doesNotMatch(sheet.text, /(?:^|\n)\s*(?:background[\w-]*|color|padding|margin|border[\w-]*|font[\w-]*|content)\s*:/);
  assert.equal(fixture.confirmations.length, 0);
  assert.equal(fixture.nativeRequests.length, 0);
  assert.equal(fixture.tabs.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.observers[0].options)),
    { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
});

test('updates added links and href changes incrementally without document rescans', async () => {
  const fixture = await setup();
  const anchor = fixture.append(fixture.document, new fixture.Element(magnet));
  const scans = fixture.document.scans;
  fixture.notify(fixture.document, [{ type: 'childList', addedNodes: [anchor], removedNodes: [] }]);
  assert.ok(anchor.classes.has('light-torrent-magnet-link'));
  anchor.href = 'https://example.test/';
  fixture.notify(fixture.document, [{ type: 'attributes', target: anchor }]);
  assert.equal(anchor.classes.size, 0);
  anchor.href = ` MAGNET:${magnet.slice(7)} `;
  fixture.notify(fixture.document, [{ type: 'attributes', target: anchor }]);
  assert.ok(anchor.classes.has('light-torrent-magnet-link'));
  anchor.href = null;
  fixture.notify(fixture.document, [{ type: 'attributes', target: anchor }]);
  assert.equal(anchor.classes.size, 0);
  assert.equal(fixture.document.scans, scans);
  assert.equal(fixture.nativeRequests.length, 0);
});

test('detects late and nested open roots, ignores closed roots, and releases detached observers', async () => {
  const fixture = await setup();
  const host = fixture.append(fixture.document, new fixture.Element(null, 'section'));
  fixture.notify(fixture.document, [{ type: 'childList', addedNodes: [host], removedNodes: [] }]);
  host.dispatchEvent = () => { throw new Error('Page-specific dispatch must not be invoked.'); };
  fixture.context.Event = () => { throw new Error('Page-specific Event must not be invoked.'); };
  const root = host.attachShadow({ mode: 'open' });
  const anchor = fixture.append(root, new fixture.Element(magnet));
  fixture.notify(root, [{ type: 'childList', addedNodes: [anchor], removedNodes: [] }]);
  assert.ok(anchor.classes.has('light-torrent-magnet-link'));
  const nestedHost = fixture.append(root, new fixture.Element(null, 'section'));
  const nestedRoot = nestedHost.attachShadow({ mode: 'open' });
  const nestedLink = fixture.append(nestedRoot, new fixture.Element(magnet));
  fixture.notify(nestedRoot, [{ type: 'childList', addedNodes: [nestedLink], removedNodes: [] }]);
  assert.ok(nestedLink.classes.has('light-torrent-magnet-link'));
  const closedHost = fixture.append(fixture.document, new fixture.Element(null, 'section'));
  const notifications = fixture.rootNotifications.length;
  const closed = closedHost.attachShadow({ mode: 'closed' });
  fixture.append(closed, new fixture.Element(magnet));
  assert.equal(fixture.rootNotifications.length, notifications);
  assert.equal(fixture.observers.some(observer => observer.root === closed), false);
  assert.throws(() => closedHost.attachShadow({ mode: 'invalid' }), TypeError);
  root.adoptedStyleSheets = [];
  fixture.notify(root, [{ type: 'childList', addedNodes: [nestedHost], removedNodes: [] }]);
  assert.equal(root.adoptedStyleSheets[0], fixture.document.adoptedStyleSheets[0]);
  fixture.document.children.splice(fixture.document.children.indexOf(host), 1);
  host.parentNode = null;
  fixture.notify(fixture.document, [{ type: 'childList', addedNodes: [], removedNodes: [host] }]);
  assert.equal(fixture.observers.filter(observer => observer.active).length, 1);
  assert.equal(root.adoptedStyleSheets.length, 0);
  anchor.href = 'https://example.test/';
  fixture.append(fixture.document, host);
  fixture.notify(fixture.document, [{ type: 'childList', addedNodes: [host], removedNodes: [] }]);
  assert.equal(anchor.classes.size, 0);
  assert.ok(nestedLink.classes.has('light-torrent-magnet-link'));
  assert.equal(fixture.observers.filter(observer => observer.active).length, 3);
  assert.equal(fixture.nativeRequests.length, 0);
});

test('cancel intercepts native navigation but does not open a client tab', async () => {
  const fixture = await setup({ approved: false });
  const event = await fixture.click();
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  assert.equal(fixture.confirmations.length, 1);
  assert.match(fixture.confirmations[0], /Download this magnet link/);
  assert.match(fixture.confirmations[0], /adds this torrent to its queue immediately/);
  assert.doesNotMatch(fixture.confirmations[0], /click Add torrent/);
  assert.equal(fixture.tabs.length, 0);
  assert.equal(fixture.nativeRequests.length, 0);
});

test('approval opens only the fixed local client with an encoded fragment', async () => {
  const fixture = await setup();
  await fixture.click();
  assert.equal(fixture.tabs.length, 1);
  const url = new URL(fixture.tabs[0].url);
  assert.equal(url.origin, 'http://127.0.0.1:3000');
  assert.equal(url.search, '');
  assert.equal(new URLSearchParams(url.hash.slice(1)).get('magnet'), magnet);
  assert.equal(fixture.tabs[0].active, true);
  assert.equal(fixture.alerts.length, 0);
  assert.equal(fixture.nativeRequests.length, 1);
  assert.equal(fixture.nativeRequests[0].host, 'com.lighttorrent.launcher');
  assert.deepEqual(Object.keys(fixture.nativeRequests[0].request), ['action']);
  assert.equal(fixture.nativeRequests[0].request.action, 'start-client');
  assert.equal(fixture.nativePorts[0].disconnected, true);
});

test('concurrent approvals wait on one native port while the folder picker is open', async () => {
  const fixture = await setup({ deferNative: true });
  const first = fixture.dispatch({ type: 'open-light-torrent', magnet });
  const second = fixture.dispatch({ type: 'open-light-torrent', magnet });
  assert.equal(fixture.nativeRequests.length, 1);
  assert.equal(fixture.nativePorts[0].disconnected, false);
  assert.equal(fixture.tabs.length, 0);
  fixture.replyNative({ ok: true });
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  assert.equal(fixture.tabs.length, 2);
  assert.equal(fixture.nativePorts[0].disconnected, true);
});

test('canceling folder selection opens no tab and the next approval can retry', async () => {
  const fixture = await setup({ deferNative: true });
  const canceled = fixture.click();
  fixture.replyNative({ ok: false, error: 'Folder selection canceled. No download was started.' });
  await canceled;
  assert.equal(fixture.tabs.length, 0);
  assert.match(fixture.alerts[0], /Folder selection canceled/);
  const retry = fixture.click();
  fixture.replyNative({ ok: true });
  await retry;
  assert.equal(fixture.nativeRequests.length, 2);
  assert.equal(fixture.tabs.length, 1);
});

test('synthetic clicks, other links, and right clicks are left alone', async () => {
  const fixture = await setup();
  for (const options of [
    { trusted: false }, { href: 'https://example.test/file' }, { button: 2 },
    { type: 'auxclick', button: 2 }, { href: 'magnet:?' + 'a'.repeat(16384) }
  ]) {
    const event = await fixture.click(options);
    assert.equal(event.prevented, false);
  }
  assert.equal(fixture.confirmations.length, 0);
  assert.equal(fixture.tabs.length, 0);
  assert.equal(fixture.nativeRequests.length, 0);
});

test('middle clicks and uppercase magnet schemes are recognized', async () => {
  const fixture = await setup();
  await fixture.click({ type: 'auxclick', button: 1, href: ' MAGNET:' + magnet.slice(7) + ' ' });
  assert.equal(fixture.tabs.length, 1);
  const url = new URL(fixture.tabs[0].url);
  assert.equal(new URLSearchParams(url.hash.slice(1)).get('magnet'), magnet);
});

test('background refuses invalid senders and invalid magnet payloads', async () => {
  const fixture = await setup();
  for (const from of [
    { ...sender, id: 'another-extension' },
    { ...sender, tab: undefined },
    { ...sender, url: 'chrome-extension://light-torrent-test/page.html' }
  ]) {
    const result = await fixture.dispatch({ type: 'open-light-torrent', magnet }, from);
    assert.equal(result.ok, false);
  }
  assert.equal((await fixture.dispatch({ type: 'open-light-torrent', magnet: 'javascript:alert(1)' })).ok, false);
  assert.equal(fixture.tabs.length, 0);
  assert.equal(await fixture.dispatch({ type: 'unrelated' }), null);
});

test('inherited web origins in blank frames are accepted', async () => {
  const fixture = await setup();
  const result = await fixture.dispatch({ type: 'open-light-torrent', magnet }, {
    ...sender, url: 'about:blank', origin: 'https://example.test'
  });
  assert.equal(result.ok, true);
  assert.equal(fixture.tabs.length, 1);
});

test('tab creation failures are logged and shown rather than swallowed', async () => {
  const fixture = await setup({ tabError: 'Tabs unavailable' });
  const event = await fixture.click();
  assert.equal(event.prevented, true);
  assert.equal(fixture.tabs.length, 0);
  assert.match(fixture.alerts[0], /Tabs unavailable/);
  assert.equal(fixture.errors.length, 2);
});

test('native startup failure prevents opening a broken client tab', async () => {
  for (const options of [
    { nativeError: 'Native host not found' },
    { nativeResult: { ok: false, error: 'Client did not start' } },
    { nativeResult: null }
  ]) {
    const fixture = await setup(options);
    await fixture.click();
    assert.equal(fixture.tabs.length, 0);
    assert.equal(fixture.alerts.length, 1);
    assert.match(fixture.alerts[0], /could not open the client/);
  }
});

test('Safari approvals use the bundled native bridge rather than a Chromium host port', async () => {
  const fixture = await setup({ safari: true, deferNative: true });
  const first = fixture.click();
  const second = fixture.click();
  assert.equal(fixture.nativeRequests.length, 1);
  assert.equal(fixture.nativeRequests[0].host, 'com.lighttorrent.safari');
  assert.equal(fixture.nativeRequests[0].request.action, 'start-client');
  assert.equal(fixture.nativePorts.length, 0);
  assert.equal(fixture.tabs.length, 0);
  fixture.replyNative({ ok: true });
  await Promise.all([first, second]);
  assert.equal(fixture.tabs.length, 2);
  const popup = { id: sender.id, url: `safari-web-extension://${sender.id}/popup.html` };
  const changing = fixture.dispatch({ type: 'client-control', action: 'change-folder' }, popup);
  assert.equal(fixture.nativeRequests[1].request.action, 'change-folder');
  fixture.replyNative({ ok: true });
  assert.equal((await changing).ok, true);
});

test('Safari bridge failures open no tab, remain visible, and allow retry', async () => {
  for (const options of [
    { nativeError: 'Safari helper unavailable' },
    { nativeResult: { ok: false, error: 'Folder selection canceled' } },
    { nativeResult: null }
  ]) {
    const fixture = await setup({ safari: true, ...options });
    await fixture.click();
    await fixture.click();
    assert.equal(fixture.tabs.length, 0);
    assert.equal(fixture.nativePorts.length, 0);
    assert.equal(fixture.nativeRequests.length, 2);
    assert.equal(fixture.alerts.length, 2);
  }
});

test('only the toolbar can open downloads or change the final folder without a magnet', async () => {
  const fixture = await setup();
  const popup = { id: sender.id, url: `chrome-extension://${sender.id}/popup.html` };
  assert.equal((await fixture.dispatch({ type: 'client-control', action: 'open' }, popup)).ok, true);
  assert.equal(fixture.tabs[0].url, 'http://127.0.0.1:3000/');
  assert.equal(fixture.tabs[0].active, true);
  assert.equal((await fixture.dispatch({ type: 'client-control', action: 'change-folder' }, popup)).ok, true);
  assert.equal(fixture.nativeRequests[1].request.action, 'change-folder');
  assert.equal(fixture.tabs.length, 1);
  for (const from of [sender, { ...popup, id: 'another-extension' }, { ...popup, url: popup.url + '?fake' }]) {
    assert.equal((await fixture.dispatch({ type: 'client-control', action: 'change-folder' }, from)).ok, false);
  }
  for (const action of ['exec', null]) {
    assert.equal((await fixture.dispatch({ type: 'client-control', action }, popup)).ok, false);
  }
  assert.equal((await fixture.dispatch({ type: 'client-control', action: 'open', url: 'https://example.test' }, popup)).ok, false);
  assert.equal(fixture.nativeRequests.length, 2);
});

test('folder changes wait for startup and magnet approvals wait for an active folder change', async () => {
  const fixture = await setup({ deferNative: true });
  const popup = { id: sender.id, url: `chrome-extension://${sender.id}/popup.html` };
  const opening = fixture.dispatch({ type: 'client-control', action: 'open' }, popup);
  const changing = fixture.dispatch({ type: 'client-control', action: 'change-folder' }, popup);
  assert.equal(fixture.nativeRequests.length, 1);
  fixture.replyNative({ ok: true });
  assert.equal((await opening).ok, true);
  assert.equal(fixture.nativeRequests[1].request.action, 'change-folder');
  const approval = fixture.dispatch({ type: 'open-light-torrent', magnet });
  assert.equal(fixture.nativeRequests.length, 2);
  fixture.replyNative({ ok: true });
  assert.equal((await changing).ok, true);
  assert.equal((await approval).ok, true);
  assert.equal(fixture.tabs.length, 2);
});
