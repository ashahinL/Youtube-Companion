/**
 * Runs the real popup (popup.html + popup.js) against a fake DOM and a
 * scripted worker, then drives it the way a person would: clicks, keys,
 * storage writes. Each check reads what the popup drew or sent, never its
 * source. Runs in its own process: importing popup.js starts timers and
 * holds module state that would leak into the rest of the suite.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { installChromeMock } from './helpers/chrome-mock.js';
import { parseHtml, keyEvent, FakeEvent } from './helpers/fake-dom.js';
import { DEFAULT_SETTINGS } from '../src/lib/settings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];
const errors = [];

function check(label, ok, detail = '') {
  checks.push({ label, ok: !!ok, detail: detail ? String(detail) : '' });
}

process.on('unhandledRejection', (err) => {
  errors.push(err && err.stack ? err.stack : String(err));
});

const NOW = Date.now();
const HOUR = 3_600_000;

function channel(id, title, extra = {}) {
  return { id, title, handle: '@' + title.toLowerCase(), addedAt: NOW - 30 * 24 * HOUR, lastVideoAt: NOW - HOUR, ...extra };
}

function video(v, c, ageHours, extra = {}) {
  return { v, c, t: `Video ${v}`, at: NOW - ageHours * HOUR, ...extra };
}

const state = {
  settings: structuredClone(DEFAULT_SETTINGS),
  channels: [
    channel('UCaaaaaaaaaaaaaaaaaaaaaa', 'Alpha', { favorite: true, groups: ['Music'] }),
    channel('UCbbbbbbbbbbbbbbbbbbbbbb', 'Bravo'),
    channel('UCcccccccccccccccccccccc', 'Charlie', { lastError: { message: 'Feed failed (500)', at: NOW } }),
  ],
  feed: [
    video('aaaaaaaaaa1', 'UCaaaaaaaaaaaaaaaaaaaaaa', 1),
    video('bbbbbbbbbb1', 'UCbbbbbbbbbbbbbbbbbbbbbb', 5),
    video('aaaaaaaaaa2', 'UCaaaaaaaaaaaaaaaaaaaaaa', 30),
    video('bbbbbbbbbb2', 'UCbbbbbbbbbbbbbbbbbbbbbb', 50, { k: 'live' }),
    video('bbbbbbbbbb3', 'UCbbbbbbbbbbbbbbbbbbbbbb', 60, { k: 'premiere', st: NOW + 2 * HOUR }),
  ],
  queue: [],
  pollState: { lastSeenAt: NOW },
  previousLastSeenAt: NOW - 3 * HOUR,
};
state.settings.ui = { ...state.settings.ui, locale: 'en', theme: 'system' };

// What the stylesheet would compute; the language setting is separate.
const layout = { direction: 'ltr' };

const sent = [];
// Tests swap in a reply for one message type; everything else gets the stored state.
const replies = {};

function snapshot() {
  return {
    ok: true,
    settings: structuredClone(state.settings),
    channels: structuredClone(state.channels),
    feed: structuredClone(state.feed),
    queue: structuredClone(state.queue),
    queueOpen: false,
    whatsNewSeen: '9.9',
    pollState: structuredClone(state.pollState),
  };
}

async function workerReply(msg) {
  sent.push(structuredClone(msg));
  if (replies[msg.type]) return replies[msg.type](msg);
  switch (msg.type) {
    case 'popupOpened':
      return { ...snapshot(), previousLastSeenAt: state.previousLastSeenAt };
    case 'getState':
      return snapshot();
    case 'audioMode.shortcut':
      return { ok: true, shortcut: '' };
    default:
      return { ok: true, state: snapshot() };
  }
}

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// Lets the popup's awaits settle after an action.
async function settle(ms = 30) {
  await delay(ms);
}

async function waitFor(fn, ms = 2000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await delay(15);
  }
  return false;
}

function sentOf(type) {
  return sent.filter((m) => m.type === type);
}

async function main() {
  const html = fs.readFileSync(path.join(ROOT, 'src/popup/popup.html'), 'utf8');
  const document = parseHtml(html);
  const win = document.defaultView;
  let closes = 0;
  Object.assign(win, {
    close() { closes += 1; },
    getSelection() { return { removeAllRanges() {}, addRange() {} }; },
    innerHeight: 600,
    setTimeout: (...a) => setTimeout(...a),
    clearTimeout: (id) => clearTimeout(id),
  });
  const observers = [];
  globalThis.document = document;
  globalThis.window = win;
  globalThis.HTMLElement = document.body.constructor;
  globalThis.IntersectionObserver = class {
    constructor(fn) { this.fn = fn; this.targets = []; observers.push(this); }
    observe(el) { this.targets.push(el); }
    unobserve() {}
    disconnect() { this.targets = []; }
  };
  globalThis.getComputedStyle = () => ({ direction: layout.direction, fontSize: '14px' });
  globalThis.CSS = { escape: (v) => String(v) };
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  const copied = [];
  const blobs = [];
  URL.createObjectURL = (blob) => { blobs.push(blob); return `blob:test/${blobs.length}`; };
  URL.revokeObjectURL = () => {};
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      language: 'en-US',
      userAgent: 'node-test',
      clipboard: { async writeText(text) { copied.push(text); } },
    },
  });

  vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'src/content/core.js'), 'utf8'), {
    filename: 'src/content/core.js',
  });

  const mock = installChromeMock();
  globalThis.chrome.runtime.sendMessage = workerReply;
  globalThis.fetch = async (url) => {
    const rel = String(url).replace(/^chrome-extension:\/\/youtube-companion\//, '');
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    return { ok: true, async json() { return JSON.parse(text); } };
  };

  const $ = (id) => document.getElementById(id);

  await import('../src/popup/popup.js');

  const opened = await waitFor(() => $('feeds') && !$('feeds').hidden && $('feed-list')?.children.length > 0);
  check('the popup opens on Feeds with rows drawn', opened, errors.join('\n') || `feeds hidden=${$('feeds')?.hidden}`);
  if (!opened) return;

  await scenarios({ document, $, mock, win, observers, copied, blobs, closes: () => closes });
}

const A = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const B = 'UCbbbbbbbbbbbbbbbbbbbbbb';
const C = 'UCcccccccccccccccccccccc';

function press(target, key, init = {}) {
  target.dispatchEvent(keyEvent(key, init));
}

function rowKeys(list) {
  return list.children.map((row) => row.dataset.rowKey);
}

async function scenarios(ctx) {
  const { $, document, mock } = ctx;
  const active = () => document.activeElement;

  // Feeds
  const feedList = $('feed-list');
  check('Feeds draws one row per stored video, newest first', rowKeys(feedList).join() === 'aaaaaaaaaa1,bbbbbbbbbb1,aaaaaaaaaa2,bbbbbbbbbb2,bbbbbbbbbb3', rowKeys(feedList).join());
  const newTags = feedList.querySelectorAll('.feed-tag--new').map((el) => el.closest('[data-row-key]').dataset.rowKey);
  check(
    'New marks only videos after the previous open, as a word',
    newTags.join() === 'aaaaaaaaaa1' && feedList.querySelector('.feed-tag--new').textContent === 'New',
    newTags.join(),
  );
  check(
    'the New marker sits with the row buttons, not in the title',
    feedList.querySelector('.feed-tag--new').parentElement.className === 'feed-row__actions',
  );
  const liveRow = feedList.children.find((row) => row.dataset.rowKey === 'bbbbbbbbbb2');
  const premiereRow = feedList.children.find((row) => row.dataset.rowKey === 'bbbbbbbbbb3');
  check(
    'live and premiere rows have no queue button; a normal row does',
    !liveRow.querySelector('.feed-row__queue')
      && !premiereRow.querySelector('.feed-row__queue')
      && !!feedList.children[0].querySelector('.feed-row__queue'),
  );
  check(
    'thumbnails load lazily',
    feedList.querySelectorAll('img').every((img) => img.loading === 'lazy'),
  );

  const chips = $('feed-groups');
  check(
    'a group puts a chip row with All pressed',
    !chips.hidden
      && chips.children.map((b) => b.dataset.group).join('|') === '|Music'
      && chips.children[0].getAttribute('aria-pressed') === 'true'
      && chips.children.every((b) => b.tagName === 'BUTTON' && b.type === 'button'),
    chips.children.map((b) => `${b.dataset.group}:${b.getAttribute('aria-pressed')}`).join(),
  );
  sent.length = 0;
  replies.updateSettings = (msg) => {
    state.settings.feed = { ...state.settings.feed, ...msg.patch.feed };
    return snapshot();
  };
  chips.children[1].click();
  await settle();
  check(
    'a chip writes feed.group and the feed narrows to it',
    sentOf('updateSettings')[0]?.patch?.feed?.group === 'Music'
      && rowKeys(feedList).join() === 'aaaaaaaaaa1,aaaaaaaaaa2'
      && chips.children[1].getAttribute('aria-pressed') === 'true',
    JSON.stringify(sentOf('updateSettings')) + ' ' + rowKeys(feedList).join(),
  );
  chips.children[0].click();
  await settle();

  sent.length = 0;
  const favBox = $('feed-favorites-only');
  favBox.click();
  await settle();
  check(
    'Favourites only writes feed.favoritesOnly and narrows the feed',
    sentOf('updateSettings')[0]?.patch?.feed?.favoritesOnly === true
      && rowKeys(feedList).join() === 'aaaaaaaaaa1,aaaaaaaaaa2',
    JSON.stringify(sentOf('updateSettings')),
  );

  // The channel sheet lists the channel's videos whatever Feeds filters by.
  feedList.querySelector('.feed-row__channel').click();
  await settle();
  const sheet = $('channel-sheet');
  check(
    'a channel name in Feeds opens that channel\'s sheet',
    !sheet.hidden && $('channel-sheet-name').textContent === 'Alpha' && active() === $('channel-sheet-close'),
    $('channel-sheet-name').textContent,
  );
  press(active(), 'Escape');
  await settle();
  favBox.click();
  await settle();
  const bravoName = feedList.querySelectorAll('.feed-row__channel').find((el) => el.dataset.channelId === B);
  bravoName.click();
  await settle();
  check(
    'the sheet lists only that channel\'s videos',
    rowKeys($('channel-sheet-videos')).join() === 'bbbbbbbbbb1,bbbbbbbbbb2,bbbbbbbbbb3',
    rowKeys($('channel-sheet-videos')).join(),
  );

  sent.length = 0;
  let releaseSweep;
  replies.sweep = () => new Promise((resolve) => { releaseSweep = () => resolve({ ok: true }); });
  $('channel-sheet-refresh').click();
  await settle();
  check(
    'sheet refresh checks only that channel',
    sentOf('sweep').length === 1 && sentOf('sweep')[0].onlyId === B,
    JSON.stringify(sentOf('sweep')),
  );
  check(
    'while it runs the sheet shows the spinner instead of refresh',
    $('channel-sheet-refresh').hidden && !$('channel-sheet-spinner').hidden,
  );
  releaseSweep();
  delete replies.sweep;
  await settle();

  // Tab stays inside the open sheet.
  const inSheet = sheet.querySelector('.sheet__panel');
  const focusables = inSheet.querySelectorAll('button').filter((el) => !el.disabled && !el.closest('[hidden]'));
  focusables[focusables.length - 1].focus();
  const tabFwd = keyEvent('Tab');
  active().dispatchEvent(tabFwd);
  check('Tab past the last control wraps to the first in the sheet', tabFwd.defaultPrevented && active() === focusables[0], active().className);
  const tabBack = keyEvent('Tab', { shiftKey: true });
  active().dispatchEvent(tabBack);
  check('Shift+Tab from the first wraps to the last', tabBack.defaultPrevented && active() === focusables[focusables.length - 1]);

  press(active(), 'Escape');
  await settle();
  check(
    'Escape closes the sheet and focus returns to the channel name',
    sheet.hidden && active().className === 'feed-row__channel' && active().dataset.channelId === B,
    active().className,
  );

  // A storage write from a check redraws Feeds, and keyboard focus stays put.
  const bravoRowBtn = feedList.children.find((r) => r.dataset.rowKey === 'bbbbbbbbbb1').querySelector('.feed-row__open-alt');
  bravoRowBtn.focus();
  const added = video('cccccccccc1', C, 0.5);
  state.feed = [added, ...state.feed];
  await chrome.storage.local.set({ feed: structuredClone(state.feed) });
  await settle();
  check('a storage write of the feed redraws the open tab', rowKeys(feedList)[0] === 'cccccccccc1', rowKeys(feedList).join());
  check(
    'focus stays on the same button of the same row across the redraw',
    active() !== bravoRowBtn
      && active().className.includes('feed-row__open-alt')
      && active().closest('[data-row-key]')?.dataset.rowKey === 'bbbbbbbbbb1',
    active().className,
  );

  sent.length = 0;
  replies.sweep = () => ({ ok: true });
  await chrome.storage.local.set({ pollState: { ...state.pollState, running: true } });
  await settle();
  check(
    'a check the worker is running shows as sweeping: refresh hides, spinner shows',
    $('feed-refresh').hidden && !$('feed-refresh-spinner').hidden,
  );
  await chrome.storage.local.set({ pollState: { ...state.pollState, running: false } });
  await settle();
  check('refresh comes back when the check ends', !$('feed-refresh').hidden && $('feed-refresh-spinner').hidden);
  $('feed-refresh').click();
  await settle();
  check('Feeds refresh checks every channel', sentOf('sweep').length === 1 && !sentOf('sweep')[0].onlyId, JSON.stringify(sentOf('sweep')));
  delete replies.sweep;

  // Adding from Feeds
  const filter = $('feed-filter');
  sent.length = 0;
  filter.value = 'lofi music';
  filter.dispatchEvent(new FakeEvent('input', { bubbles: true }));
  $('feed-add-form').requestSubmit();
  await settle();
  check('typing words and submitting only filters: nothing is added', sentOf('addChannel').length === 0);

  filter.value = '';
  filter.dispatchEvent(new FakeEvent('input', { bubbles: true }));
  mock.activeTab = { id: 3, url: 'https://www.youtube.com/@delta' };
  replies.addChannel = () => ({ ok: true, channel: { id: 'UCdddddddddddddddddddddd', title: 'Delta' }, state: snapshot() });
  $('feed-add-form').requestSubmit();
  await settle();
  check(
    'an empty Add adds the focused tab\'s channel and names it',
    sentOf('addChannel')[0]?.input === 'https://www.youtube.com/@delta'
      && !$('feed-ok').hidden && $('feed-ok').textContent.includes('Delta'),
    JSON.stringify(sentOf('addChannel')) + ' ' + $('feed-ok').textContent,
  );

  sent.length = 0;
  mock.activeTab = { id: 3, url: 'https://example.com/' };
  $('feed-add-form').requestSubmit();
  await settle();
  check(
    'an empty Add on a non-YouTube tab says so and sends nothing',
    sentOf('addChannel').length === 0 && !$('feed-error').hidden && $('feed-error').textContent.length > 0,
  );
  sent.length = 0;
  mock.activeTab = { id: 3, url: 'https://www.youtube.com/@echo' };
  replies.addChannel = () => ({ ok: false, error: 'TypeError: something broke' });
  $('feed-add-form').requestSubmit();
  await settle();
  check(
    'a failure the popup has no sentence for reads as a plain one, not raw text',
    $('feed-error').textContent === 'Something went wrong. Try again.',
    $('feed-error').textContent,
  );
  delete replies.addChannel;

  // Watchlist
  $('tab-watchlist').click();
  await settle();
  const wl = $('watchlist-list');
  const rowOf = (id) => wl.children.find((r) => r.dataset.rowKey === id);
  check('the Watchlist draws one row per channel', wl.children.length === 3, rowKeys(wl).join());
  const favMark = rowOf(A).querySelector('.channel-row__fav');
  check(
    'a favourite row carries a named mark',
    !!favMark && favMark.getAttribute('role') === 'img' && favMark.getAttribute('aria-label') === 'Favourite',
    favMark?.getAttribute('aria-label'),
  );
  check('a failed channel reads Check failed', rowOf(C).querySelector('.channel-row__warn')?.textContent === 'Check failed', rowOf(C).querySelector('.channel-row__warn')?.textContent);

  const failingChip = $('watchlist-failing');
  check(
    'a failing channel puts an unpressed "1 failing" chip on the Watchlist',
    !$('watchlist-filters').hidden && failingChip.textContent === '1 failing' && failingChip.getAttribute('aria-pressed') === 'false',
    failingChip.textContent,
  );
  failingChip.click();
  await settle();
  check(
    'pressing it shows only the failing channel',
    rowKeys(wl).join() === C && failingChip.getAttribute('aria-pressed') === 'true' && $('watchlist-count').textContent === 'Showing 1 of 3',
    rowKeys(wl).join() + ' ' + $('watchlist-count').textContent,
  );
  failingChip.click();
  await settle();
  check('pressing it again shows the whole list', wl.children.length === 3 && $('watchlist-count').hidden);

  const toggle = rowOf(B).querySelector('.menu__toggle');
  const list = rowOf(B).querySelector('.menu__list');
  toggle.click();
  const items = list.querySelectorAll('[role="menuitem"]');
  check(
    '⋯ opens a menu and focuses its first item',
    !list.hidden && list.getAttribute('role') === 'menu' && toggle.getAttribute('aria-expanded') === 'true' && active() === items[0],
  );
  check(
    'the menu offers favourite, mute, Groups… and a danger Remove, in that order',
    items.length === 4
      && items[2].textContent === 'Groups…'
      && !items[2].className.includes('danger')
      && items[3].className.includes('menu__item--danger'),
    items.map((i) => i.textContent).join('|'),
  );
  press(active(), 'ArrowDown');
  const afterDown = active();
  press(active(), 'End');
  const afterEnd = active();
  press(active(), 'ArrowDown');
  const afterWrap = active();
  press(active(), 'ArrowUp');
  const afterUp = active();
  press(active(), 'Home');
  check(
    'arrows, Home and End move through the menu and wrap',
    afterDown === items[1] && afterEnd === items[3] && afterWrap === items[0] && afterUp === items[3] && active() === items[0],
  );
  press(active(), 'Escape');
  check('Escape closes the menu and focus returns to ⋯', list.hidden && active() === toggle && toggle.getAttribute('aria-expanded') === 'false');

  press(toggle, 'ArrowDown');
  check('ArrowDown on ⋯ opens the menu at its first item', !list.hidden && active() === items[0]);
  press(active(), 'Tab');
  check('Tab closes the menu', list.hidden);
  toggle.click();
  document.body.click();
  check('a click outside closes the menu', list.hidden);

  // Mute from the menu
  sent.length = 0;
  replies.setMuted = (msg) => {
    state.channels = state.channels.map((ch) => (ch.id === msg.id ? { ...ch, muted: msg.on } : ch));
    return { ok: true };
  };
  toggle.click();
  items[1].click();
  await settle();
  check(
    'Mute sends setMuted and the row then says Muted',
    sentOf('setMuted')[0]?.id === B && sentOf('setMuted')[0]?.on === true
      && rowOf(B).querySelector('.channel-row__meta').textContent.includes('Alerts muted'),
    rowOf(B).querySelector('.channel-row__meta').textContent,
  );
  delete replies.setMuted;

  // Groups… opens the groups sheet; a tick sends setChannelGroup.
  sent.length = 0;
  rowOf(B).querySelector('.menu__toggle').click();
  rowOf(B).querySelectorAll('[role="menuitem"]')[2].click();
  await settle();
  const gsheet = $('groups-sheet');
  const boxes = $('groups-sheet-list').querySelectorAll('input');
  check('Groups… opens the groups sheet for that channel', !gsheet.hidden && $('groups-sheet-channel').textContent === 'Bravo' && boxes.length === 1 && boxes[0].checked === false);
  replies.setChannelGroup = (msg) => {
    state.channels = state.channels.map((ch) => (ch.id === msg.id ? { ...ch, groups: msg.on ? ['Music'] : [] } : ch));
    return { ok: true };
  };
  boxes[0].click();
  await settle();
  check(
    'ticking a group sends setChannelGroup',
    sentOf('setChannelGroup').length === 1
      && sentOf('setChannelGroup')[0].id === B
      && sentOf('setChannelGroup')[0].name === 'Music'
      && sentOf('setChannelGroup')[0].on === true
      && $('groups-sheet-list').querySelector('input').checked === true,
    JSON.stringify(sentOf('setChannelGroup')),
  );
  delete replies.setChannelGroup;
  const [renameBtn, deleteBtn] = $('groups-sheet-list').querySelectorAll('.groups-row__btn');
  check(
    'each group row has Rename and Delete named for the group',
    renameBtn?.getAttribute('aria-label') === 'Rename Music' && deleteBtn?.getAttribute('aria-label') === 'Delete Music',
    `${renameBtn?.getAttribute('aria-label')} | ${deleteBtn?.getAttribute('aria-label')}`,
  );
  renameBtn.click();
  await settle();
  const renameRow = $('groups-sheet-list').querySelector('.groups-row--edit');
  const renameInput = renameRow?.querySelector('input');
  check(
    'Rename turns the row into an inline field with Save and Cancel',
    !!renameInput && renameRow.querySelectorAll('button').map((b) => b.textContent).join('|') === 'Save|Cancel',
    renameRow?.querySelectorAll('button').map((b) => b.textContent).join('|'),
  );
  press(renameInput, 'Escape');
  await settle();
  check('Escape cancels the rename and keeps the sheet open', !gsheet.hidden && !$('groups-sheet-list').querySelector('.groups-row--edit'));
  press(active(), 'Escape');
  await settle();
  check('a second Escape closes the groups sheet, back on ⋯', gsheet.hidden && active() === $(`channel-menu-btn-${B}`), active().id);

  // Remove, then Undo
  sent.length = 0;
  replies.removeChannel = (msg) => {
    state.channels = state.channels.filter((ch) => ch.id !== msg.id);
    return { ok: true };
  };
  rowOf(B).querySelector('.menu__toggle').click();
  rowOf(B).querySelectorAll('[role="menuitem"]')[3].click();
  await settle();
  check(
    'Remove sends removeChannel at once and focus lands on Undo',
    sentOf('removeChannel')[0]?.id === B && !rowOf(B) && !$('watchlist-undo').hidden && active() === $('watchlist-undo-btn'),
    active().id,
  );
  delete replies.removeChannel;

  // Retry from a failed channel's sheet
  sent.length = 0;
  replies.sweep = () => ({ ok: true });
  rowOf(C).querySelector('.channel-row__main').click();
  await settle();
  check('a failed channel\'s sheet says why', !$('channel-sheet-problem').hidden && $('channel-sheet-problem-text').textContent.length > 0);
  $('channel-sheet-retry').click();
  await settle();
  check('Retry checks only that channel', sentOf('sweep').length === 1 && sentOf('sweep')[0].onlyId === C, JSON.stringify(sentOf('sweep')));
  delete replies.sweep;
  $('channel-sheet-close').click();
  await settle();
  check('closing the sheet returns focus to the row that opened it', active() === rowOf(C).querySelector('.channel-row__main'));

  // Open on YouTube
  rowOf(A).querySelector('.channel-row__main').click();
  await settle();
  const ytBtn = $('channel-sheet-youtube');
  check(
    'the sheet\'s YouTube button is named for the channel',
    !ytBtn.hidden && ytBtn.getAttribute('aria-label') === 'Open Alpha on YouTube' && ytBtn.title === 'Open Alpha on YouTube',
    ytBtn.getAttribute('aria-label'),
  );
  mock.tabsCreated.length = 0;
  const closesBefore = ctx.closes();
  ytBtn.click();
  await settle();
  check(
    'it opens the channel page in a new focused tab and closes the popup',
    mock.tabsCreated.length === 1
      && mock.tabsCreated[0].url === `https://www.youtube.com/channel/${A}`
      && mock.tabsCreated[0].active === true
      && ctx.closes() === closesBefore + 1,
    JSON.stringify(mock.tabsCreated),
  );
  press(active(), 'Escape');
  await settle();

  // Clear watchlist offers Export first
  $('tab-settings').click();
  await settle();
  $('settings-clear').click();
  await settle();
  const clearRow = $('settings-clear-confirm');
  check('Clear asks inline and names the count', !clearRow.hidden && $('settings-clear-prompt').textContent.includes('2'), $('settings-clear-prompt').textContent);
  sent.length = 0;
  ctx.blobs.length = 0;
  $('settings-clear-export').click();
  await settle();
  const exported = ctx.blobs[0] ? JSON.parse(await ctx.blobs[0].text()) : null;
  check(
    'Export my list first downloads the list and leaves the confirm open',
    exported?.channels?.length === 2
      && !clearRow.hidden
      && sentOf('clearChannels').length === 0
      && $('settings-backup-status').textContent === 'Exported 2 channels.',
    $('settings-backup-status').textContent,
  );
  $('settings-clear-cancel').click();
  await settle();

  // A long Watchlist is drawn a page at a time.
  $('tab-watchlist').click();
  await settle();
  const many = Array.from({ length: 120 }, (_, i) => channel(`UC${String(i).padStart(22, '0')}`, `Bulk${i}`));
  const savedChannels = state.channels;
  state.channels = [...savedChannels, ...many];
  await chrome.storage.local.set({ channels: structuredClone(state.channels) });
  await settle();
  const moreBtn = $('watchlist-more');
  check('a long Watchlist draws 50 rows and offers more', wl.children.length === 50 && !moreBtn.hidden, `${wl.children.length} ${moreBtn.hidden}`);
  moreBtn.click();
  await settle();
  check('Show more adds the next 50', wl.children.length === 100, String(wl.children.length));
  const moreObserver = ctx.observers.find((o) => o.targets.includes(moreBtn));
  moreObserver.fn([{ isIntersecting: true, target: moreBtn }]);
  await settle();
  check('scrolling to the end draws the rest', wl.children.length === 122 && moreBtn.hidden, String(wl.children.length));
  const wlInput = $('watchlist-input');
  wlInput.value = 'bulk';
  wlInput.dispatchEvent(new FakeEvent('input', { bubbles: true }));
  await settle();
  check('a new search starts again at one page', wl.children.length === 50, String(wl.children.length));
  wlInput.value = '';
  wlInput.dispatchEvent(new FakeEvent('input', { bubbles: true }));
  state.channels = savedChannels;
  await chrome.storage.local.set({ channels: structuredClone(state.channels) });
  await settle();

  // Tabs move with the arrow keys.
  $('tab-watchlist').click();
  await settle();
  const tabWatch = $('tab-watchlist');
  tabWatch.focus();
  press(tabWatch, 'ArrowRight');
  await settle();
  check('ArrowRight on a tab opens the next one', !$('settings').hidden && active() === $('tab-settings'));
  press(active(), 'ArrowRight');
  await settle();
  check('the arrows wrap from the last tab to the first', !$('audio').hidden && active() === $('tab-audio'));
  layout.direction = 'rtl';
  press(active(), 'ArrowRight');
  await settle();
  check(
    'in a right-to-left layout ArrowRight goes back, whatever the language',
    !$('settings').hidden && active() === $('tab-settings'),
    active().id,
  );
  layout.direction = 'ltr';
}

main().catch((err) => {
  check('popup run threw', false, err && err.stack ? err.stack : String(err));
}).finally(() => {
  if (errors.length) check('no unhandled rejections', false, errors.join('\n'));
  console.log('POPUP_RESULT ' + JSON.stringify({ checks }));
  process.exit(0);
});
