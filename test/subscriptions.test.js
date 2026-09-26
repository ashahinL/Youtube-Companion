/**
 * Subscription scan: the MAIN-world row shaper, and the overlay the
 * isolated script paints from a worker result. Loads the classic scripts
 * in node:vm the way Chrome will. No network.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  parseAccountSwitcher,
  parseSubscriptionsHtml,
  takeAccountPage,
} from '../src/lib/subscriptions-page.js';

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
    appendChild(child) {
      child.parent = this;
      this.children.push(child);
      return child;
    },
    remove() {
      const parent = this.parent;
      if (parent && Array.isArray(parent.children)) {
        const index = parent.children.indexOf(this);
        if (index >= 0) parent.children.splice(index, 1);
      }
      this.parent = null;
    },
    click() { this.clicked = true; },
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

function loadContent(opts = {}) {
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
      scanAccount: 'Account $1',
      scanAccountScan: 'Scan',
      scanAnother: 'Import another account',
      scanExpired: 'Start the import again from the extension',
      scanDifferTitle: 'Your watchlist and this account differ',
      scanDifferLine: '$1 new on YouTube · $2 on your watchlist only',
      scanAddNew: 'Add new',
      scanReplaceList: 'Replace watchlist',
      scanReplaceWarn: 'Your current watchlist will be replaced. $1 channels will be deleted from it, with their videos. There is no undo.',
      scanReplaceWarnOne: 'Your current watchlist will be replaced. $1 channel will be deleted from it, with their videos. There is no undo.',
      scanReplaceExport: 'Export my list first',
      scanReplaceDelete: 'Delete and replace',
      scanReplaceCancel: 'Cancel',
      scanExportSaved: 'Saved $1',
      scanExportFailed: 'Could not save the backup',
      scanRemoved: 'Removed $1 channels',
      scanRemovedOne: 'Removed $1 channel',
      scanRemovedNames: 'Removed: $1',
      scanRemovedNamesMore: 'Removed: $1 and others',
      scanReplaceEmpty: 'Nothing was changed. An empty list cannot replace your watchlist.',
      scanChoose: 'Choose an account',
      scanStay: 'Do not close this tab',
      scanAccountChannels: '$1 channels',
      scanAccountNone: 'No subscriptions',
      scanAccountUncounted: 'Channels not counted',
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
      scanAccount: 'الحساب: $1',
      scanAnother: 'استيراد حساب آخر',
      scanDifferTitle: 'قائمتك وهذا الحساب مختلفان',
      scanDifferLine: 'جديد على يوتيوب: $1 · في قائمتك فقط: $2',
      scanAddNew: 'أضف الجديد',
      scanReplaceList: 'استبدال القائمة',
      scanReplaceWarn: 'ستُستبدل قائمتك الحالية. القنوات التي ستُحذف منها: $1، مع فيديوهاتها. لا يمكن التراجع.',
      scanReplaceWarnOne: 'ستُستبدل قائمتك الحالية. القنوات التي ستُحذف منها: $1، مع فيديوهاتها. لا يمكن التراجع.',
      scanRemoved: 'القنوات المحذوفة: $1',
      scanRemovedOne: 'القنوات المحذوفة: $1',
      scanRemovedNames: 'حُذفت: $1',
      scanRemovedNamesMore: 'حُذفت: $1 وغيرها',
      scanExportSaved: 'تم الحفظ: $1',
    },
  };
  let locale = 'en';
  const sandbox = {
    __ytcHarness: true,
    URL,
    Blob,
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
  // Inside the context `window` is the context's own global, so bridge
  // events must come from that object to pass the source check.
  let inner = sandbox;
  if (opts.bridge) {
    // A stand-in for inject.js: adopts any token, answers sessionIndex and
    // subscribedChannels from opts.bridge, on /feed/channels with rows.
    const onMessage = [];
    sandbox.setInterval = setInterval;
    sandbox.clearInterval = clearInterval;
    // Node's getRandomValues refuses a Uint8Array from another realm.
    sandbox.crypto = {
      getRandomValues(bytes) {
        for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) % 256;
        return bytes;
      },
    };
    sandbox.location = { pathname: '/feed/channels' };
    doc.querySelectorAll = (sel) => (sel === 'ytd-channel-renderer' ? [{}] : []);
    sandbox.addEventListener = (type, fn) => { if (type === 'message') onMessage.push(fn); };
    sandbox.removeEventListener = (type, fn) => {
      const i = onMessage.indexOf(fn);
      if (i >= 0) onMessage.splice(i, 1);
    };
    sandbox.postMessage = (data) => {
      let reply = null;
      if (data.dir === 'adopt') reply = { type: data.type, dir: 'ready' };
      if (data.dir === 'request' && data.method in opts.bridge) {
        reply = { type: data.type, dir: 'response', id: data.id, ok: true, result: opts.bridge[data.method] };
      }
      if (!reply) return;
      setTimeout(() => {
        for (const fn of onMessage.slice()) fn({ source: inner, origin: PAGE, data: reply });
      }, 0);
    };
  }
  vm.createContext(sandbox);
  if (opts.bridge) inner = vm.runInContext('globalThis', sandbox);
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
    win,
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
  t.check('sessionIndex takes no arguments', bridge.isAllowedCall('sessionIndex', []) === true);
  t.check('sessionIndex refuses an argument', bridge.isAllowedCall('sessionIndex', [0]) === false);
  loaded.win.ytcfg = { get(key) { return key === 'SESSION_INDEX' ? 1 : undefined; } };
  t.check('sessionIndex reads ytcfg.get', bridge.readSessionIndex() === 1);
  loaded.posts.length = 0;
  loaded.fire({
    source: loaded.win,
    origin: PAGE,
    data: { type: TOKEN, dir: 'request', id: 8, method: 'sessionIndex', args: [] },
  });
  t.check(
    'a sessionIndex request is answered with the number',
    loaded.posts[0]?.data?.ok === true && loaded.posts[0]?.data?.result === 1,
    JSON.stringify(loaded.posts[0]?.data),
  );
  loaded.win.ytcfg = { data_: { SESSION_INDEX: '3' } };
  t.check('sessionIndex falls back to ytcfg.data_', bridge.readSessionIndex() === 3);
  loaded.win.ytcfg = { get() { throw new Error('no'); } };
  t.check('a throwing ytcfg answers null', bridge.readSessionIndex() === null);

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

  const staleRows = [{ id: 'UCAAAAAAAAAAAAAAAAAAAAAA', title: 'Old account' }];
  const stale = loadContent({ bridge: { sessionIndex: 0, subscribedChannels: staleRows } });
  const staleAnswer = await stale.api.scanSubscriptions({ index: 2 });
  t.check(
    'a page on another account refuses a scan meant for account 2',
    staleAnswer.ok === false && staleAnswer.error === 'wrongAccount',
    JSON.stringify(staleAnswer),
  );
  t.check(
    'and paints nothing over the old page',
    !stale.doc.getElementById('ytc-scan-overlay'),
  );
  const fresh = loadContent({ bridge: { sessionIndex: 2, subscribedChannels: staleRows } });
  const freshAnswer = await fresh.api.scanSubscriptions({ index: 2 });
  t.check(
    'the page on the wanted account is read',
    freshAnswer.ok === true && freshAnswer.channels.length === 1,
    JSON.stringify(freshAnswer),
  );
  const unknown = loadContent({ bridge: { sessionIndex: null, subscribedChannels: staleRows } });
  const unknownAnswer = await unknown.api.scanSubscriptions({ index: 2 });
  t.check(
    'an unreadable session is not treated as another account',
    unknownAnswer.ok === true,
    JSON.stringify(unknownAnswer),
  );
  const noIndex = loadContent({ bridge: { sessionIndex: 0, subscribedChannels: staleRows } });
  const noIndexAnswer = await noIndex.api.scanSubscriptions();
  t.check('a scan that names no account is read as before', noIndexAnswer.ok === true, JSON.stringify(noIndexAnswer));

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

  t.section('account pages');

  const varHtml = read('test/fixtures/channels.account-var.html');
  const windowHtml = read('test/fixtures/channels.account-window.html');
  const emptyHtml = read('test/fixtures/channels.account-empty.html');
  const jsonHtml = read('test/fixtures/channels.account-json.html');
  const fromVar = parseSubscriptionsHtml(varHtml);
  t.check(
    'var ytInitialData keeps subscribed rows, the continuation, and the largest avatar',
    fromVar.sessionIndex === 0
      && fromVar.subscribed === 2
      && fromVar.continuation === true
      && fromVar.avatar === 'https://yt3.ggpht.com/acct=s176',
    JSON.stringify(fromVar),
  );
  const fromWindow = parseSubscriptionsHtml(windowHtml);
  t.check(
    'window["ytInitialData"] reads a string session index and drops a bad picture',
    fromWindow.sessionIndex === 1
      && fromWindow.subscribed === 1
      && fromWindow.continuation === false
      && fromWindow.avatar === '',
    JSON.stringify(fromWindow),
  );
  const fromEmpty = parseSubscriptionsHtml(emptyHtml);
  t.check(
    'an account with no channel rows is still that account',
    fromEmpty.sessionIndex === 2 && fromEmpty.subscribed === 0 && fromEmpty.continuation === false,
    JSON.stringify(fromEmpty),
  );
  const fromJson = parseSubscriptionsHtml(jsonHtml);
  t.check(
    'JSON.parse of a <script type="application/json"> is read too',
    fromJson.sessionIndex === 3
      && fromJson.subscribed === 2
      && fromJson.continuation === false
      && fromJson.avatar === 'https://yt3.ggpht.com/json=s88',
    JSON.stringify(fromJson),
  );
  const unreadable = parseSubscriptionsHtml('<script>ytcfg.set({"SESSION_INDEX":"4"});</script>');
  t.check(
    'a page whose data cannot be read is not counted as empty',
    unreadable.sessionIndex === 4 && unreadable.subscribed === null,
    JSON.stringify(unreadable),
  );
  const pages = [];
  t.check('account 0 is kept', takeAccountPage(pages, varHtml) === true);
  t.check('account 1 is kept', takeAccountPage(pages, windowHtml) === true);
  t.check('account 2 with an empty list is kept', takeAccountPage(pages, emptyHtml) === true);
  t.check(
    'a page whose SESSION_INDEX is not the next account ends the list',
    takeAccountPage(pages, varHtml) === false && pages.length === 3,
    JSON.stringify(pages.map((row) => row.index)),
  );
  t.check(
    'the content script parses the same pages',
    JSON.stringify(page.api.parseSubscriptionsHtml(varHtml)) === JSON.stringify(fromVar)
      && JSON.stringify(page.api.parseSubscriptionsHtml(windowHtml)) === JSON.stringify(fromWindow)
      && JSON.stringify(page.api.parseSubscriptionsHtml(emptyHtml)) === JSON.stringify(fromEmpty)
      && JSON.stringify(page.api.parseSubscriptionsHtml(jsonHtml)) === JSON.stringify(fromJson)
      && JSON.stringify(page.api.parseSubscriptionsHtml('<script>ytcfg.set({"SESSION_INDEX":"4"});</script>'))
        === JSON.stringify(unreadable),
  );
  const fromScript = [];
  page.api.takeAccountPage(fromScript, varHtml);
  page.api.takeAccountPage(fromScript, windowHtml);
  page.api.takeAccountPage(fromScript, varHtml);
  t.check(
    'the content script stops when the index falls back',
    fromScript.length === 2 && fromScript[0].subscribed === 2 && fromScript[1].subscribed === 1,
    JSON.stringify(fromScript),
  );

  t.section('account names');

  const switcherText = read('test/fixtures/account-switcher.txt');
  const named = parseAccountSwitcher(switcherText);
  t.check(
    'each row takes its number from the sign-in link, not its place in the list',
    JSON.stringify(named.map((row) => [row.index, row.name])) === JSON.stringify([
      [1, 'Second Account'],
      [0, 'First Account'],
      [2, 'Third Account'],
      [3, 'Fourth Account'],
    ]),
    JSON.stringify(named),
  );
  t.check(
    'a picture off the YouTube avatar hosts is dropped, the name kept',
    named[0].avatar === 'https://yt3.ggpht.com/two=s48' && named[2].avatar === '',
    JSON.stringify(named.map((row) => row.avatar)),
  );
  t.check(
    'a reply that is not the switcher gives no names',
    parseAccountSwitcher('<html>sorry</html>').length === 0
      && parseAccountSwitcher(")]}'\n{}").length === 0
      && parseAccountSwitcher('').length === 0,
  );
  t.check(
    'the content script reads the switcher the same way',
    JSON.stringify(page.api.parseAccountSwitcher(switcherText)) === JSON.stringify(named)
      && page.api.parseAccountSwitcher('<html>').length === 0,
  );

  const namedPage = loadContent();
  const switcherCalls = [];
  namedPage.win.fetch = (url, init) => {
    switcherCalls.push({ url, init });
    return Promise.resolve({ ok: true, text: () => Promise.resolve(switcherText) });
  };
  await namedPage.api.showScanResult({ added: 2, skipped: 0, account: 2, avatar: '' });
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  const namedOverlay = namedPage.doc.getElementById('ytc-scan-overlay');
  t.check(
    'the result names the account, read once from the switcher in this tab',
    textOf(namedOverlay, 'ytc-scan-who-label') === 'Third Account'
      && switcherCalls.length === 1
      && switcherCalls[0].url === 'https://www.youtube.com/getAccountSwitcherEndpoint'
      && switcherCalls[0].init.credentials === 'include',
    `${textOf(namedOverlay, 'ytc-scan-who-label')} ${JSON.stringify(switcherCalls)}`,
  );
  await namedPage.api.showScanResult({ added: 1, skipped: 0, account: 1, avatar: '' });
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  t.check(
    'a second paint reuses the names and fills a missing picture',
    textOf(namedOverlay, 'ytc-scan-who-label') === 'Second Account'
      && namedOverlay.querySelector('.ytc-scan-avatar').getAttribute('src') === 'https://yt3.ggpht.com/two=s48'
      && switcherCalls.length === 1,
    textOf(namedOverlay, 'ytc-scan-who-label'),
  );
  t.check(
    'names never travel to the worker',
    !namedPage.sent.some((msg) => JSON.stringify(msg || {}).includes('Account')),
    JSON.stringify(namedPage.sent),
  );

  page.setLocale('en');
  await page.api.showScanResult({ added: 4, skipped: 0, account: 0, avatar: 'https://yt3.ggpht.com/acct=s176' });
  t.check(
    'the result names the account above the count',
    textOf(overlay, 'ytc-scan-who-label') === 'Account 1'
      && textOf(overlay, 'ytc-scan-title') === 'Added 4 channels'
      && overlay.querySelector('.ytc-scan-avatar').getAttribute('src') === 'https://yt3.ggpht.com/acct=s176'
      && !overlay.querySelector('.ytc-scan-another').hasAttribute('hidden'),
    `${textOf(overlay, 'ytc-scan-who-label')} | ${textOf(overlay, 'ytc-scan-title')}`,
  );

  t.section('the account wait');

  const workerSrc = read('src/background/service-worker.js');
  const contentLive = read('src/content/content.js');
  const pickMs = (src) => {
    const match = src.match(/const ACCOUNT_PICK_MS = ([^;]+);/);
    return match && match[1].trim();
  };
  t.check(
    'both sides give the picker the same 4 minutes',
    pickMs(workerSrc) === '4 * 60 * 1000' && pickMs(workerSrc) === pickMs(contentLive),
    JSON.stringify({ worker: pickMs(workerSrc), content: pickMs(contentLive) }),
  );

  const long = [];
  const realSetTimeout = page.win.setTimeout.bind(page.win);
  const realClearTimeout = page.win.clearTimeout.bind(page.win);
  page.win.setTimeout = (fn, ms) => {
    if (ms >= 60_000) {
      long.push({ fn, ms, cleared: false });
      return { long: long.length };
    }
    return realSetTimeout(fn, ms);
  };
  page.win.clearTimeout = (id) => {
    if (id && id.long) {
      const row = long[id.long - 1];
      if (row) row.cleared = true;
      return;
    }
    return realClearTimeout(id);
  };
  page.api.openAccountPicker({
    current: 0,
    accounts: [
      { index: 0, subscribed: 2, continuation: false, avatar: '' },
      { index: 1, subscribed: 5, continuation: true, avatar: '', name: 'Second Account' },
      { index: 2, subscribed: null, continuation: false, avatar: '' },
      { index: 3, subscribed: 0, continuation: false, avatar: '' },
    ],
  }, () => {});
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  const scans = [];
  const walkScans = (node) => {
    if (!node) return;
    if (node.className === 'ytc-scan-scan') scans.push(node);
    for (const child of node.children || []) walkScans(child);
  };
  walkScans(overlay);
  const details = [];
  const walkDetails = (node) => {
    if (!node) return;
    if (node.className === 'ytc-scan-row-detail') details.push(node.textContent);
    for (const child of node.children || []) walkDetails(child);
  };
  walkDetails(overlay);
  t.check(
    'each account with channels, or not counted, has Scan; an empty one does not',
    scans.length === 3 && long.length === 1,
    `${scans.length} ${long.length}`,
  );
  const rowNames = [];
  const walkNames = (node) => {
    if (!node) return;
    if (node.className === 'ytc-scan-row-name') rowNames.push(node.textContent);
    for (const child of node.children || []) walkNames(child);
  };
  walkNames(overlay);
  t.check(
    'a row shows the account name when the switcher gave one, else Account N',
    rowNames[1] === 'Second Account' && rowNames[2] === 'Account 3',
    JSON.stringify(rowNames),
  );
  t.check(
    'an uncounted account says so instead of No subscriptions',
    details[2] === 'Channels not counted' && details[3] === 'No subscriptions',
    JSON.stringify(details),
  );
  long[0].fn();
  t.check(
    'the cap replaces Scan with the restart line and leaves Done',
    scans.every((btn) => btn.hasAttribute('hidden'))
      && textOf(overlay, 'ytc-scan-expired') === 'Start the import again from the extension'
      && !overlay.querySelector('.ytc-scan-expired').hasAttribute('hidden')
      && !overlay.querySelector('.ytc-scan-done').hasAttribute('hidden'),
    textOf(overlay, 'ytc-scan-expired'),
  );
  const done = overlay.querySelector('.ytc-scan-done');
  const doneClick = done.listeners.find((entry) => entry.type === 'click');
  const sentBefore = page.sent.length;
  doneClick.fn({ preventDefault() {}, stopPropagation() {} });
  t.check(
    'Done still asks the worker to close the tab',
    page.sent.slice(sentBefore).some((msg) => msg && msg.type === 'subscriptions.close'),
  );

  const pickedByClick = [];
  page.api.openAccountPicker({
    current: 0,
    accounts: [
      { index: 0, subscribed: 2, continuation: false, avatar: '' },
      { index: 1, subscribed: 5, continuation: false, avatar: '' },
    ],
  }, (reply) => pickedByClick.push(reply));
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  const scanClick = (trusted) => {
    const btn = [];
    const walk = (node) => {
      if (!node) return;
      if (node.className === 'ytc-scan-scan') btn.push(node);
      for (const child of node.children || []) walk(child);
    };
    walk(overlay);
    // This test DOM has no firstChild, so clearNode leaves the earlier
    // picker's buttons behind, hidden.
    const shown = btn.filter((node) => !node.hasAttribute('hidden'));
    const entry = shown[shown.length - 1].listeners.find((item) => item.type === 'click');
    entry.fn({ isTrusted: trusted, preventDefault() {}, stopPropagation() {} });
  };
  scanClick(false);
  t.check('a click the page made on Scan picks no account', pickedByClick.length === 0, JSON.stringify(pickedByClick));
  scanClick(true);
  t.check(
    'a real click on Scan reads that account',
    pickedByClick.length === 1 && pickedByClick[0].index === 1,
    JSON.stringify(pickedByClick),
  );
  await page.api.showScanResult({ added: 1, skipped: 0, account: 0, avatar: '' });
  const heldPicks = [];
  page.api.chooseAccounts({
    current: 0,
    accounts: [
      { index: 0, subscribed: 2, continuation: false, avatar: '' },
      { index: 1, subscribed: 5, continuation: false, avatar: '' },
    ],
  }, (reply) => heldPicks.push(reply), true);
  const anotherClick = (trusted) => {
    const node = overlay.querySelector('.ytc-scan-another');
    const entry = node.listeners.find((item) => item.type === 'click');
    entry.fn({ isTrusted: trusted, preventDefault() {}, stopPropagation() {} });
  };
  anotherClick(false);
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  t.check(
    'a click the page made on Import another account leaves the result up',
    overlay.querySelector('.ytc-scan-picker').hasAttribute('hidden') && textOf(overlay, 'ytc-scan-title') === 'Added 1 channel',
    textOf(overlay, 'ytc-scan-title'),
  );
  anotherClick(true);
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  t.check(
    'a real click opens the account picker',
    !overlay.querySelector('.ytc-scan-picker').hasAttribute('hidden') && heldPicks.length === 0,
    textOf(overlay, 'ytc-scan-title'),
  );


  const picked = [];
  page.api.chooseAccounts({
    current: 1,
    accounts: [
      { index: 0, subscribed: 0, continuation: false, avatar: '' },
      { index: 1, subscribed: 12, continuation: false, avatar: '' },
    ],
  }, (reply) => picked.push(reply));
  t.check(
    'one account with channels is read without a click',
    picked.length === 1 && picked[0].index === 1,
    JSON.stringify(picked),
  );
  picked.length = 0;
  page.api.chooseAccounts({
    current: 1,
    accounts: [
      { index: 0, subscribed: null, continuation: false, avatar: '' },
      { index: 1, subscribed: 12, continuation: false, avatar: '' },
    ],
  }, (reply) => picked.push(reply));
  t.check('an uncounted account still asks which one', picked.length === 0, JSON.stringify(picked));
  const expiredBefore = !overlay.querySelector('.ytc-scan-expired').hasAttribute('hidden');
  await page.api.showScanResult({ error: 'timeout' });
  const liveScans = [];
  const walkLive = (node) => {
    if (!node) return;
    if (node.className === 'ytc-scan-scan' && !node.hasAttribute('hidden')) liveScans.push(node);
    for (const child of node.children || []) walkLive(child);
  };
  walkLive(overlay);
  t.check(
    'a worker that ran out of time takes the choices away and says to start again',
    !expiredBefore && liveScans.length === 0
      && !overlay.querySelector('.ytc-scan-expired').hasAttribute('hidden')
      && textOf(overlay, 'ytc-scan-expired') === 'Start the import again from the extension',
    `${expiredBefore} ${liveScans.length} ${textOf(overlay, 'ytc-scan-expired')}`,
  );

  t.section('the lists differ');

  function flush() {
    return new Promise((resolve) => { setTimeout(resolve, 0); });
  }
  function clickClass(root, cls, trusted) {
    const node = root.querySelector(`.${cls}`);
    const entry = node && node.listeners.find((item) => item.type === 'click');
    if (!entry) return null;
    entry.fn({
      isTrusted: trusted === true,
      preventDefault() {},
      stopPropagation() {},
    });
    return node;
  }
  async function askChoose(fields) {
    let reply = null;
    const returned = page.listeners[0]({
      type: 'subscriptions.choose',
      fresh: 2,
      extra: 3,
      account: 1,
      avatar: 'https://yt3.ggpht.com/acct=s176',
      ...fields,
    }, {}, (res) => { reply = res; });
    await flush();
    await flush();
    return { returned, reply: () => reply };
  }

  page.setLocale('en');
  const choice = await askChoose();
  t.check('choose answers asynchronously', choice.returned === true);
  t.check(
    'the differ overlay names the account and the two counts',
    textOf(overlay, 'ytc-scan-who-label') === 'Account 2'
      && overlay.querySelector('.ytc-scan-avatar').getAttribute('src') === 'https://yt3.ggpht.com/acct=s176'
      && textOf(overlay, 'ytc-scan-title') === 'Your watchlist and this account differ'
      && textOf(overlay, 'ytc-scan-sub') === '2 new on YouTube · 3 on your watchlist only'
      && textOf(overlay, 'ytc-scan-merge') === 'Add new'
      && textOf(overlay, 'ytc-scan-replace') === 'Replace watchlist'
      && overlay.querySelector('.ytc-scan-warn').hasAttribute('hidden')
      && overlay.querySelector('.ytc-scan-another').hasAttribute('hidden')
      && !overlay.querySelector('.ytc-scan-done').hasAttribute('hidden'),
    `${textOf(overlay, 'ytc-scan-title')} | ${textOf(overlay, 'ytc-scan-sub')}`,
  );
  clickClass(overlay, 'ytc-scan-merge', false);
  clickClass(overlay, 'ytc-scan-replace', false);
  t.check(
    'an untrusted click does not add or open the warning',
    choice.reply() == null && overlay.querySelector('.ytc-scan-warn').hasAttribute('hidden'),
  );
  clickClass(overlay, 'ytc-scan-replace', true);
  t.check(
    'Replace turns the row into the warning',
    !overlay.querySelector('.ytc-scan-warn').hasAttribute('hidden')
      && overlay.querySelector('.ytc-scan-decide').hasAttribute('hidden')
      && textOf(overlay, 'ytc-scan-warn-text') === 'Your current watchlist will be replaced. 3 channels will be deleted from it, with their videos. There is no undo.'
      && choice.reply() == null,
    textOf(overlay, 'ytc-scan-warn-text'),
  );
  clickClass(overlay, 'ytc-scan-export', false);
  clickClass(overlay, 'ytc-scan-delete', false);
  t.check('an untrusted export or delete does not answer', choice.reply() == null);
  clickClass(overlay, 'ytc-scan-cancel', true);
  t.check(
    'Cancel returns to the two choices',
    !overlay.querySelector('.ytc-scan-decide').hasAttribute('hidden')
      && overlay.querySelector('.ytc-scan-warn').hasAttribute('hidden')
      && choice.reply() == null,
  );
  clickClass(overlay, 'ytc-scan-replace', true);
  clickClass(overlay, 'ytc-scan-export', true);
  t.check(
    'Export asks the worker for the backup',
    choice.reply() && choice.reply().ok === true && choice.reply().mode === 'export',
    JSON.stringify(choice.reply()),
  );

  const blobUrls = [];
  page.win.URL.createObjectURL = (blob) => {
    const url = `blob:test/${blobUrls.length}`;
    blobUrls.push({ url, blob, revoked: false });
    return url;
  };
  page.win.URL.revokeObjectURL = (url) => {
    const row = blobUrls.find((item) => item.url === url);
    if (row) row.revoked = true;
  };
  const anchors = [];
  const prevCreate = page.doc.createElement;
  page.doc.createElement = (tag) => {
    const node = prevCreate(tag);
    if (tag === 'a') anchors.push(node);
    return node;
  };
  const scheduled = [];
  const prevTimeout = page.win.setTimeout;
  page.win.setTimeout = (fn, ms) => {
    if (ms === 1000) {
      scheduled.push(fn);
      return { revoke: scheduled.length };
    }
    return prevTimeout(fn, ms);
  };
  let downloaded = null;
  page.listeners[0]({
    type: 'subscriptions.download',
    name: 'youtube-companion-2026-09-25.json',
    text: '{"app":"youtube-companion"}',
  }, {}, (res) => { downloaded = res; });
  const anchor = anchors[anchors.length - 1];
  t.check(
    'the backup is downloaded and not left on the page',
    downloaded && downloaded.ok === true
      && anchor && anchor.download === 'youtube-companion-2026-09-25.json'
      && anchor.clicked === true
      && anchor.parent == null
      && blobUrls.length === 1
      && scheduled.length === 1,
    JSON.stringify({ downloaded, download: anchor && anchor.download, clicked: anchor && anchor.clicked }),
  );
  scheduled[0]();
  t.check('the blob url is revoked after the click', blobUrls[0].revoked === true);
  page.win.setTimeout = prevTimeout;

  const saved = await askChoose({ exported: true });
  t.check(
    'after the export the warning comes back with the file name',
    !overlay.querySelector('.ytc-scan-warn').hasAttribute('hidden')
      && textOf(overlay, 'ytc-scan-saved') === 'Saved youtube-companion-2026-09-25.json'
      && overlay.querySelector('.ytc-scan-export-failed').hasAttribute('hidden'),
    textOf(overlay, 'ytc-scan-saved'),
  );
  clickClass(overlay, 'ytc-scan-delete', false);
  t.check('an untrusted delete still does not answer', saved.reply() == null);
  clickClass(overlay, 'ytc-scan-delete', true);
  t.check(
    'Delete and replace answers replace',
    saved.reply() && saved.reply().ok === true && saved.reply().mode === 'replace',
    JSON.stringify(saved.reply()),
  );

  page.setLocale('ar');
  await askChoose();
  t.check(
    'Arabic is right to left and uses the label form',
    overlay.getAttribute('dir') === 'rtl'
      && textOf(overlay, 'ytc-scan-title') === 'قائمتك وهذا الحساب مختلفان'
      && textOf(overlay, 'ytc-scan-sub') === 'جديد على يوتيوب: 2 · في قائمتك فقط: 3',
    `${overlay.getAttribute('dir')} | ${textOf(overlay, 'ytc-scan-title')} | ${textOf(overlay, 'ytc-scan-sub')}`,
  );

  page.setLocale('en');
  await page.api.showScanResult({
    added: 2,
    removed: 3,
    skipped: 9,
    account: 1,
    avatar: 'https://yt3.ggpht.com/acct=s176',
  });
  t.check(
    'a replace that added and removed names both',
    textOf(overlay, 'ytc-scan-title') === 'Added 2 channels'
      && textOf(overlay, 'ytc-scan-sub') === 'Removed 3 channels'
      && !overlay.querySelector('.ytc-scan-another').hasAttribute('hidden'),
    `${textOf(overlay, 'ytc-scan-title')} | ${textOf(overlay, 'ytc-scan-sub')}`,
  );
  t.check('with no names given, no names line shows', overlay.querySelector('.ytc-scan-names').hasAttribute('hidden'));
  await page.api.showScanResult({
    added: 2,
    removed: 5,
    removedNames: ['Linus Tech Tips', 'MrBeast', 'Veritasium'],
    account: 1,
  });
  t.check(
    'a replace names the first channels it removed, and says there were others',
    textOf(overlay, 'ytc-scan-sub') === 'Removed 5 channels'
      && textOf(overlay, 'ytc-scan-names') === 'Removed: Linus Tech Tips, MrBeast, Veritasium and others'
      && !overlay.querySelector('.ytc-scan-names').hasAttribute('hidden'),
    textOf(overlay, 'ytc-scan-names'),
  );
  await page.api.showScanResult({ added: 0, removed: 1, removedNames: ['MrBeast', 42], account: 0 });
  t.check(
    'only removals use Removed as the headline',
    textOf(overlay, 'ytc-scan-title') === 'Removed 1 channel'
      && overlay.querySelector('.ytc-scan-sub').hasAttribute('hidden'),
    textOf(overlay, 'ytc-scan-title'),
  );
  t.check(
    'every removed channel named needs no "and others"',
    textOf(overlay, 'ytc-scan-names') === 'Removed: MrBeast',
    textOf(overlay, 'ytc-scan-names'),
  );
  page.setLocale('ar');
  await page.api.showScanResult({ added: 0, removed: 4, removedNames: ['أ', 'ب'], account: 0 });
  t.check(
    'Arabic joins the names with the Arabic comma',
    textOf(overlay, 'ytc-scan-names') === 'حُذفت: أ\u060c ب وغيرها',
    textOf(overlay, 'ytc-scan-names'),
  );
  page.setLocale('en');
  await page.api.showScanResult({ added: 0, removed: 0, skipped: 4, removedNames: ['Stale'] });
  t.check('a result that removed nothing hides the names line', overlay.querySelector('.ytc-scan-names').hasAttribute('hidden'));
  await page.api.showScanResult({ added: 0, removed: 0, skipped: 4 });
  t.check(
    'nothing removed still says the list already has them',
    textOf(overlay, 'ytc-scan-title') === 'Every channel is already on your list',
  );

  const failedExport = await askChoose({ exportError: true });
  t.check(
    'a failed export shows the failure line and does not download',
    failedExport.returned === true
      && !overlay.querySelector('.ytc-scan-warn').hasAttribute('hidden')
      && textOf(overlay, 'ytc-scan-export-failed') === 'Could not save the backup'
      && overlay.querySelector('.ytc-scan-saved').hasAttribute('hidden'),
    textOf(overlay, 'ytc-scan-export-failed'),
  );
  const sentBeforeDone = page.sent.length;
  clickClass(overlay, 'ytc-scan-done', true);
  t.check(
    'Done answers done and closes the tab',
    failedExport.reply() && failedExport.reply().ok === false && failedExport.reply().error === 'done'
      && page.sent.slice(sentBeforeDone).some((msg) => msg && msg.type === 'subscriptions.close'),
    JSON.stringify(failedExport.reply()),
  );
}
