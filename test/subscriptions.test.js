/**
 * Subscription scan: the MAIN-world row shaper, and the overlay the
 * isolated script paints from a worker result. Loads the classic scripts
 * in node:vm the way Chrome will. No network.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const injectSrc = read('src/content/inject.js');
const coreSrc = read('src/content/core.js');
const contentSrc = read('src/content/content.js');

const PAGE = 'https://www.youtube.com';
const TOKEN = 'ab'.repeat(32);

function uc(n) {
  return `UC${String(n).padStart(22, '0')}`;
}

function channelRow(opts) {
  const data = {};
  if (opts.id !== undefined) data.channelId = opts.id;
  if (opts.simpleText !== undefined) data.title = { simpleText: opts.simpleText };
  if (opts.subscribed !== undefined) data.subscriptionButton = { subscribed: opts.subscribed };
  const row = {
    data,
    querySelector(sel) {
      if (sel === 'a[href^="/@"]') {
        if (typeof opts.href === 'string' && opts.href.startsWith('/@')) {
          return { getAttribute() { return opts.href; } };
        }
        return null;
      }
      if (sel === '#text' || sel === '#channel-title') {
        if (opts.visible == null) return null;
        return { textContent: opts.visible };
      }
      return null;
    },
  };
  if (opts.explode) {
    Object.defineProperty(row, 'data', { get() { throw new Error('data'); } });
  }
  return row;
}

function loadInject() {
  const state = { rows: [], explode: false, missing: false };
  const posts = [];
  const sandbox = {
    __ytcHarness: true,
    document: {
      querySelectorAll(sel) {
        if (state.explode) throw new Error('boom');
        if (state.missing) return null;
        if (sel === 'ytd-channel-renderer') return state.rows;
        return [];
      },
      querySelector() { return null; },
      getElementById() { return null; },
    },
    addEventListener(type, fn) {
      if (!this._listeners) this._listeners = [];
      this._listeners.push({ type, fn });
    },
    postMessage(data, origin) {
      posts.push({ data, origin });
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(injectSrc, sandbox, { filename: 'src/content/inject.js' });
  const win = vm.runInContext('globalThis', sandbox);
  function fire(event) {
    const list = sandbox._listeners || win._listeners || [];
    for (const { type, fn } of list) {
      if (type === 'message') fn(event);
    }
  }
  return { state, posts, fire, win, bridge: sandbox.AudioModeBridge || win.AudioModeBridge };
}

function makeNode(tag) {
  return {
    tag,
    id: '',
    className: '',
    textContent: '',
    type: '',
    attrs: {},
    style: {},
    children: [],
    listeners: [],
    setAttribute(name, value) { this.attrs[name] = String(value); },
    removeAttribute(name) { delete this.attrs[name]; },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name); },
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(type, fn) { this.listeners.push({ type, fn }); },
    querySelector(sel) {
      const want = sel.startsWith('.') ? sel.slice(1) : '';
      const walk = (node) => {
        if (want && node.className === want) return node;
        for (const child of node.children) {
          const found = walk(child);
          if (found) return found;
        }
        return null;
      };
      return walk(this);
    },
  };
}

function loadContent() {
  const sent = [];
  const listeners = [];
  const doc = {
    documentElement: makeNode('html'),
    body: makeNode('body'),
    addEventListener() {},
    createElement(tag) { return makeNode(tag); },
    getElementById(id) {
      const walk = (node) => {
        if (!node) return null;
        if (node.id === id) return node;
        for (const child of node.children || []) {
          const found = walk(child);
          if (found) return found;
        }
        return null;
      };
      return walk(doc.documentElement) || walk(doc.body);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  const packs = {
    en: {
      scanTitle: 'Scanning your channels',
      scanStay: 'Do not close this tab',
      scanFound: 'channels found',
      scanLoaded: 'Channels loaded ($1)',
      scanAdded: 'Added $1 channels',
      scanAddedOne: 'Added $1 channel',
      scanSkipped: '$1 were already on your list',
      scanSkippedOne: '$1 was already on your list',
      scanNothing: 'Every channel is already on your list',
      scanSignedOut: 'Sign in to YouTube to import your subscriptions',
      scanSignedOutFile: 'A Google Takeout file works too.',
      scanFailed: 'Could not read your subscriptions',
      scanDone: 'Done',
    },
    ar: {
      scanTitle: 'جارٍ فحص قنواتك',
      scanStay: 'لا تُغلق هذا التبويب',
      scanFound: 'القنوات التي وُجدت:',
      scanLoaded: 'القنوات المحمّلة: $1',
      scanAdded: 'القنوات المضافة: $1',
      scanAddedOne: 'القنوات المضافة: $1',
      scanSkipped: 'موجودة في قائمتك: $1',
      scanSkippedOne: 'موجودة في قائمتك: $1',
      scanNothing: 'كل القنوات موجودة في قائمتك',
      scanSignedOut: 'سجّل الدخول إلى يوتيوب لاستيراد اشتراكاتك',
      scanSignedOutFile: 'ملف Google Takeout يعمل أيضًا.',
      scanFailed: 'تعذّر قراءة اشتراكاتك',
      scanDone: 'تم',
    },
  };
  let locale = 'en';
  const sandbox = {
    __ytcHarness: true,
    URL,
    setTimeout,
    clearTimeout,
    location: { pathname: '/watch' },
    document: doc,
    navigator: { language: 'en' },
    chrome: {
      runtime: {
        id: 'ext',
        getURL() { return 'chrome-extension://ext/'; },
        sendMessage(msg) {
          sent.push(msg);
          if (msg && msg.type === 'audioMode.boot') {
            return Promise.resolve({
              locale,
              overlay: packs[locale],
              overlays: packs,
            });
          }
          return Promise.resolve(null);
        },
        onMessage: {
          addListener(fn) { listeners.push(fn); },
        },
      },
      storage: {
        local: {
          get() { return Promise.resolve({ settings: { ui: { locale } } }); },
        },
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  vm.createContext(sandbox);
  vm.runInContext(coreSrc, sandbox, { filename: 'src/content/core.js' });
  vm.runInContext(contentSrc, sandbox, { filename: 'src/content/content.js' });
  const win = vm.runInContext('globalThis', sandbox);
  return {
    sent,
    listeners,
    doc,
    packs,
    setLocale(next) { locale = next; },
    api: sandbox.AudioModeContent || win.AudioModeContent,
  };
}

function textOf(root, cls) {
  const node = root && root.querySelector && root.querySelector(`.${cls}`);
  return node ? node.textContent : '';
}

export default async function run(t) {
  t.section('row shaping');

  const loaded = loadInject();
  const bridge = loaded.bridge;
  t.check('the bridge exports the reader', typeof bridge.readSubscribedChannels === 'function');
  t.check('subscribedChannels takes no arguments', bridge.isAllowedCall('subscribedChannels', []) === true);
  t.check('subscribedChannels refuses an argument', bridge.isAllowedCall('subscribedChannels', ['x']) === false);

  const border = `UC${'b'.repeat(20)}`;
  loaded.state.rows = [
    channelRow({ id: uc(1), simpleText: '  Alpha  ', href: '/@alpha', subscribed: true }),
    channelRow({ id: uc(1), simpleText: 'Second', href: '/@second', subscribed: true }),
    channelRow({ id: uc(2), simpleText: 'Beta', href: '/@beta/videos?si=1', subscribed: true }),
    channelRow({ id: uc(3), simpleText: 'Nope', href: '/@nope', subscribed: false }),
    channelRow({ id: uc(4), simpleText: 'No button', href: '/@nobtn' }),
    channelRow({ id: `UC${'a'.repeat(19)}`, simpleText: 'Short', href: '/@short', subscribed: true }),
    channelRow({ id: border, simpleText: 'Border', href: '/@border', subscribed: true }),
    channelRow({ id: 'not-a-channel', simpleText: 'Bad', href: '/@bad', subscribed: true }),
    channelRow({ id: uc(5), visible: 'Visible Name', href: '/@visible', subscribed: true }),
    channelRow({ id: uc(6), simpleText: '', visible: 'Should not use', subscribed: true }),
    channelRow({ id: uc(7), simpleText: 'True string', href: '/@ts', subscribed: 'true' }),
    channelRow({ id: uc(8), simpleText: 'Z'.repeat(250), href: '/@long?x=1', subscribed: true }),
    channelRow({ id: uc(9), simpleText: 'Boom', href: '/@boom', subscribed: true, explode: true }),
    channelRow({ id: uc(10), simpleText: 'After', href: '/@after', subscribed: true }),
  ];
  const shaped = bridge.readSubscribedChannels();
  t.check(
    'keeps subscribed rows, the first id, the visible name, and the path handle',
    JSON.stringify(shaped) === JSON.stringify([
      { id: uc(1), title: 'Alpha', handle: '@alpha' },
      { id: uc(2), title: 'Beta', handle: '@beta' },
      { id: border, title: 'Border', handle: '@border' },
      { id: uc(5), title: 'Visible Name', handle: '@visible' },
      { id: uc(6), title: '', handle: '' },
      { id: uc(8), title: 'Z'.repeat(200), handle: '@long' },
      { id: uc(10), title: 'After', handle: '@after' },
    ]),
    JSON.stringify(shaped),
  );

  loaded.state.rows = Array.from({ length: 2001 }, (_, i) => (
    channelRow({ id: uc(i), simpleText: `N${i}`, href: `/@n${i}`, subscribed: true })
  ));
  const capped = bridge.readSubscribedChannels();
  t.check(
    'the list stops at 2,000',
    capped.length === 2000 && capped[0].id === uc(0) && capped[1999].id === uc(1999),
    String(capped.length),
  );

  loaded.state.explode = true;
  t.check('a document that throws yields nothing', bridge.readSubscribedChannels().length === 0);
  loaded.state.explode = false;
  loaded.state.missing = true;
  t.check('a missing node list yields nothing', bridge.readSubscribedChannels().length === 0);

  loaded.state.missing = false;
  loaded.state.rows = [
    channelRow({ id: uc(1), simpleText: 'Alpha', href: '/@alpha', subscribed: true }),
  ];
  loaded.fire({
    source: loaded.win,
    origin: PAGE,
    data: { type: TOKEN, dir: 'adopt' },
  });
  loaded.posts.length = 0;
  loaded.fire({
    source: loaded.win,
    origin: PAGE,
    data: { type: TOKEN, dir: 'request', id: 4, method: 'subscribedChannels', args: [] },
  });
  const posted = loaded.posts[0] && loaded.posts[0].data;
  t.check(
    'a subscribedChannels request is answered with the rows',
    posted && posted.ok === true && posted.id === 4 && posted.result && posted.result.length === 1
      && posted.result[0].handle === '@alpha',
    JSON.stringify(posted),
  );

  t.section('the scan overlay');

  const page = loadContent();
  t.check('the content script exports the scan', typeof page.api.scanSubscriptions === 'function');
  let created = 0;
  const origCreate = page.doc.createElement;
  page.doc.createElement = (tag) => {
    created += 1;
    return origCreate(tag);
  };
  const wrong = await page.api.scanSubscriptions();
  t.check(
    'a tab that is not All subscriptions is refused before any paint',
    wrong.ok === false && wrong.error === 'wrongPage' && created === 0,
    JSON.stringify(wrong),
  );

  await new Promise((resolve) => { setTimeout(resolve, 0); });
  t.check('boot registered a listener', page.listeners.length === 1, String(page.listeners.length));
  let replied = null;
  const returned = page.listeners[0]({ type: 'subscriptions.scan' }, {}, (res) => { replied = res; });
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  t.check(
    'subscriptions.scan answers asynchronously',
    returned === true && replied && replied.error === 'wrongPage',
    JSON.stringify({ returned, replied }),
  );

  await page.api.showScanResult({ error: 'nope' });
  const overlay = page.doc.getElementById('ytc-scan-overlay');
  t.check('a failure paints one overlay', !!overlay && overlay.getAttribute('dir') === 'ltr');
  t.check(
    'the failure names the problem and offers Done',
    textOf(overlay, 'ytc-scan-title') === 'Could not read your subscriptions'
      && textOf(overlay, 'ytc-scan-done') === 'Done'
      && !overlay.querySelector('.ytc-scan-done').hasAttribute('hidden'),
    textOf(overlay, 'ytc-scan-title'),
  );

  await page.api.showScanResult({ added: 2, skipped: 1 });
  t.check(
    'added channels name the count and how many were already on the list',
    textOf(overlay, 'ytc-scan-title') === 'Added 2 channels'
      && textOf(overlay, 'ytc-scan-sub') === '1 was already on your list',
    `${textOf(overlay, 'ytc-scan-title')} | ${textOf(overlay, 'ytc-scan-sub')}`,
  );
  await page.api.showScanResult({ added: 1, skipped: 0 });
  t.check(
    'one added channel uses the singular and hides the skipped line',
    textOf(overlay, 'ytc-scan-title') === 'Added 1 channel'
      && overlay.querySelector('.ytc-scan-sub').hasAttribute('hidden'),
    textOf(overlay, 'ytc-scan-title'),
  );
  await page.api.showScanResult({ added: 0, skipped: 4 });
  t.check(
    'nothing new says the list already has them',
    textOf(overlay, 'ytc-scan-title') === 'Every channel is already on your list',
  );
  await page.api.showScanResult({ error: 'signedOut' });
  t.check(
    'signed out points at YouTube and at a Takeout file',
    textOf(overlay, 'ytc-scan-title') === 'Sign in to YouTube to import your subscriptions'
      && textOf(overlay, 'ytc-scan-sub') === 'A Google Takeout file works too.',
    textOf(overlay, 'ytc-scan-title'),
  );

  page.setLocale('ar');
  await page.api.showScanResult({ added: 3, skipped: 2 });
  t.check(
    'Arabic is right to left and does not inflect the count',
    overlay.getAttribute('dir') === 'rtl'
      && textOf(overlay, 'ytc-scan-title') === 'القنوات المضافة: 3'
      && textOf(overlay, 'ytc-scan-sub') === 'موجودة في قائمتك: 2'
      && textOf(overlay, 'ytc-scan-done') === 'تم',
    `${overlay.getAttribute('dir')} | ${textOf(overlay, 'ytc-scan-title')} | ${textOf(overlay, 'ytc-scan-sub')}`,
  );

  const button = overlay.querySelector('.ytc-scan-done');
  const click = button.listeners.find((entry) => entry.type === 'click');
  click.fn({ preventDefault() {}, stopPropagation() {} });
  t.check(
    'Done asks the worker to close this tab',
    page.sent.some((msg) => msg && msg.type === 'subscriptions.close'),
    JSON.stringify(page.sent.map((msg) => msg && msg.type)),
  );
  t.check(
    'the overlay is not created again',
    page.doc.documentElement.children.filter((node) => node.id === 'ytc-scan-overlay').length === 1,
  );
}
