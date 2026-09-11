/**
 * Popup: three tabs. Feeds is the merged timeline; the Watchlist tab
 * adds, searches, favourites and removes channels. The worker owns all
 * network; this page only renders.
 */

import { normalizeChannelInput, thumbUrl } from '../lib/yt.js';
import { sortChannelsForDisplay } from '../lib/store.js';
import { relativeTime, compactCount, absoluteTime, duration } from '../lib/fmt.js';

const FALLBACK = {
  watchlistAdd: 'Add',
  watchlistAddPlaceholder: 'Channel URL, @handle, or name',
  watchlistAdded: 'Added',
  watchlistNoResults: 'No channels found',
  watchlistAlreadyAdded: 'Already in your list',
  watchlistNotAChannel: 'That is not a channel',
  watchlistError: 'Something went wrong: $ERROR$',
  watchlistSubscribers: '$COUNT$ subscribers',
  watchlistRemove: 'Remove',
  watchlistRemovePrompt: 'Remove?',
  watchlistRemoveConfirm: 'Remove',
  watchlistRemoveCancel: 'Cancel',
  watchlistFavoriteAdd: 'Add to favourites',
  watchlistFavoriteRemove: 'Remove from favourites',
  watchlistOpenChannel: 'Open $TITLE$',
  watchlistChannelError: 'Could not update this channel',
  emptyWatchlist: 'Watchlist is empty',
  emptyFeeds: 'No channels yet',
  emptyFeedWaiting: 'Nothing has arrived yet',
  emptyFeedFilter: 'No videos match "$QUERY$"',
  feedFilterPlaceholder: 'Filter by title or channel',
  feedRefresh: 'Refresh',
  feedLastSweep: 'Last check $TIME$',
  feedSweepRunning: 'A check is already running',
  feedEmptyAdd: 'Add a channel',
  feedFilterClear: 'Clear filter',
  feedTagLive: 'LIVE',
  feedTagShort: 'SHORT',
  feedTagPremiere: 'PREMIERE',
  feedTagPremiereAt: 'PREMIERE $TIME$',
  feedViews: '$COUNT$ views',
  feedOpenVideo: 'Open $TITLE$',
};

const view = {
  settings: {},
  channels: [],
  feed: [],
  pollState: {},
  searchResults: null,
  error: '',
  busy: false,
  pendingRemoveId: null,
  sweeping: false,
  feedNotice: '',
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
  const delta = event.key === 'ArrowRight' ? 1 : -1;
  const next = tabs[(i + delta + tabs.length) % tabs.length];
  next.focus();
  activate(next);
});

function msg(key, substitutions) {
  try {
    const got = chrome.i18n?.getMessage?.(key, substitutions);
    if (got) return got;
  } catch {
    // Fall through to the English copy baked into this file.
  }
  let text = FALLBACK[key] || '';
  const subs = substitutions == null ? [] : [].concat(substitutions);
  let i = 0;
  text = text.replace(/\$[A-Z]+\$/g, () => (i < subs.length ? String(subs[i++]) : ''));
  return text;
}

// The popup never talks to youtube.com. Every network action is a
// message to the worker, which is the only place that fetches.
function send(message) {
  return chrome.runtime.sendMessage(message);
}

function activeLocale() {
  const loc = view.settings?.ui?.locale;
  if (loc === 'en' || loc === 'ar') return loc;
  const ui = (chrome.i18n?.getUILanguage?.() || navigator.language || 'en').toLowerCase();
  return ui.startsWith('ar') ? 'ar' : 'en';
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

function formatError(error) {
  const code = String(error || '');
  if (code === 'already added') return msg('watchlistAlreadyAdded');
  if (code === 'not a channel') return msg('watchlistNotAChannel');
  return msg('watchlistError', [code]);
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

function openChannelWindow() {
  // The per-channel window opens from here.
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
  if (result.handle) meta.appendChild(textEl('span', '', result.handle));
  if (Number(result.subscribers) > 0) {
    meta.appendChild(textEl(
      'span',
      '',
      msg('watchlistSubscribers', [compactCount(result.subscribers, locale)]),
    ));
  }
  text.appendChild(meta);
  body.appendChild(text);
  row.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'channel-row__actions';
  if (result.inList) {
    const mark = textEl('span', 'added-mark', `✓ ${msg('watchlistAdded')}`);
    mark.dataset.i18n = 'watchlistAdded';
    actions.appendChild(mark);
  } else {
    const add = buttonEl('btn btn--primary', msg('watchlistAdd'), () => {
      void addChannel(result.id, { fromSearch: true });
    });
    add.dataset.i18n = 'watchlistAdd';
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
  main.setAttribute('aria-label', msg('watchlistOpenChannel', [title]));
  main.addEventListener('click', openChannelWindow);
  main.appendChild(avatarEl(ch.avatar));

  const text = document.createElement('div');
  text.className = 'channel-row__text';
  text.appendChild(textEl('span', 'channel-row__title', title));

  const meta = document.createElement('div');
  meta.className = 'channel-row__meta';
  if (ch.handle) meta.appendChild(textEl('span', '', ch.handle));

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
    warn.setAttribute('aria-label', msg('watchlistChannelError'));
    meta.appendChild(warn);
  }

  text.appendChild(meta);
  main.appendChild(text);
  row.appendChild(main);

  const actions = document.createElement('div');
  actions.className = 'channel-row__actions';

  if (view.pendingRemoveId === ch.id) {
    // A modal dialog blocks the popup and can wedge the extension, so
    // removal confirms on the row itself.
    const prompt = textEl('span', 'confirm-prompt', msg('watchlistRemovePrompt'));
    prompt.dataset.i18n = 'watchlistRemovePrompt';
    const yes = buttonEl('btn btn--primary', msg('watchlistRemoveConfirm'), () => {
      void removeChannel(ch.id);
    });
    yes.dataset.i18n = 'watchlistRemoveConfirm';
    const no = buttonEl('btn', msg('watchlistRemoveCancel'), () => {
      view.pendingRemoveId = null;
      render();
    });
    no.dataset.i18n = 'watchlistRemoveCancel';
    actions.appendChild(prompt);
    actions.appendChild(yes);
    actions.appendChild(no);
  } else {
    const fav = buttonEl('icon-btn', '★', () => {
      void toggleFavorite(ch.id, !ch.favorite);
    });
    fav.classList.toggle('is-on', !!ch.favorite);
    fav.setAttribute('aria-pressed', ch.favorite ? 'true' : 'false');
    fav.setAttribute('aria-label', msg(ch.favorite ? 'watchlistFavoriteRemove' : 'watchlistFavoriteAdd'));
    fav.title = fav.getAttribute('aria-label');

    const remove = buttonEl('icon-btn', '×', () => {
      view.pendingRemoveId = ch.id;
      render();
    });
    remove.setAttribute('aria-label', msg('watchlistRemove'));
    remove.title = msg('watchlistRemove');

    actions.appendChild(fav);
    actions.appendChild(remove);
  }

  row.appendChild(actions);
  return row;
}

function feedTag(item, locale) {
  if (item.k === 'live') {
    return textEl('span', 'feed-tag feed-tag--live', msg('feedTagLive'));
  }
  if (item.k === 'short') {
    return textEl('span', 'feed-tag feed-tag--short', msg('feedTagShort'));
  }
  if (item.k === 'premiere') {
    const st = Number(item.st) || 0;
    const now = Date.now();
    let text = msg('feedTagPremiere');
    if (st > now) {
      const when = relativeTime(st, now, locale);
      if (when) text = msg('feedTagPremiereAt', [when]);
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
  try {
    const opening = chrome.tabs.create({ url, active: true });
    Promise.resolve(opening).then(() => window.close(), () => {});
  } catch {
    // Leave the popup open if the tab could not be created.
  }
}

function feedRow(item, locale, channel) {
  const row = document.createElement('div');
  row.className = 'feed-row';
  row.tabIndex = 0;
  const title = item.t || '';
  row.setAttribute('aria-label', msg('feedOpenVideo', [title]));
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
  if (dur) thumb.appendChild(textEl('span', 'feed-row__duration', dur));
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
  if (channelName) {
    const chBtn = document.createElement('button');
    chBtn.type = 'button';
    chBtn.className = 'feed-row__channel';
    chBtn.textContent = channelName;
    chBtn.setAttribute('aria-label', msg('watchlistOpenChannel', [channelName]));
    chBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openChannelWindow();
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
    if (count) metaNodes.push(textEl('span', 'feed-row__views', msg('feedViews', [count])));
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
  refreshBtn.setAttribute('aria-label', msg('feedRefresh'));
  refreshBtn.title = msg('feedRefresh');

  const lastAt = Number(view.pollState?.lastPollAt) || 0;
  if (lastAt) {
    const rel = relativeTime(lastAt, Date.now(), locale);
    if (rel) {
      lastEl.hidden = false;
      lastEl.textContent = msg('feedLastSweep', [rel]);
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
    noticeEl.classList.toggle('banner--error', view.feedNotice !== msg('feedSweepRunning'));
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
    missEl.textContent = msg('emptyFeedFilter', [(filterEl.value || '').trim()]);
  }
}

function render() {
  const locale = activeLocale();
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
    view.pendingRemoveId = null;
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

async function requestSweep() {
  if (view.sweeping) return;
  view.sweeping = true;
  view.feedNotice = '';
  render();
  try {
    const res = await send({ type: 'sweep', scope: 'all' });
    if (res && res.ok === false) {
      view.feedNotice = res.error === 'already running'
        ? msg('feedSweepRunning')
        : formatError(res.error);
    }
    await refreshState();
  } catch (err) {
    view.feedNotice = formatError(err?.message || err);
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
  const placeholder = msg('feedFilterPlaceholder');
  if (placeholder) {
    filter.placeholder = placeholder;
    filter.setAttribute('aria-label', placeholder);
  }
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
  const placeholder = msg('watchlistAddPlaceholder');
  if (placeholder) {
    input.placeholder = placeholder;
    input.setAttribute('aria-label', placeholder);
  }
}

bindWatchlist();
bindFeeds();
render();

void (async () => {
  view.busy = true;
  render();
  try {
    const snap = await send({ type: 'popupOpened' });
    if (!applySnapshot(snap)) view.error = formatError(snap?.error);
  } catch (err) {
    view.error = formatError(err?.message || err);
  } finally {
    view.busy = false;
    render();
  }
})();
