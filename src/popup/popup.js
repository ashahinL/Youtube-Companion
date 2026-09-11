/**
 * Popup: three tabs. The Watchlist tab adds, searches, favourites and
 * removes channels. The worker owns all network; this page only renders.
 */

import { normalizeChannelInput } from '../lib/yt.js';
import { sortChannelsForDisplay } from '../lib/store.js';
import { relativeTime, compactCount, absoluteTime } from '../lib/fmt.js';

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

function render() {
  const locale = activeLocale();
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
