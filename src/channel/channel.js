/**
 * Per-channel window: header plus the Videos tab list. The worker owns
 * all network; this page only renders.
 */

import { thumbUrl } from '../lib/yt.js';
import { relativeTime, compactCount, absoluteTime, duration } from '../lib/fmt.js';

const FALLBACK = {
  channelWindowTitle: 'Channel',
  channelLoadMore: 'Load more',
  channelEmpty: 'No videos',
  channelLastRefresh: 'Updated $TIME$',
  channelMissing: 'This channel is not in your watchlist',
  feedRefresh: 'Refresh',
  feedViews: '$COUNT$ views',
  feedOpenVideo: 'Open $TITLE$',
  watchlistError: 'Something went wrong: $ERROR$',
};

const view = {
  channelId: '',
  channel: null,
  settings: {},
  items: [],
  continuation: null,
  busy: false,
  error: '',
  lastRefreshAt: 0,
};

let refreshTimer = null;

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

// This page never talks to youtube.com. Every network action is a
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

function formatError(error) {
  const code = String(error || '');
  return msg('watchlistError', [code]);
}

function textEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = text;
  return el;
}

function applyStaticI18n() {
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const text = msg(el.dataset.i18n);
    if (text) el.textContent = text;
  }
}

function channelIdFromUrl() {
  try {
    return new URLSearchParams(location.search).get('cid') || '';
  } catch {
    return '';
  }
}

function syncTimer(minutes) {
  if (refreshTimer != null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  // The interval lives on this document so it dies when the window
  // closes. An alarm would keep firing after the user had gone.
  const n = Number(minutes);
  if (!n) return;
  refreshTimer = setInterval(() => {
    void loadVideos({ reset: true });
  }, n * 60 * 1000);
}

function openVideo(item) {
  const id = String(item.v || '');
  if (!id) return;
  try {
    void chrome.tabs.create({
      url: `https://www.youtube.com/watch?v=${id}`,
      active: true,
    });
  } catch {
    // Leave the window open if the tab could not be created.
  }
}

function videoRow(item, locale) {
  const row = document.createElement('div');
  row.className = 'feed-row';
  row.tabIndex = 0;
  const title = item.title || '';
  row.setAttribute('aria-label', msg('feedOpenVideo', [title]));
  row.addEventListener('click', () => openVideo(item));
  row.addEventListener('keydown', (event) => {
    if (event.target !== row) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openVideo(item);
  });

  const thumb = document.createElement('div');
  thumb.className = 'feed-row__thumb';
  const img = document.createElement('img');
  img.alt = title;
  img.src = thumbUrl(item.v, 'mq');
  thumb.appendChild(img);
  const dur = duration(item.d);
  if (dur) thumb.appendChild(textEl('span', 'feed-row__duration', dur));
  row.appendChild(thumb);

  const body = document.createElement('div');
  body.className = 'feed-row__body';
  body.appendChild(textEl('span', 'feed-row__title', title));

  const metaNodes = [];
  const views = Number(item.views);
  if (item.viewsText) {
    metaNodes.push(textEl('span', 'feed-row__views', item.viewsText));
  } else if (Number.isFinite(views) && views > 0) {
    const count = compactCount(views, locale);
    if (count) metaNodes.push(textEl('span', 'feed-row__views', msg('feedViews', [count])));
  }
  // Age here is YouTube's relative string ("6 days ago"), not a
  // timestamp. Passing it through relativeTime would invent a time.
  if (item.ageText) metaNodes.push(textEl('span', '', item.ageText));

  if (metaNodes.length) {
    const meta = document.createElement('div');
    meta.className = 'feed-row__meta';
    metaNodes.forEach((node) => meta.appendChild(node));
    body.appendChild(meta);
  }

  row.appendChild(body);
  return row;
}

function render() {
  const locale = activeLocale();
  const titleEl = document.getElementById('channel-title');
  const handleEl = document.getElementById('channel-handle');
  const avatar = document.getElementById('channel-avatar');
  const avatarPh = document.getElementById('channel-avatar-ph');
  const refreshBtn = document.getElementById('channel-refresh');
  const spinner = document.getElementById('channel-refresh-spinner');
  const lastEl = document.getElementById('channel-last-refresh');
  const errorEl = document.getElementById('channel-error');
  const listEl = document.getElementById('channel-list');
  const emptyEl = document.getElementById('channel-empty');
  const moreBtn = document.getElementById('channel-load-more');

  const ch = view.channel;
  const title = ch?.title || ch?.handle || ch?.id || view.channelId || msg('channelWindowTitle');
  document.title = title;
  titleEl.textContent = title;
  handleEl.textContent = ch?.handle || '';

  if (ch?.avatar) {
    avatar.src = ch.avatar;
    avatar.hidden = false;
    avatarPh.hidden = true;
  } else {
    avatar.removeAttribute('src');
    avatar.hidden = true;
    avatarPh.hidden = false;
  }

  const locked = view.busy;
  refreshBtn.disabled = locked;
  moreBtn.disabled = locked;
  spinner.hidden = !view.busy;
  document.body.setAttribute('aria-busy', view.busy ? 'true' : 'false');
  refreshBtn.setAttribute('aria-label', msg('feedRefresh'));
  refreshBtn.title = msg('feedRefresh');

  const lastAt = Number(view.lastRefreshAt) || 0;
  if (lastAt) {
    const rel = relativeTime(lastAt, Date.now(), locale);
    if (rel) {
      lastEl.hidden = false;
      lastEl.textContent = msg('channelLastRefresh', [rel]);
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

  if (view.error) {
    errorEl.hidden = false;
    errorEl.textContent = view.error;
  } else {
    errorEl.hidden = true;
    errorEl.textContent = '';
  }

  listEl.replaceChildren();
  for (const item of view.items) listEl.appendChild(videoRow(item, locale));

  const hasItems = view.items.length > 0;
  listEl.hidden = !hasItems;
  emptyEl.hidden = view.busy || !!view.error || hasItems;
  moreBtn.hidden = !view.continuation;
}

async function loadChannelMeta() {
  const snap = await send({ type: 'getState' });
  if (!snap || typeof snap !== 'object' || snap.ok === false) {
    return { ok: false, error: snap?.error };
  }
  if (snap.settings) view.settings = snap.settings;
  const channels = Array.isArray(snap.channels) ? snap.channels : [];
  view.channel = channels.find((c) => c.id === view.channelId) || null;
  syncTimer(view.settings?.channelWindow?.refreshMinutes);
  return { ok: true };
}

async function loadVideos({ reset }) {
  if (view.busy) return;
  if (!view.channelId) {
    view.error = msg('channelMissing');
    render();
    return;
  }
  view.busy = true;
  if (reset) view.error = '';
  render();
  try {
    if (reset) {
      const meta = await loadChannelMeta();
      if (meta.ok === false) {
        view.error = formatError(meta.error);
        return;
      }
    }
    if (!reset && !view.continuation) return;
    const message = { type: 'getChannelVideos', id: view.channelId };
    if (!reset && view.continuation) message.continuation = view.continuation;
    const res = await send(message);
    if (!res || res.ok === false || !Array.isArray(res.items)) {
      view.error = formatError(res?.error);
      return;
    }
    // The Videos tab endpoint never includes shorts — they live on a
    // different tab — so this list does not read settings.feed.showShorts.
    const incoming = res.items.filter((item) => item && item.v);
    if (reset) view.items = incoming;
    else view.items = view.items.concat(incoming);
    view.continuation = res.continuation || null;
    if (reset) view.lastRefreshAt = Date.now();
    view.error = '';
  } catch (err) {
    view.error = formatError(err?.message || err);
  } finally {
    view.busy = false;
    render();
  }
}

function bind() {
  document.getElementById('channel-refresh').addEventListener('click', () => {
    void loadVideos({ reset: true });
  });
  document.getElementById('channel-load-more').addEventListener('click', () => {
    void loadVideos({ reset: false });
  });
}

applyStaticI18n();
bind();
view.channelId = channelIdFromUrl();
render();
void loadVideos({ reset: true });
