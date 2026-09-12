/**
 * Popup: three tabs plus the channel sheet overlay. Feeds is the merged
 * timeline; the Watchlist tab adds, searches, favourites and removes
 * channels. The worker owns all network; this page only renders.
 */

import { normalizeChannelInput, thumbUrl } from '../lib/yt.js';
import { sortChannelsForDisplay } from '../lib/store.js';
import { relativeTime, compactCount, absoluteTime, duration } from '../lib/fmt.js';
import { buildBackup } from '../lib/backup.js';
import {
  resolveLocale,
  loadMessages,
  translate,
  applyTo,
  applyDirection,
} from '../lib/i18n.js';

let messages = {};
let locale = 'en';
let appliedLocale = null;

const view = {
  settings: {},
  channels: [],
  feed: [],
  pollState: {},
  searchResults: null,
  error: '',
  busy: false,
  sweeping: false,
  feedNotice: '',
  backupNotice: null,
  importStage: 'idle',
  importBusy: false,
  pendingImportText: '',
  sheetId: null,
  sheetError: '',
};

const tabs = [...document.querySelectorAll('[role="tab"]')];
const panels = [...document.querySelectorAll('[role="tabpanel"]')];

function activate(tab) {
  for (const t of tabs) {
    const on = t === tab;
    t.classList.toggle('tab--active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
    t.tabIndex = on ? 0 : -1;
  }
  const name = tab.dataset.tab;
  for (const panel of panels) {
    panel.hidden = panel.id !== name;
  }
}

for (const tab of tabs) {
  tab.addEventListener('click', () => activate(tab));
}

document.querySelector('.tabs')?.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  const i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  event.preventDefault();
  // Read the computed direction, not the chosen language, so a later RTL
  // language still reverses ArrowRight to previous without a code change.
  const rtl = getComputedStyle(document.documentElement).direction === 'rtl';
  const delta = event.key === 'ArrowRight' ? (rtl ? -1 : 1) : (rtl ? 1 : -1);
  const next = tabs[(i + delta + tabs.length) % tabs.length];
  next.focus();
  activate(next);
});

function t(key, substitutions) {
  return translate(messages, key, substitutions);
}

async function applyI18n(setting) {
  const next = resolveLocale(setting, navigator.language);
  messages = await loadMessages(next);
  locale = next;
  if (appliedLocale === next) return;
  applyDirection(document, next);
  applyTo(document, messages);
  appliedLocale = next;
}

// The popup never talks to youtube.com. Every network action is a
// message to the worker, which is the only place that fetches.
function send(message) {
  return chrome.runtime.sendMessage(message);
}

function applySnapshot(snap) {
  if (!snap || typeof snap !== 'object' || snap.ok === false) return false;
  if (!('channels' in snap) && !('settings' in snap)) return false;
  if (snap.settings) view.settings = snap.settings;
  if (Array.isArray(snap.channels)) view.channels = snap.channels;
  if (Array.isArray(snap.feed)) view.feed = snap.feed;
  if (snap.pollState) view.pollState = snap.pollState;
  return true;
}

async function refreshState() {
  const snap = await send({ type: 'getState' });
  if (!applySnapshot(snap)) {
    view.error = formatError(snap?.error);
  }
}

function syncSearchInList() {
  if (!Array.isArray(view.searchResults)) return;
  const ids = new Set(view.channels.map((c) => c.id));
  view.searchResults = view.searchResults.map((r) => ({ ...r, inList: ids.has(r.id) }));
}

function readPath(obj, path) {
  return path.split('.').reduce((acc, key) => acc?.[key], obj);
}

function buildPatch(path, value) {
  const keys = path.split('.');
  const patch = {};
  let cursor = patch;
  for (let i = 0; i < keys.length; i++) {
    if (i === keys.length - 1) cursor[keys[i]] = value;
    else cursor = cursor[keys[i]] = {};
  }
  return patch;
}

function extensionVersion() {
  try {
    return chrome.runtime.getManifest?.()?.version || '';
  } catch {
    return '';
  }
}

function formatError(error) {
  const code = String(error || '');
  if (code === 'already added') return t('watchlistAlreadyAdded');
  if (code === 'not a channel') return t('watchlistNotAChannel');
  return t('watchlistError', [code]);
}

function ltrRun(el) {
  // @handles and timestamps like 17:14 are LTR; without isolation they
  // scramble inside Arabic text.
  el.dir = 'ltr';
  return el;
}

function isChannelRef(input) {
  const trimmed = String(input).trim();
  if (!trimmed) return false;
  // A space is a search name; normalizeChannelInput would otherwise treat
  // "marques brownlee" as the handle @marques brownlee.
  if (/\s/.test(trimmed)) return false;
  return normalizeChannelInput(trimmed) != null;
}

function avatarEl(url) {
  if (url) {
    const img = document.createElement('img');
    img.className = 'avatar';
    img.alt = '';
    img.src = url;
    return img;
  }
  const ph = document.createElement('span');
  ph.className = 'avatar';
  ph.setAttribute('aria-hidden', 'true');
  return ph;
}

function textEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = text;
  return el;
}

function buttonEl(className, label, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  if (className) btn.className = className;
  btn.textContent = label;
  btn.disabled = view.busy;
  btn.addEventListener('click', onClick);
  return btn;
}

function openUrl(url) {
  if (!url) return;
  try {
    const opening = chrome.tabs.create({ url, active: true });
    Promise.resolve(opening).then(() => window.close(), () => {});
  } catch {
    // Leave the popup open if the tab could not be created.
  }
}

function openChannelSheet(id) {
  if (!id) return;
  view.sheetId = id;
  view.sheetError = '';
  render();
  document.getElementById('channel-sheet-close')?.focus?.();
}

function closeChannelSheet() {
  if (!view.sheetId) return;
  view.sheetId = null;
  view.sheetError = '';
  render();
}

function searchRow(result, locale) {
  const row = document.createElement('div');
  row.className = 'channel-row';

  const body = document.createElement('div');
  body.className = 'channel-row__main';
  body.appendChild(avatarEl(result.avatar));

  const text = document.createElement('div');
  text.className = 'channel-row__text';
  text.appendChild(textEl('span', 'channel-row__title', result.title || result.handle || result.id));

  const meta = document.createElement('div');
  meta.className = 'channel-row__meta';
  if (result.handle) meta.appendChild(ltrRun(textEl('span', 'handle', result.handle)));
  if (Number(result.subscribers) > 0) {
    meta.appendChild(textEl(
      'span',
      '',
      t('watchlistSubscribers', [compactCount(result.subscribers, locale)]),
    ));
  }
  text.appendChild(meta);
  body.appendChild(text);
  row.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'channel-row__actions';
  if (result.inList) {
    const mark = textEl('span', 'added-mark', `✓ ${t('watchlistAdded')}`);
    actions.appendChild(mark);
  } else {
    const add = buttonEl('btn btn--primary', t('watchlistAdd'), () => {
      void addChannel(result.id, { fromSearch: true });
    });
    actions.appendChild(add);
  }
  row.appendChild(actions);
  return row;
}

function channelRow(ch, locale) {
  const row = document.createElement('div');
  row.className = 'channel-row';

  const title = ch.title || ch.handle || ch.id;
  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'channel-row__main';
  main.setAttribute('aria-label', t('watchlistOpenChannel', [title]));
  main.addEventListener('click', () => openChannelSheet(ch.id));
  main.appendChild(avatarEl(ch.avatar));

  const text = document.createElement('div');
  text.className = 'channel-row__text';
  text.appendChild(textEl('span', 'channel-row__title', title));

  const meta = document.createElement('div');
  meta.className = 'channel-row__meta';
  if (ch.handle) meta.appendChild(ltrRun(textEl('span', 'handle', ch.handle)));

  const at = Number(ch.lastVideoAt) || 0;
  // 0 means we have never seen a video, not "a very old one".
  if (at) {
    const age = textEl('span', '', relativeTime(at, Date.now(), locale));
    age.title = absoluteTime(at, locale);
    meta.appendChild(age);
  }

  if (ch.lastError && ch.lastError.message) {
    const warn = textEl('span', 'channel-row__warn', '⚠');
    warn.title = String(ch.lastError.message);
    warn.setAttribute('aria-label', t('watchlistChannelError'));
    meta.appendChild(warn);
  }

  text.appendChild(meta);
  main.appendChild(text);
  row.appendChild(main);

  const actions = document.createElement('div');
  actions.className = 'channel-row__actions';
  actions.appendChild(channelMenu(ch));
  row.appendChild(actions);
  return row;
}

function closeAllMenus() {
  let closed = false;
  for (const list of document.querySelectorAll('.menu__list')) {
    if (!list.hidden) closed = true;
    list.hidden = true;
  }
  for (const toggle of document.querySelectorAll('.menu__toggle')) {
    toggle.setAttribute('aria-expanded', 'false');
  }
  return closed;
}

function channelMenu(ch) {
  const menu = document.createElement('div');
  menu.className = 'menu';

  const list = document.createElement('div');
  list.className = 'menu__list';
  list.hidden = true;

  const toggle = buttonEl('icon-btn menu__toggle', '⋯', (event) => {
    event.stopPropagation?.();
    const willOpen = list.hidden;
    closeAllMenus();
    if (willOpen) {
      list.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
    }
  });
  toggle.title = t('watchlistActions');
  toggle.setAttribute('aria-label', t('watchlistActions'));
  toggle.setAttribute('aria-haspopup', 'true');
  toggle.setAttribute('aria-expanded', 'false');

  const fav = buttonEl(
    'menu__item',
    t(ch.favorite ? 'watchlistFavoriteRemove' : 'watchlistFavoriteAdd'),
    () => {
      closeAllMenus();
      void toggleFavorite(ch.id, !ch.favorite);
    },
  );
  const remove = buttonEl('menu__item menu__item--danger', t('watchlistRemove'), () => {
    closeAllMenus();
    void removeChannel(ch.id);
  });

  list.append(fav, remove);
  menu.append(toggle, list);
  return menu;
}

function feedTag(item, locale) {
  if (item.k === 'live') {
    return textEl('span', 'feed-tag feed-tag--live', t('feedTagLive'));
  }
  if (item.k === 'short') {
    return textEl('span', 'feed-tag feed-tag--short', t('feedTagShort'));
  }
  if (item.k === 'premiere') {
    const st = Number(item.st) || 0;
    const now = Date.now();
    let text = t('feedTagPremiere');
    if (st > now) {
      const when = relativeTime(st, now, locale);
      if (when) text = t('feedTagPremiereAt', [when]);
    }
    return textEl('span', 'feed-tag feed-tag--premiere', text);
  }
  return null;
}

function openVideo(item) {
  const id = String(item.v || '');
  if (!id) return;
  const url = item.k === 'short'
    ? `https://www.youtube.com/shorts/${id}`
    : `https://www.youtube.com/watch?v=${id}`;
  openUrl(url);
}

function feedRow(item, locale, channel, { showChannel = true } = {}) {
  const row = document.createElement('div');
  row.className = 'feed-row';
  row.tabIndex = 0;
  const title = item.t || '';
  row.setAttribute('aria-label', t('feedOpenVideo', [title]));
  row.addEventListener('click', () => openVideo(item));
  row.addEventListener('keydown', (event) => {
    if (event.target !== row) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openVideo(item);
  });

  // Pin the thumbnail box so a slow image cannot reflow the list.
  const thumb = document.createElement('div');
  thumb.className = 'feed-row__thumb';
  const img = document.createElement('img');
  img.alt = title;
  img.src = thumbUrl(item.v, 'mq');
  thumb.appendChild(img);
  // Duration rides on the thumbnail rather than the meta line. Four parts on
  // one line do not fit 400px, and this is the one with a natural home.
  const dur = (item.k === 'live' || item.k === 'premiere') ? '' : duration(item.d);
  if (dur) thumb.appendChild(ltrRun(textEl('span', 'feed-row__duration', dur)));
  row.appendChild(thumb);

  const body = document.createElement('div');
  body.className = 'feed-row__body';

  const headline = document.createElement('div');
  headline.className = 'feed-row__headline';
  headline.appendChild(textEl('span', 'feed-row__title', title));
  const tag = feedTag(item, locale);
  if (tag) headline.appendChild(tag);
  body.appendChild(headline);

  const metaNodes = [];
  const channelName = channel?.title || channel?.handle || '';
  if (showChannel && channelName) {
    const chBtn = document.createElement('button');
    chBtn.type = 'button';
    chBtn.className = 'feed-row__channel';
    chBtn.textContent = channelName;
    chBtn.setAttribute('aria-label', t('watchlistOpenChannel', [channelName]));
    chBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openChannelSheet(channel.id);
    });
    metaNodes.push(chBtn);
  }

  const at = Number(item.at) || 0;
  if (at) {
    const age = textEl('span', '', relativeTime(at, Date.now(), locale));
    const abs = absoluteTime(at, locale);
    if (abs) age.title = abs;
    metaNodes.push(age);
  }

  const views = Number(item.vw);
  if (Number.isFinite(views) && views > 0) {
    const count = compactCount(views, locale);
    if (count) metaNodes.push(textEl('span', 'feed-row__views', t('feedViews', [count])));
  }

  if (metaNodes.length) {
    const meta = document.createElement('div');
    meta.className = 'feed-row__meta';
    // The separator is drawn by CSS on each part after the first, so that a
    // meta line wrapping onto a second row carries its dot down with the part
    // it belongs to instead of stranding one at the end of the line.
    metaNodes.forEach((node) => meta.appendChild(node));
    body.appendChild(meta);
  }

  row.appendChild(body);
  return row;
}

function visibleFeedItems() {
  const showShorts = !!view.settings?.feed?.showShorts;
  // Shorts stay in storage; the view drops them when the setting is off.
  const items = [];
  for (const item of view.feed) {
    if (!item || !item.v) continue;
    if (!showShorts && item.k === 'short') continue;
    items.push(item);
  }
  items.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  return items;
}

function matchesFeedFilter(item, channel, q) {
  if (!q) return true;
  const title = String(item.t || '').toLowerCase();
  const name = String(channel?.title || channel?.handle || '').toLowerCase();
  return title.includes(q) || name.includes(q);
}

function renderFeeds(locale) {
  const filterEl = document.getElementById('feed-filter');
  const refreshBtn = document.getElementById('feed-refresh');
  const spinner = document.getElementById('feed-refresh-spinner');
  const lastEl = document.getElementById('feed-last-poll');
  const noticeEl = document.getElementById('feed-notice');
  const listEl = document.getElementById('feed-list');
  const emptyNone = document.getElementById('feed-empty-no-channels');
  const emptyWait = document.getElementById('feed-empty-no-items');
  const emptyFilter = document.getElementById('feed-empty-filter');
  const missEl = document.getElementById('feed-filter-miss');
  const emptyRefresh = document.getElementById('feed-waiting-refresh');
  const bar = filterEl.parentElement;

  const locked = view.sweeping;
  refreshBtn.disabled = locked;
  if (emptyRefresh) emptyRefresh.disabled = locked;
  spinner.hidden = !view.sweeping;
  bar.classList.toggle('is-busy', view.sweeping);
  bar.setAttribute('aria-busy', view.sweeping ? 'true' : 'false');
  refreshBtn.setAttribute('aria-label', t('feedRefresh'));
  refreshBtn.title = t('feedRefresh');

  const lastAt = Number(view.pollState?.lastPollAt) || 0;
  if (lastAt) {
    const rel = relativeTime(lastAt, Date.now(), locale);
    if (rel) {
      lastEl.hidden = false;
      lastEl.textContent = t('feedLastSweep', [rel]);
      lastEl.title = absoluteTime(lastAt, locale);
    } else {
      lastEl.hidden = true;
      lastEl.textContent = '';
      lastEl.removeAttribute('title');
    }
  } else {
    lastEl.hidden = true;
    lastEl.textContent = '';
    lastEl.removeAttribute('title');
  }

  if (view.feedNotice) {
    noticeEl.hidden = false;
    noticeEl.textContent = view.feedNotice;
    noticeEl.classList.toggle('banner--error', view.feedNotice !== t('feedSweepRunning'));
  } else {
    noticeEl.hidden = true;
    noticeEl.textContent = '';
    noticeEl.classList.remove('banner--error');
  }

  const channelsById = new Map(view.channels.map((ch) => [ch.id, ch]));
  // The feed has no read state: opening a video never hides it, and
  // nothing is marked. Newest first, always the full list.
  const items = visibleFeedItems();
  const q = (filterEl.value || '').trim().toLowerCase();
  const shown = q
    ? items.filter((item) => matchesFeedFilter(item, channelsById.get(item.c), q))
    : items;

  listEl.replaceChildren();
  for (const item of shown) {
    listEl.appendChild(feedRow(item, locale, channelsById.get(item.c)));
  }

  const hasChannels = view.channels.length > 0;
  const hasShown = shown.length > 0;
  emptyNone.hidden = hasChannels;
  emptyWait.hidden = !(hasChannels && !hasShown && !q);
  emptyFilter.hidden = !(hasChannels && !hasShown && q);
  listEl.hidden = !hasChannels || !hasShown;

  if (!emptyFilter.hidden && missEl) {
    missEl.textContent = t('emptyFeedFilter', [(filterEl.value || '').trim()]);
  }
}

function render() {
  renderFeeds(locale);
  const form = document.getElementById('watchlist-add-form');
  const input = document.getElementById('watchlist-input');
  const addBtn = document.getElementById('watchlist-add-btn');
  const spinner = document.getElementById('watchlist-spinner');
  const errorEl = document.getElementById('watchlist-error');
  const resultsEl = document.getElementById('watchlist-results');
  const noResultsEl = document.getElementById('watchlist-no-results');
  const listEl = document.getElementById('watchlist-list');
  const emptyEl = document.getElementById('watchlist-empty');

  form.classList.toggle('is-busy', view.busy);
  form.setAttribute('aria-busy', view.busy ? 'true' : 'false');
  input.disabled = view.busy;
  addBtn.disabled = view.busy;
  spinner.hidden = !view.busy;

  if (view.error) {
    errorEl.hidden = false;
    errorEl.textContent = view.error;
  } else {
    errorEl.hidden = true;
    errorEl.textContent = '';
  }

  const results = view.searchResults;
  const showResults = Array.isArray(results);
  const hasHits = showResults && results.length > 0;

  resultsEl.hidden = !hasHits;
  resultsEl.replaceChildren();
  if (hasHits) {
    for (const r of results) resultsEl.appendChild(searchRow(r, locale));
  }

  noResultsEl.hidden = !(showResults && results.length === 0 && !view.busy);

  const channels = sortChannelsForDisplay(view.channels, view.feed);
  listEl.replaceChildren();
  for (const ch of channels) listEl.appendChild(channelRow(ch, locale));
  emptyEl.hidden = channels.length > 0;
  renderSettings(locale);
  renderChannelSheet();
}

function renderChannelSheet() {
  const sheet = document.getElementById('channel-sheet');
  if (!sheet) return;

  const id = view.sheetId;
  const ch = id ? view.channels.find((c) => c.id === id) : null;
  if (!id || !ch) {
    view.sheetId = null;
    sheet.hidden = true;
    return;
  }

  sheet.hidden = false;

  const titleEl = document.getElementById('channel-sheet-name');
  const handleEl = document.getElementById('channel-sheet-handle');
  const avatar = document.getElementById('channel-sheet-avatar');
  const avatarPh = document.getElementById('channel-sheet-avatar-ph');
  const refreshBtn = document.getElementById('channel-sheet-refresh');
  const spinner = document.getElementById('channel-sheet-spinner');
  const statusEl = document.getElementById('channel-sheet-status');
  const listEl = document.getElementById('channel-sheet-videos');
  const emptyEl = document.getElementById('channel-sheet-empty');

  const title = ch.title || ch.handle || ch.id;
  titleEl.textContent = title;
  handleEl.textContent = ch.handle || '';
  ltrRun(handleEl);

  if (ch.avatar) {
    avatar.src = ch.avatar;
    avatar.hidden = false;
    avatarPh.hidden = true;
  } else {
    avatar.removeAttribute('src');
    avatar.hidden = true;
    avatarPh.hidden = false;
  }

  const locked = view.sweeping;
  refreshBtn.disabled = locked;
  spinner.hidden = !locked;
  refreshBtn.setAttribute('aria-label', t('feedRefresh'));
  refreshBtn.title = t('feedRefresh');
  sheet.setAttribute('aria-busy', locked ? 'true' : 'false');

  if (view.sheetError) {
    statusEl.hidden = false;
    statusEl.textContent = view.sheetError;
    statusEl.classList.add('banner--error');
  } else {
    statusEl.hidden = true;
    statusEl.textContent = '';
    statusEl.classList.remove('banner--error');
  }

  const items = visibleFeedItems().filter((item) => item.c === ch.id);
  listEl.replaceChildren();
  for (const item of items) {
    listEl.appendChild(feedRow(item, locale, ch, { showChannel: false }));
  }

  const hasItems = items.length > 0;
  listEl.hidden = !hasItems;
  emptyEl.hidden = locked || hasItems;
}

function renderSettings(locale) {
  const s = view.settings || {};
  for (const input of document.querySelectorAll('#settings [data-setting]')) {
    const value = readPath(s, input.dataset.setting);
    if (input.type === 'checkbox') input.checked = !!value;
    else input.value = value ?? '';
  }

  const locked = view.importBusy;
  const exportBtn = document.getElementById('settings-export');
  const importBtn = document.getElementById('settings-import');
  const mergeBtn = document.getElementById('settings-import-merge');
  const replaceBtn = document.getElementById('settings-import-replace');
  const confirmBtn = document.getElementById('settings-import-replace-confirm');
  const cancelBtn = document.getElementById('settings-import-replace-cancel');
  for (const btn of [exportBtn, importBtn, mergeBtn, replaceBtn, confirmBtn, cancelBtn]) {
    if (btn) btn.disabled = locked;
  }

  const choice = document.getElementById('settings-import-choice');
  const confirm = document.getElementById('settings-import-confirm');
  if (choice) choice.hidden = view.importStage !== 'choose';
  if (confirm) confirm.hidden = view.importStage !== 'confirm';

  const status = document.getElementById('settings-backup-status');
  if (status) {
    if (view.backupNotice) {
      status.hidden = false;
      status.textContent = view.backupNotice.text;
      status.classList.toggle('banner--error', !!view.backupNotice.error);
    } else {
      status.hidden = true;
      status.textContent = '';
      status.classList.remove('banner--error');
    }
  }

  const nCh = view.channels.length;
  const nFeed = view.feed.length;
  const chEl = document.getElementById('settings-stat-channels');
  const feedEl = document.getElementById('settings-stat-feed');
  const lastEl = document.getElementById('settings-stat-last');
  const verEl = document.getElementById('settings-stat-version');
  if (chEl) chEl.textContent = t('settingsFooterChannels', [String(nCh)]);
  if (feedEl) feedEl.textContent = t('settingsFooterFeed', [String(nFeed)]);
  if (lastEl) {
    const lastAt = Number(view.pollState?.lastPollAt) || 0;
    if (lastAt) {
      const rel = relativeTime(lastAt, Date.now(), locale);
      lastEl.textContent = rel ? t('feedLastSweep', [rel]) : t('settingsFooterNever');
      const abs = absoluteTime(lastAt, locale);
      if (abs) lastEl.title = abs;
      else lastEl.removeAttribute('title');
    } else {
      lastEl.textContent = t('settingsFooterNever');
      lastEl.removeAttribute('title');
    }
  }
  if (verEl) {
    const version = extensionVersion();
    if (version) {
      verEl.hidden = false;
      verEl.textContent = t('settingsFooterVersion', [version]);
    } else {
      verEl.hidden = true;
      verEl.textContent = '';
    }
  }
}

async function withBusy(fn) {
  if (view.busy) return;
  view.busy = true;
  view.error = '';
  render();
  try {
    await fn();
  } catch (err) {
    view.error = formatError(err?.message || err);
  } finally {
    view.busy = false;
    render();
  }
}

async function addChannel(input, { fromSearch }) {
  await withBusy(async () => {
    const res = await send({ type: 'addChannel', input });
    if (!res || res.ok === false) {
      view.error = formatError(res?.error);
      return;
    }
    if (!fromSearch) {
      const box = document.getElementById('watchlist-input');
      if (box) box.value = '';
      view.searchResults = null;
    }
    await refreshState();
    if (fromSearch) syncSearchInList();
  });
}

async function runSearch(query) {
  await withBusy(async () => {
    const res = await send({ type: 'searchChannels', query });
    if (res && res.ok === false) {
      view.searchResults = null;
      view.error = formatError(res.error);
      return;
    }
    if (!Array.isArray(res)) {
      view.searchResults = null;
      view.error = formatError(res?.error);
      return;
    }
    view.searchResults = res;
  });
}

async function toggleFavorite(id, on) {
  await withBusy(async () => {
    const res = await send({ type: 'setFavorite', id, on });
    if (res && res.ok === false) {
      view.error = formatError(res.error);
      return;
    }
    await refreshState();
  });
}

async function removeChannel(id) {
  await withBusy(async () => {
    const res = await send({ type: 'removeChannel', id });
    if (res && res.ok === false) {
      view.error = formatError(res.error);
      return;
    }
    await refreshState();
  });
}

async function submitAdd(raw) {
  const input = String(raw || '').trim();
  if (!input || view.busy) return;
  if (isChannelRef(input)) await addChannel(input, { fromSearch: false });
  else await runSearch(input);
}

async function requestSweep({ onlyId = null } = {}) {
  if (view.sweeping) return;
  view.sweeping = true;
  view.feedNotice = '';
  view.sheetError = '';
  render();
  try {
    const msg = { type: 'sweep', scope: 'all' };
    if (onlyId) msg.onlyId = onlyId;
    const res = await send(msg);
    if (res && res.ok === false) {
      const text = res.error === 'already running'
        ? t('feedSweepRunning')
        : formatError(res.error);
      if (onlyId) view.sheetError = text;
      else view.feedNotice = text;
    }
    await refreshState();
  } catch (err) {
    const text = formatError(err?.message || err);
    if (onlyId) view.sheetError = text;
    else view.feedNotice = text;
  } finally {
    view.sweeping = false;
    render();
  }
}

function bindFeeds() {
  const filter = document.getElementById('feed-filter');
  const refresh = document.getElementById('feed-refresh');
  const gotoWatchlist = document.getElementById('feed-goto-watchlist');
  const emptyRefresh = document.getElementById('feed-waiting-refresh');
  const emptyClear = document.getElementById('feed-filter-clear');

  filter.addEventListener('input', () => render());
  refresh.addEventListener('click', () => {
    void requestSweep();
  });
  emptyRefresh.addEventListener('click', () => {
    void requestSweep();
  });
  emptyClear.addEventListener('click', () => {
    filter.value = '';
    render();
    filter.focus();
  });
  gotoWatchlist.addEventListener('click', () => {
    const tab = document.getElementById('tab-watchlist');
    if (tab) activate(tab);
  });
}

// Settings writes go through the worker so it can rebuild poll alarms
// and the badge from the new values. A storage write from here would
// leave both stale until the next restart.
async function patchSettings(patch) {
  try {
    const snap = await send({ type: 'updateSettings', patch });
    if (!applySnapshot(snap)) {
      view.backupNotice = { text: formatError(snap?.error), error: true };
    }
  } catch (err) {
    view.backupNotice = { text: formatError(err?.message || err), error: true };
  }
  await applyI18n(view.settings?.ui?.locale);
  render();
}

function exportBackup() {
  const data = buildBackup({ settings: view.settings, channels: view.channels });
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `youtube-companion-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking in the same turn can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  view.backupNotice = {
    text: t('settingsExportDone', [String((data.channels || []).length)]),
    error: false,
  };
  render();
}

async function importBackup(mode) {
  if (view.importBusy || !view.pendingImportText) return;
  view.importBusy = true;
  view.backupNotice = null;
  render();
  try {
    const res = await send({
      type: 'importBackup',
      data: view.pendingImportText,
      mode,
    });
    if (!res || res.ok === false) {
      view.backupNotice = { text: String(res?.error || formatError('')), error: true };
      view.importStage = 'idle';
    } else {
      if (res.state) applySnapshot(res.state);
      await applyI18n(view.settings?.ui?.locale);
      const added = Number(res.added) || 0;
      const skipped = Number(res.skipped) || 0;
      const text = mode === 'replace'
        ? t('settingsImportReplaced', [String(added)])
        : t('settingsImportAdded', [String(added), String(skipped)]);
      view.backupNotice = { text, error: false };
      view.pendingImportText = '';
      view.importStage = 'idle';
    }
  } catch (err) {
    view.backupNotice = { text: formatError(err?.message || err), error: true };
    view.importStage = 'idle';
  } finally {
    view.importBusy = false;
    render();
  }
}

function bindSettings() {
  const panel = document.getElementById('settings');
  panel.addEventListener('change', (event) => {
    const el = event.target;
    if (!(el instanceof HTMLElement)) return;
    const path = el.dataset.setting;
    if (!path) return;
    let next;
    if (el.type === 'checkbox') next = el.checked;
    else if (el.type === 'number') {
      next = Number(el.value);
      if (!Number.isFinite(next)) return;
    } else next = el.value;
    void patchSettings(buildPatch(path, next));
  });

  document.getElementById('settings-export').addEventListener('click', () => {
    exportBackup();
  });

  const fileInput = document.getElementById('settings-import-file');
  document.getElementById('settings-import').addEventListener('click', () => {
    fileInput.click();
  });
  fileInput.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      view.pendingImportText = await file.text();
      view.importStage = 'choose';
      view.backupNotice = null;
    } catch (err) {
      view.pendingImportText = '';
      view.importStage = 'idle';
      view.backupNotice = { text: formatError(err?.message || err), error: true };
    }
    render();
  });

  document.getElementById('settings-import-merge').addEventListener('click', () => {
    void importBackup('merge');
  });
  document.getElementById('settings-import-replace').addEventListener('click', () => {
    if (!view.pendingImportText) return;
    view.importStage = 'confirm';
    render();
  });
  document.getElementById('settings-import-replace-confirm').addEventListener('click', () => {
    void importBackup('replace');
  });
  document.getElementById('settings-import-replace-cancel').addEventListener('click', () => {
    view.importStage = 'choose';
    render();
  });
}

function bindWatchlist() {
  const form = document.getElementById('watchlist-add-form');
  const input = document.getElementById('watchlist-input');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitAdd(input.value);
  });
  input.addEventListener('input', () => {
    if (input.value.trim()) return;
    if (view.searchResults == null && !view.error) return;
    view.searchResults = null;
    view.error = '';
    render();
  });
}

function bindChannelSheet() {
  const sheet = document.getElementById('channel-sheet');
  document.getElementById('channel-sheet-close')?.addEventListener('click', () => {
    closeChannelSheet();
  });
  document.getElementById('channel-sheet-refresh')?.addEventListener('click', () => {
    if (!view.sheetId) return;
    void requestSweep({ onlyId: view.sheetId });
  });
  sheet?.addEventListener('click', (event) => {
    if (event.target === sheet) closeChannelSheet();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (closeAllMenus()) {
      event.preventDefault();
      return;
    }
    if (!view.sheetId) return;
    event.preventDefault();
    closeChannelSheet();
  });
}

document.addEventListener('click', closeAllMenus);

bindWatchlist();
bindFeeds();
bindSettings();
bindChannelSheet();

void (async () => {
  await applyI18n('auto');
  view.busy = true;
  render();
  try {
    const snap = await send({ type: 'popupOpened' });
    if (!applySnapshot(snap)) view.error = formatError(snap?.error);
    await applyI18n(view.settings?.ui?.locale);
  } catch (err) {
    view.error = formatError(err?.message || err);
  } finally {
    view.busy = false;
    render();
  }
})();
