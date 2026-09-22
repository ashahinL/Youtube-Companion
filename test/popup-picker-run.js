/**
 * Drives the Player tab's open-tab picker. Runs in its own process:
 * importing popup.js starts timers and fills the i18n cache, and either
 * one would leak into the rest of the suite.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { installChromeMock } from './helpers/chrome-mock.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];
const errors = [];

function check(label, ok, detail = '') {
  checks.push({ label, ok: !!ok, detail: detail ? String(detail) : '' });
}

process.on('unhandledRejection', (err) => {
  errors.push(err && err.stack ? err.stack : String(err));
});

function selectorParts(sel) {
  return sel.match(/(\.[^.#\[]+|\[[^\]]+\])/g) || [];
}

function matches(el, sel) {
  const parts = selectorParts(sel);
  if (!parts.length) return false;
  return parts.every((part) => {
    if (part.startsWith('.')) return el.className.split(/\s+/).includes(part.slice(1));
    const body = part.slice(1, -1);
    const eq = body.indexOf('=');
    if (eq < 0) return el.getAttribute(body) != null;
    let value = body.slice(eq + 1);
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    return el.getAttribute(body.slice(0, eq)) === value;
  });
}

class FakeEl {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this._data = {};
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this._text = '';
    this.id = '';
    this.title = '';
    this.type = '';
    this.value = '';
    this.parentElement = null;
    this.listeners = {};
    this.scrollWidth = 0;
    this.clientWidth = 0;
    this.style = {
      fontSize: '',
      setProperty() {},
      removeProperty() {},
      getPropertyValue() { return ''; },
    };
    const el = this;
    this.dataset = new Proxy(this._data, {
      get(obj, prop) { return obj[prop]; },
      set(obj, prop, value) {
        obj[prop] = String(value);
        const attr = 'data-' + String(prop).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
        el.attributes.set(attr, String(value));
        return true;
      },
    });
    this.classList = {
      add(...names) {
        const set = new Set(el.className.split(/\s+/).filter(Boolean));
        for (const name of names) set.add(name);
        el.className = [...set].join(' ');
      },
      remove(...names) {
        const drop = new Set(names);
        el.className = el.className.split(/\s+/).filter((name) => name && !drop.has(name)).join(' ');
      },
      toggle(name, force) {
        const has = el.className.split(/\s+/).includes(name);
        const on = force == null ? !has : !!force;
        if (on) this.add(name);
        else this.remove(name);
        return on;
      },
      contains: (name) => el.className.split(/\s+/).includes(name),
    };
  }

  get childElementCount() {
    return this.children.length;
  }

  get textContent() {
    if (this.children.length) return this.children.map((child) => child.textContent).join('');
    return this._text;
  }

  set textContent(value) {
    this._text = value == null ? '' : String(value);
    for (const child of this.children) child.parentElement = null;
    this.children.length = 0;
  }

  setAttribute(name, value) {
    const v = String(value);
    this.attributes.set(name, v);
    if (name.startsWith('data-')) {
      const prop = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this._data[prop] = v;
    }
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }

  removeEventListener() {}

  appendChild(child) {
    if (!child) return child;
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  replaceChildren(...nodes) {
    for (const child of this.children) child.parentElement = null;
    this.children.length = 0;
    for (const node of nodes) {
      if (node != null) this.appendChild(node);
    }
  }

  querySelectorAll(sel) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (matches(child, sel)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }

  contains(node) {
    if (node === this) return true;
    for (const child of this.children) {
      if (child.contains(node)) return true;
    }
    return false;
  }

  focus() {
    globalThis.document.activeElement = this;
  }

  click() {
    if (this.disabled) return;
    this.focus();
    const event = {
      target: this,
      currentTarget: this,
      preventDefault() {},
      stopPropagation() {},
    };
    for (const fn of this.listeners.click || []) fn(event);
  }
}

const REQUIRED = new Set([
  'watchlist-add-form', 'watchlist-input', 'watchlist-clear', 'watchlist-undo-btn',
  'feed-add-form', 'feed-filter', 'feed-clear', 'feed-refresh', 'feed-goto-watchlist',
  'feed-waiting-refresh', 'feed-filter-clear', 'feed-favorites-only', 'feed-more',
  'settings', 'settings-export', 'settings-import-file', 'settings-import',
  'settings-import-merge', 'settings-import-replace', 'settings-import-replace-confirm',
  'settings-import-replace-cancel', 'settings-clear', 'settings-clear-yes', 'settings-clear-cancel',
]);

function installDom() {
  const byId = new Map();
  const audioPanel = new FakeEl('section');
  audioPanel.id = 'audio';
  audioPanel.hidden = false;
  byId.set('audio', audioPanel);
  const picker = new FakeEl('div');
  picker.id = 'audio-picker';
  picker.hidden = true;
  byId.set('audio-picker', picker);

  const document = {
    documentElement: new FakeEl('html'),
    body: new FakeEl('body'),
    activeElement: null,
    createElement(tag) { return new FakeEl(tag); },
    createElementNS(_ns, tag) { return new FakeEl(tag); },
    getElementById(id) {
      if (byId.has(id)) return byId.get(id);
      if (!REQUIRED.has(id)) return null;
      const el = new FakeEl('div');
      el.id = id;
      byId.set(id, el);
      return el;
    },
    querySelectorAll(sel) {
      if (sel === '[role="tabpanel"]') return [audioPanel];
      return [];
    },
    querySelector(sel) {
      const found = this.querySelectorAll(sel);
      return found[0] || null;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  document.activeElement = document.body;
  globalThis.HTMLElement = FakeEl;
  globalThis.document = document;
  globalThis.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  globalThis.getComputedStyle = () => ({ direction: 'ltr', fontSize: '14px' });
  globalThis.CSS = globalThis.CSS || { escape(value) { return String(value); } };
  return { picker };
}

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function main() {
  const intervals = [];
  const origSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn, ms, ...args) => {
    const id = origSetInterval(fn, ms, ...args);
    intervals.push(id);
    return id;
  };
  const stopIntervals = () => {
    for (const id of intervals) clearInterval(id);
  };

  let closes = 0;
  globalThis.window = {
    close() { closes += 1; },
  };
  try {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { language: 'en-US', userAgent: 'node-test' },
    });
  } catch {
    // The snapshot below pins the popup to English either way.
  }

  const { picker } = installDom();
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'src/content/core.js'), 'utf8'), {
    filename: 'src/content/core.js',
  });

  const mock = installChromeMock();
  const ytTabs = [
    {
      id: 7,
      windowId: 3,
      active: true,
      title: '(2) Lecture - YouTube',
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
    },
    {
      id: 8,
      windowId: 9,
      active: false,
      title: 'Second video - YouTube',
      url: 'https://www.youtube.com/watch?v=bbbcccdddee',
    },
  ];
  globalThis.chrome.tabs.query = async (info) => {
    if (info && info.active && info.currentWindow) {
      const active = ytTabs.find((tab) => tab.active);
      return active ? [{ ...active }] : [];
    }
    if (info && info.url) return ytTabs.map((tab) => ({ ...tab }));
    return [];
  };
  globalThis.fetch = async (url) => {
    const rel = String(url).replace(/^chrome-extension:\/\/youtube-companion\//, '');
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    return { ok: true, async json() { return JSON.parse(text); } };
  };
  globalThis.chrome.runtime.sendMessage = async () => ({
    ok: true,
    settings: { ui: { locale: 'en', theme: 'system' } },
    channels: [],
    feed: [],
    queue: [],
    queueOpen: false,
    whatsNewSeen: '2.0',
    previousLastSeenAt: 0,
    pollState: {},
  });

  await import('../src/popup/popup.js');

  const appeared = await (async () => {
    const start = Date.now();
    while (Date.now() - start < 2000) {
      if (picker.querySelectorAll('.audio-picker__goto').length === 2) return true;
      await delay(20);
    }
    return false;
  })();
  stopIntervals();
  check(
    'picker draws a row for each open YouTube tab',
    appeared,
    errors.join('\n') || `hidden=${picker.hidden} children=${picker.childElementCount} listeners=${mock.tabUpdatedListeners.length}`,
  );
  if (!appeared) return;

  const rows = picker.querySelectorAll('.audio-picker__row');
  check('one row per tab', rows.length === 2 && picker.childElementCount === 2, String(picker.childElementCount));
  const select7 = picker.querySelector('.audio-picker__tab[data-tab-id="7"]');
  const select8 = picker.querySelector('.audio-picker__tab[data-tab-id="8"]');
  const go7 = picker.querySelector('[data-go-tab-id="7"]');
  const go8 = picker.querySelector('[data-go-tab-id="8"]');
  check('each row has a select button and a go-to button', !!(select7 && select8 && go7 && go8));
  check(
    'the go-to button is a sibling, not nested in the select button',
    select7.parentElement === go7.parentElement
      && !select7.contains(go7)
      && !go7.contains(select7)
      && select7.parentElement.className === 'audio-picker__row',
  );
  check('go-to shows the arrow and no other text', go7.textContent === '\u2197' && go8.textContent === '\u2197', go7.textContent);
  check(
    'go-to is named with the video title',
    go7.getAttribute('aria-label') === 'Go to the tab playing Lecture'
      && go7.title === 'Go to the tab playing Lecture'
      && go8.getAttribute('aria-label') === 'Go to the tab playing Second video'
      && go8.title === 'Go to the tab playing Second video',
    JSON.stringify({ a: go7.getAttribute('aria-label'), b: go8.getAttribute('aria-label') }),
  );
  check(
    'the select button keeps its own name',
    select7.getAttribute('aria-label') === 'Play Lecture'
      && select8.getAttribute('aria-label') === 'Play Second video',
    select7.getAttribute('aria-label'),
  );
  check(
    'the active tab is current and neither button is disabled',
    select7.getAttribute('aria-current') === 'true'
      && select8.getAttribute('aria-current') == null
      && select7.disabled === false
      && select8.disabled === false
      && go7.disabled === false
      && go8.disabled === false,
  );

  function fireTabUpdated(change) {
    for (const fn of mock.tabUpdatedListeners) fn(0, change);
  }

  const sentBeforeRefresh = mock.messagesSent.length;
  const go8Before = go8;
  fireTabUpdated({ status: 'complete' });
  await delay(250);
  stopIntervals();
  check(
    'an unchanged list keeps the same go-to button',
    picker.querySelector('[data-go-tab-id="8"]') === go8Before
      && mock.messagesSent.length > sentBeforeRefresh,
    `same=${picker.querySelector('[data-go-tab-id="8"]') === go8Before} sent=${mock.messagesSent.length}`,
  );

  picker.querySelector('[data-go-tab-id="8"]').focus();
  ytTabs[1].title = 'Renamed video - YouTube';
  fireTabUpdated({ title: ytTabs[1].title });
  await delay(250);
  stopIntervals();
  const go8Next = picker.querySelector('[data-go-tab-id="8"]');
  check(
    'rebuilding restores focus to the go-to button',
    go8Next !== go8Before && globalThis.document.activeElement === go8Next,
    globalThis.document.activeElement?.dataset?.goTabId || globalThis.document.activeElement?.dataset?.tabId || '',
  );

  picker.querySelector('.audio-picker__tab[data-tab-id="7"]').focus();
  ytTabs[0].title = 'Lecture retitled - YouTube';
  fireTabUpdated({ title: ytTabs[0].title });
  await delay(250);
  stopIntervals();
  const select7Next = picker.querySelector('.audio-picker__tab[data-tab-id="7"]');
  check(
    'rebuilding restores focus to the select button',
    globalThis.document.activeElement === select7Next
      && select7Next.dataset.tabId === '7'
      && !select7Next.dataset.goTabId,
    globalThis.document.activeElement?.className || '',
  );

  mock.tabsUpdated.length = 0;
  mock.windowsUpdated.length = 0;
  const sentBeforeSelect = mock.messagesSent.length;
  const closesBeforeSelect = closes;
  picker.querySelector('.audio-picker__tab[data-tab-id="8"]').click();
  await delay(40);
  stopIntervals();
  const afterSelect = await globalThis.chrome.storage.session.get('audioLastSelectedTabId');
  const current = picker.querySelector('[aria-current="true"]');
  check(
    'choosing a row still drives that tab from the player',
    afterSelect.audioLastSelectedTabId === 8
      && current?.dataset?.tabId === '8'
      && current?.className?.includes('audio-picker__tab')
      && mock.messagesSent.slice(sentBeforeSelect).some((row) => (
        row.tabId === 8 && row.message?.type === 'audioMode.player'
      ))
      && mock.tabsUpdated.length === 0
      && mock.windowsUpdated.length === 0
      && closes === closesBeforeSelect,
    JSON.stringify({
      stored: afterSelect.audioLastSelectedTabId,
      current: current?.dataset?.tabId,
      tabs: mock.tabsUpdated,
      windows: mock.windowsUpdated,
      closes,
    }),
  );

  mock.tabsUpdated.length = 0;
  mock.windowsUpdated.length = 0;
  const sentBeforeGo = mock.messagesSent.length;
  const closesBeforeGo = closes;
  picker.querySelector('[data-go-tab-id="7"]').click();
  await delay(40);
  stopIntervals();
  const afterGo = await globalThis.chrome.storage.session.get('audioLastSelectedTabId');
  const still = picker.querySelector('[aria-current="true"]');
  check(
    'go-to activates that tab and focuses its window',
    mock.tabsUpdated.length === 1
      && mock.tabsUpdated[0].tabId === 7
      && mock.tabsUpdated[0].active === true
      && mock.windowsUpdated.length === 1
      && mock.windowsUpdated[0].windowId === 3
      && mock.windowsUpdated[0].focused === true
      && closes === closesBeforeGo + 1,
    JSON.stringify({ tabs: mock.tabsUpdated, windows: mock.windowsUpdated, closes }),
  );
  check(
    'go-to does not change which tab the player drives',
    afterGo.audioLastSelectedTabId === 8
      && still?.dataset?.tabId === '8'
      && mock.messagesSent.length === sentBeforeGo,
    JSON.stringify({ stored: afterGo.audioLastSelectedTabId, current: still?.dataset?.tabId, sent: mock.messagesSent.length - sentBeforeGo }),
  );

  // The player keeps its current tab whenever that tab is still open, so
  // drop it. With nothing left to drive, the select buttons disable and
  // the go-to buttons must not.
  const savedTabs = ytTabs.map((tab) => ({ ...tab }));
  const origPick = globalThis.AudioModeCore.pickTargetTab;
  globalThis.AudioModeCore.pickTargetTab = () => null;
  ytTabs.length = 0;
  ytTabs.push(
    {
      id: 7,
      windowId: 3,
      active: true,
      title: 'Lecture retitled - YouTube',
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
    },
    {
      id: 11,
      windowId: 4,
      active: false,
      title: 'Third video - YouTube',
      url: 'https://www.youtube.com/watch?v=cccdddeeeff',
    },
  );
  fireTabUpdated({ title: 'Third video - YouTube' });
  await delay(250);
  stopIntervals();
  const unreachableSelect = picker.querySelector('.audio-picker__tab[data-tab-id="7"]');
  const unreachableGo = picker.querySelector('[data-go-tab-id="7"]');
  check(
    'go-to stays enabled when the player cannot reach the tab',
    !!unreachableSelect && unreachableSelect.disabled === true && !!unreachableGo && unreachableGo.disabled === false,
    JSON.stringify({ select: unreachableSelect?.disabled, go: unreachableGo?.disabled, rows: picker.childElementCount }),
  );
  const sentWhileDisabled = mock.messagesSent.length;
  unreachableSelect.click();
  await delay(40);
  check(
    'a disabled select button does not run',
    mock.messagesSent.length === sentWhileDisabled,
    String(mock.messagesSent.length - sentWhileDisabled),
  );
  globalThis.AudioModeCore.pickTargetTab = origPick;
  ytTabs.length = 0;
  for (const tab of savedTabs) ytTabs.push({ ...tab });
  fireTabUpdated({ status: 'complete' });
  await delay(250);
  stopIntervals();

  delete ytTabs[1].windowId;
  ytTabs[1].title = 'No window - YouTube';
  fireTabUpdated({ title: ytTabs[1].title });
  await delay(250);
  stopIntervals();
  mock.tabsUpdated.length = 0;
  mock.windowsUpdated.length = 0;
  const closesBeforeMissing = closes;
  picker.querySelector('[data-go-tab-id="8"]').click();
  await delay(40);
  stopIntervals();
  check(
    'a tab with no window id is activated and the popup still closes',
    mock.tabsUpdated.length === 1
      && mock.tabsUpdated[0].tabId === 8
      && mock.tabsUpdated[0].active === true
      && mock.windowsUpdated.length === 0
      && closes === closesBeforeMissing + 1,
    JSON.stringify({ tabs: mock.tabsUpdated, windows: mock.windowsUpdated, closes }),
  );

  ytTabs.splice(1, 1);
  globalThis.chrome.tabs.update = async () => {
    throw new Error('No tab with id: 8');
  };
  mock.windowsUpdated.length = 0;
  const closesBeforeThrow = closes;
  const gone = picker.querySelector('[data-go-tab-id="8"]');
  gone.click();
  await delay(40);
  stopIntervals();
  check(
    'a missing tab leaves the popup open and drops out of the list',
    closes === closesBeforeThrow
      && mock.windowsUpdated.length === 0
      && picker.hidden === true
      && picker.childElementCount === 0,
    JSON.stringify({ closes, hidden: picker.hidden, children: picker.childElementCount, windows: mock.windowsUpdated, errors }),
  );
}

main().catch((err) => {
  check('picker run threw', false, err && err.stack ? err.stack : String(err));
}).finally(() => {
  console.log('PICKER_RESULT ' + JSON.stringify({ checks }));
});
