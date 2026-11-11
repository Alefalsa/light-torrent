import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function createPopup(send) {
  const elements = new Map();
  const errors = [];
  const messages = [];
  function element(selector) {
    if (!elements.has(selector)) {
      const classes = new Set();
      elements.set(selector, {
        textContent: '', disabled: false, role: '', handlers: new Map(),
        classList: { add: name => classes.add(name), remove: name => classes.delete(name),
          contains: name => classes.has(name) },
        setAttribute(name, value) { this[name] = value; },
        addEventListener(name, handler) { this.handlers.set(name, handler); }
      });
    }
    return elements.get(selector);
  }
  const context = vm.createContext({
    document: { querySelector: element },
    chrome: { runtime: { sendMessage: async message => {
      messages.push(message);
      return send(message);
    } } },
    console: { error: (...details) => errors.push(details) }
  });
  for (const script of ['shared.js', 'popup.js']) {
    vm.runInContext(await readFile(new URL(`../extension/${script}`, import.meta.url), 'utf8'), context);
  }
  return { element, messages, errors, click: selector => element(selector).handlers.get('click')() };
}

test('toolbar disables actions during a native dialog and restores them after success', async () => {
  let finish;
  const fixture = await createPopup(() => new Promise(resolve => { finish = resolve; }));
  const changing = fixture.click('#change-folder');
  assert.equal(fixture.element('#open-downloads').disabled, true);
  assert.equal(fixture.element('#change-folder').disabled, true);
  assert.match(fixture.element('#status').textContent, /Cancel keeps your current folder/);
  await fixture.click('#open-downloads');
  assert.equal(fixture.messages.length, 1);
  assert.equal(fixture.messages[0].action, 'change-folder');
  finish({ ok: true });
  await changing;
  assert.equal(fixture.element('#open-downloads').disabled, false);
  assert.equal(fixture.element('#change-folder').disabled, false);
  assert.match(fixture.element('#status').textContent, /New downloads use it; existing downloads stay/);
});

test('toolbar opens downloads and surfaces errors without swallowing them', async () => {
  const success = await createPopup(async () => ({ ok: true }));
  await success.click('#open-downloads');
  assert.equal(success.messages[0].type, 'client-control');
  assert.equal(success.messages[0].action, 'open');
  assert.equal(success.element('#status').textContent, 'Downloads opened.');
  for (const send of [
    async () => ({ ok: false, error: 'Folder selection canceled' }),
    async () => { throw new Error('Native helper is missing'); },
    async () => undefined
  ]) {
    const fixture = await createPopup(send);
    await fixture.click('#change-folder');
    assert.equal(fixture.errors.length, 1);
    assert.equal(fixture.element('#status').role, 'alert');
    assert.equal(fixture.element('#status').classList.contains('error'), true);
    assert.equal(fixture.element('#change-folder').disabled, false);
    assert.ok(fixture.element('#status').textContent);
  }
});
