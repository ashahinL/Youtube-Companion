/**
 * Popup: four tabs plus the channel, groups, and support sheet overlays.
 * Player is first; the popup opens on it only when a YouTube tab is
 * playing or paused partway, or audio mode is on, otherwise on Feeds.
 * That choice is made once at open. Feeds is the merged timeline; its
 * box filters videos, and Add adds a channel the same way the Watchlist
 * box does. The Watchlist tab adds by URL or handle, filters the list
 * as you type, favourites and removes channels. Empty Add reads the
 * focused tab, and on a YouTube channel or video the Player tab offers
 * that channel with a Follow button. The worker owns all network; this
 * page only renders.
 */

import { thumbUrl } from '../lib/yt.js';
import { sortChannelsForDisplay, QUEUE_CAP } from '../lib/store.js';
import { relativeTime, compactCount, absoluteTime, duration } from '../lib/fmt.js';
import { buildBackup, backupSizeError, MAX_BACKUP_CHANNELS } from '../lib/backup.js';
import { migrateAudioCover } from '../lib/settings.js';
import {
  AUDIO_COVER_KEY,
  COVER_MAX_INPUT_BYTES,
  COVER_MAX_STORED_BYTES,
  COVER_JPEG_QUALITY,
  isCoverDataUrl,
  coverOutputSize,
  nextCoverJpegQuality,
} from '../lib/cover.js';
import {
  resolveLocale,
  loadMessages,
  translate,
  translateCount,
  applyTo,
  applyDirection,
} from '../lib/i18n.js';
import { applyTheme } from '../lib/theme.js';
import {
  isChannelRef,
  listedMatch,
  visibleFeedItems,
  feedItemUrl,
  rowOpenModes,
  fold,
  feedsView,
  groupNamesInList,
  channelInGroup,
  sanitizeChannelGroups,
  normalizeGroupName,
  chainSerial,
  watchlistView,
  audioTabView,
  audioStatsView,
  showRateNote,
  storeReviewsUrl,
  RATE_NOTE_KEY,
  channelProblem,
  followView,
  followActionState,
  backupImportMessage,
  ytErrorMessage,
  pageChannelsView,
  sleepMinutesLeft,
  menuNavIndex,
  shouldSyncAudioSeek,
  shouldSyncAudioSelect,
  audioVolumeSelectValue,
  openingTab,
  isNewSince,
  queueEntryFromItem,
  queueView,
  showWhatsNew,
  WHATS_NEW_VERSION,
} from '../lib/view.js';
import { SUPPORT_METHODS, supportRows } from '../lib/support.js';

const Core = globalThis.AudioModeCore;
const LAST_TAB_KEY = 'audioLastSelectedTabId';
const AUDIO_POLL_MS = 1000;
// Give the player probe a short window; after that, open on Feeds.
const OPENING_TAB_MS = 250;

let messages = {};
let locale = 'en';
let appliedLocale = null;

const view = {
  settings: {},
  channels: [],
  feed: [],
  pollState: {},
  error: '',
  ok: '',
  busy: false,
  adding: false,
  undoing: false,
  sweeping: false,
  feedNotice: '',
  backupNotice: null,
  importStage: 'idle',
  importBusy: false,
  pendingImportText: '',
  clearOpen: false,
  sheetId: null,
  sheetError: '',
  groupsSheetId: null,
  groupsError: '',
  // Name of the one group row showing the rename field or the delete
  // confirm. Only one row is ever in either state.
  groupEdit: '',
  groupConfirm: '',
  // fold(name) → desired on/off for ticks that have not landed yet.
  groupPending: {},
  // { id, title } of the last removed channel while Undo is on offer.
  undo: null,
  supportOpen: false,
  feedError: '',
  feedOk: '',
  followError: '',
  followOk: '',
  followErrors: {},
  // The focused tab when it is a YouTube page, and what its content script
  // read about the page's channels, for the Follow card.
  activeTab: null,
  activePage: null,
  // Follow card inputs whose add is in flight. Several collab rows can wait
  // at once; only that row's button is disabled.
  followPending: [],
  audioKnown: false,
  audioReachable: false,
  audioOn: false,
  audioShortcut: '',
  popupShortcut: '',
  audioTargetId: null,
  audioTabs: [],
  audioPlayer: null,
  audioStats: { listened: {}, active: {}, totals: { listened: 0, active: 0 } },
  audioStatsScope: 'month',
  audioCover: '',
  rateNoteDone: false,
  coverError: '',
  // Previous pollState.lastSeenAt, held for this open so feed dots
  // do not vanish while the user is looking at them.
  feedSeenAt: 0,
  queue: [],
  queueOpen: false,
  queueClearOpen: false,
  queueNotice: '',
  whatsNewSeen: '',
};

let audioPollTimer = null;
let audioDiscoverTimer = null;
let audioSeeking = false;
let audioSpeedPending = false;
let audioVolumePending = false;
let audioSleepPending = false;
// The feed is drawn a page at a time; the same list keeps its length across
// redraws, and a new query or filter starts again at one page.
const FEED_PAGE = 50;
let feedLimit = FEED_PAGE;
let feedPageKey = '';
// The Watchlist pages the same way: a list of 2,000 channels drew every row,
// each with its ⋯ menu, on every key typed in its box.
let watchlistLimit = FEED_PAGE;
let watchlistPageKey = '';
let feedGroupsScrolledTo;
let groupWrite = Promise.resolve();
// Unsent rename text, kept across re-renders so a checkbox tick landing
// mid-typing does not wipe the field.
let groupRenameDraft = { name: '', value: '' };
let audioPickerKey = '';
let queueListSig = '';
let supportOpenerId = null;
const supportCopiedTimers = new WeakMap();

const tabs = [...document.querySelectorAll('[role="tab"]')];
const panels = [...document.querySelectorAll('[role="tabpanel"]')];
let openingChosen = false;

function revealOpen() {
  document.body.classList.remove('is-opening');
  document.querySelector('.tabs')?.setAttribute('aria-busy', 'false');
}

function activate(tab) {
  openingChosen = true;
  revealOpen();
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
  // Hidden tabs are not kept drawn, so the one that opens is drawn now.
  render();
  syncAudioPolling();
}

function openTabName() {
  return panels.find((panel) => !panel.hidden)?.id || '';
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

function tCount(key, count, substitutions) {
  const n = Number(count);
  const subs = substitutions == null ? [String(count)] : substitutions;
  return translateCount(messages, key, n, subs);
}

async function applyI18n(setting) {
  const next = resolveLocale(setting, navigator.language);
  messages = await loadMessages(next);
  locale = next;
  if (appliedLocale === next) return;
  applyDirection(document, next);
  applyTo(document, messages);
  fillSupportMethods();
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
  if (Array.isArray(snap.queue)) view.queue = snap.queue;
  if (typeof snap.queueOpen === 'boolean') view.queueOpen = snap.queueOpen;
  if (typeof snap.whatsNewSeen === 'string') view.whatsNewSeen = snap.whatsNewSeen;
  if (snap.pollState) view.pollState = snap.pollState;
  return true;
}

async function refreshState() {
  const snap = await send({ type: 'getState' });
  if (!applySnapshot(snap)) {
    view.error = formatError(snap?.error);
  }
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
  const yt = ytErrorMessage(code);
  if (yt) return t(yt.key, yt.subs);
  return t('watchlistError', [code]);
}

function formatBackupNotice(error) {
  const mapped = backupImportMessage(error, MAX_BACKUP_CHANNELS);
  if (mapped.key) return t(mapped.key, mapped.subs);
  return formatError(error);
}

function ltrRun(el) {
  // @handles and timestamps like 17:14 are LTR; without isolation they
  // scramble inside Arabic text.
  el.dir = 'ltr';
  return el;
}

function avatarEl(url) {
  if (url) {
    const img = document.createElement('img');
    img.className = 'avatar';
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
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
  view.supportOpen = false;
  view.groupsSheetId = null;
  view.groupsError = '';
  view.sheetId = id;
  view.sheetError = '';
  render();
  document.getElementById('channel-sheet-close')?.focus?.();
}

function openGroupsSheet(id) {
  if (!id) return;
  view.supportOpen = false;
  view.sheetId = null;
  view.sheetError = '';
  view.groupsSheetId = id;
  view.groupsError = '';
  view.groupEdit = '';
  view.groupConfirm = '';
  groupRenameDraft = { name: '', value: '' };
  render();
  const names = groupNamesInList(view.channels, locale);
  if (!names.length) document.getElementById('groups-sheet-input')?.focus?.();
  else document.getElementById('groups-sheet-close')?.focus?.();
}

function closeGroupsSheet() {
  if (!view.groupsSheetId) return;
  const returnId = view.groupsSheetId;
  view.groupsSheetId = null;
  view.groupsError = '';
  view.groupEdit = '';
  view.groupConfirm = '';
  groupRenameDraft = { name: '', value: '' };
  const input = document.getElementById('groups-sheet-input');
  if (input) input.value = '';
  render();
  focusGroupsOpener(returnId);
}

function focusGroupsOpener(channelId) {
  if (channelId) {
    const btn = document.getElementById(`channel-menu-btn-${channelId}`);
    if (btn && !btn.closest('[hidden]')) {
      btn.focus();
      return;
    }
  }
  focusSheetOpener(channelId);
}

function openSupportSheet(opener) {
  view.sheetId = null;
  view.sheetError = '';
  view.groupsSheetId = null;
  view.groupsError = '';
  view.supportOpen = true;
  supportOpenerId = opener && opener.id ? opener.id : null;
  render();
  document.getElementById('support-sheet-close')?.focus?.();
}

function closeSupportSheet() {
  if (!view.supportOpen) return;
  view.supportOpen = false;
  render();
  focusSupportOpener();
}

function focusSupportOpener() {
  if (supportOpenerId) {
    const el = document.getElementById(supportOpenerId);
    if (el && !el.closest('[hidden]')) {
      el.focus();
      return;
    }
  }
  tabs.find((el) => el.getAttribute('aria-selected') === 'true')?.focus?.();
}

function closeChannelSheet() {
  if (!view.sheetId) return;
  // render() throws the opener button away, so hand its channel id on and
  // find the replacement afterwards.
  const returnId = view.sheetId;
  view.sheetId = null;
  view.sheetError = '';
  render();
  focusSheetOpener(returnId);
}

function focusSheetOpener(channelId) {
  if (channelId) {
    const openers = document.querySelectorAll('.channel-row__main, .feed-row__channel');
    for (const el of openers) {
      if (el.dataset.channelId !== channelId) continue;
      if (el.closest('[hidden]')) continue;
      el.focus();
      return;
    }
  }
  tabs.find((el) => el.getAttribute('aria-selected') === 'true')?.focus?.();
}

function openSheetEl() {
  // Only one sheet is shown at a time; Tab must cycle that panel, not both.
  if (view.supportOpen) return document.getElementById('support-sheet');
  if (view.groupsSheetId) return document.getElementById('groups-sheet');
  if (view.sheetId) return document.getElementById('channel-sheet');
  return null;
}

function sheetFocusables() {
  const panel = openSheetEl()?.querySelector('.sheet__panel');
  if (!panel) return [];
  // render() rebuilds the video list, so a cached node list would point
  // at elements that are no longer in the document.
  return [...panel.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((el) => !el.closest('[hidden]'));
}

function trapSheetTab(event) {
  if (event.key !== 'Tab' || !openSheetEl()) return;
  const items = sheetFocusables();
  if (!items.length) {
    event.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  const inCycle = items.includes(active);
  if (event.shiftKey) {
    if (!inCycle || active === first) {
      event.preventDefault();
      last.focus();
    }
  } else if (!inCycle || active === last) {
    event.preventDefault();
    first.focus();
  }
}

function channelRow(ch, locale) {
  const row = document.createElement('div');
  row.className = 'channel-row';

  const title = ch.title || ch.handle || ch.id;
  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'channel-row__main';
  main.dataset.channelId = ch.id;
  main.setAttribute('aria-label', t('watchlistOpenChannel', [title]));
  main.addEventListener('click', () => openChannelSheet(ch.id));
  main.appendChild(avatarEl(ch.avatar));

  const text = document.createElement('div');
  text.className = 'channel-row__text';

  const name = document.createElement('div');
  name.className = 'channel-row__name';
  name.appendChild(textEl('span', 'channel-row__title', title));
  if (ch.favorite) {
    const star = textEl('span', 'channel-row__fav', '\u2605');
    // Sorting already floats favourites, but order alone does not say why a
    // row is where it is, and a filtered list has no order to read.
    star.setAttribute('role', 'img');
    star.setAttribute('aria-label', t('watchlistFavorite'));
    star.title = t('watchlistFavorite');
    name.appendChild(star);
  }
  text.appendChild(name);

  const groupLabels = sanitizeChannelGroups(ch.groups)
    .slice()
    .sort((a, b) => a.localeCompare(b, locale, { sensitivity: 'base' }));
  if (groupLabels.length) {
    text.appendChild(textEl('div', 'channel-row__groups', groupLabels.join(', ')));
  }

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

  if (ch.muted) meta.appendChild(textEl('span', '', t('watchlistMuted')));

  // The row is the button that opens the sheet, which says why and offers
  // Retry; a second button cannot sit inside this one.
  if (channelProblem(ch.lastError)) {
    meta.appendChild(textEl('span', 'channel-row__warn', t('channelProblemShort')));
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

function menuItems(list) {
  return [...list.querySelectorAll('[role="menuitem"]')];
}

function closeAllMenus(opts) {
  let restore = null;
  for (const toggle of document.querySelectorAll('.menu__toggle')) {
    if (toggle.getAttribute('aria-expanded') === 'true') restore = toggle;
    toggle.setAttribute('aria-expanded', 'false');
  }
  let closed = false;
  for (const list of document.querySelectorAll('.menu__list')) {
    if (!list.hidden) closed = true;
    list.hidden = true;
    list.classList.remove('menu__list--above');
  }
  if (opts && opts.restoreFocus && restore) restore.focus();
  return closed;
}

function onChannelMenuKeydown(event, toggle, list) {
  if (event.key === 'Tab') {
    closeAllMenus();
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeAllMenus({ restoreFocus: true });
    return;
  }
  if (
    event.key !== 'ArrowDown'
    && event.key !== 'ArrowUp'
    && event.key !== 'Home'
    && event.key !== 'End'
  ) {
    return;
  }
  event.preventDefault();
  const items = menuItems(list);
  const i = items.indexOf(event.target);
  const next = menuNavIndex(event.key, i < 0 ? 0 : i, items.length);
  items[next]?.focus();
}

function channelMenu(ch) {
  const menu = document.createElement('div');
  menu.className = 'menu';

  const list = document.createElement('div');
  list.className = 'menu__list';
  list.hidden = true;
  list.id = `channel-menu-${ch.id}`;
  list.setAttribute('role', 'menu');

  const toggle = buttonEl('icon-btn menu__toggle', '⋯', (event) => {
    event.stopPropagation?.();
    const willOpen = list.hidden;
    closeAllMenus();
    if (willOpen) {
      list.classList.remove('menu__list--above');
      list.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      // The popup itself is the scrollport; an absolute list that
      // overflows it has nothing to scroll it into view.
      const rect = list.getBoundingClientRect();
      if (rect.bottom > window.innerHeight) {
        list.classList.add('menu__list--above');
      }
      menuItems(list)[0]?.focus();
    }
  });
  toggle.id = `channel-menu-btn-${ch.id}`;
  toggle.title = t('watchlistActions');
  toggle.setAttribute('aria-label', t('watchlistActions'));
  toggle.setAttribute('aria-haspopup', 'menu');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', list.id);
  toggle.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown') return;
    event.preventDefault();
    if (list.hidden) toggle.click();
    else menuItems(list)[0]?.focus();
  });
  list.setAttribute('aria-labelledby', toggle.id);
  list.addEventListener('keydown', (event) => onChannelMenuKeydown(event, toggle, list));

  const fav = buttonEl(
    'menu__item',
    t(ch.favorite ? 'watchlistFavoriteRemove' : 'watchlistFavoriteAdd'),
    () => {
      closeAllMenus();
      void toggleFavorite(ch.id, !ch.favorite);
    },
  );
  const mute = buttonEl(
    'menu__item',
    t(ch.muted ? 'watchlistMuteRemove' : 'watchlistMuteAdd'),
    () => {
      closeAllMenus();
      void toggleMuted(ch.id, !ch.muted);
    },
  );
  const groups = buttonEl('menu__item', t('watchlistGroups'), () => {
    closeAllMenus();
    openGroupsSheet(ch.id);
  });
  const remove = buttonEl('menu__item menu__item--danger', t('watchlistRemove'), () => {
    closeAllMenus();
    void removeChannel(ch.id);
  });
  for (const item of [fav, mute, groups, remove]) {
    item.setAttribute('role', 'menuitem');
    item.tabIndex = -1;
  }

  list.append(fav, mute, groups, remove);
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
  openUrl(feedItemUrl(item));
}

function openVideoInAudioMode(item) {
  const v = item && item.v;
  if (!v) return;
  try {
    const opening = send({ type: 'openInAudioMode', v });
    Promise.resolve(opening).then((res) => {
      if (res && res.ok === true) window.close();
    }, () => {});
  } catch {
    // Leave the popup open if the worker could not open the tab.
  }
}

function openFeedItem(item, mode) {
  if (mode === 'audio') openVideoInAudioMode(item);
  else openVideo(item);
}

function headphonesIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 48 48');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const band = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  band.setAttribute('fill', 'none');
  band.setAttribute('stroke', 'currentColor');
  band.setAttribute('stroke-width', '3');
  band.setAttribute('stroke-linecap', 'round');
  band.setAttribute('d', 'M8 24a16 16 0 0 1 32 0');
  const left = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  left.setAttribute('fill', 'currentColor');
  left.setAttribute('d', 'M8 24v8.5A4.5 4.5 0 0 0 12.5 37h2A3.5 3.5 0 0 0 18 33.5V27a3 3 0 0 0-3-3H8z');
  const right = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  right.setAttribute('fill', 'currentColor');
  right.setAttribute('d', 'M40 24v8.5A4.5 4.5 0 0 1 35.5 37h-2A3.5 3.5 0 0 1 30 33.5V27a3 3 0 0 1 3-3h7z');
  svg.append(band, left, right);
  return svg;
}

function queueIcon(queued) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 48 48');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const stroke = (d, join) => {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '3');
    p.setAttribute('stroke-linecap', 'round');
    if (join) p.setAttribute('stroke-linejoin', 'round');
    p.setAttribute('d', d);
    return p;
  };
  svg.append(stroke('M6 12h24'), stroke('M6 24h24'), stroke('M6 36h16'));
  if (queued) svg.append(stroke('M30 22l5 5 9-12', true));
  else svg.append(stroke('M38 18v16'), stroke('M30 26h16'));
  return svg;
}

function videoIsQueued(v) {
  return !!v && (view.queue || []).some((row) => row && row.v === v);
}

function feedRow(item, locale, channel, { showChannel = true } = {}) {
  const modes = rowOpenModes(view.settings);
  const row = document.createElement('div');
  row.className = 'feed-row';
  const title = item.t || '';
  const isNew = isNewSince(item, view.feedSeenAt);
  const openLabel = t(modes.row === 'audio' ? 'feedOpenVideoAudio' : 'feedOpenVideo', [title]);

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'feed-row__open';
  openBtn.setAttribute(
    'aria-label',
    isNew ? `${t('feedItemNew')}. ${openLabel}` : openLabel,
  );
  openBtn.addEventListener('click', () => openFeedItem(item, modes.row));
  row.appendChild(openBtn);

  // Pin the thumbnail box so a slow image cannot reflow the list.
  const thumb = document.createElement('div');
  thumb.className = 'feed-row__thumb';
  const img = document.createElement('img');
  img.alt = title;
  // A 500-row feed would otherwise ask YouTube for every thumbnail on open.
  img.loading = 'lazy';
  img.decoding = 'async';
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
  const channelName = channel?.title || channel?.handle || item.ct || '';
  if (showChannel && channelName) {
    if (channel) {
      const chBtn = document.createElement('button');
      chBtn.type = 'button';
      chBtn.className = 'feed-row__channel';
      chBtn.dataset.channelId = channel.id;
      chBtn.textContent = channelName;
      chBtn.setAttribute('aria-label', t('watchlistOpenChannel', [channelName]));
      chBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openChannelSheet(channel.id);
      });
      metaNodes.push(chBtn);
    } else {
      metaNodes.push(textEl('span', '', channelName));
    }
  }

  // Age and views travel together in one box. They are short and fixed, so
  // the only line break the meta can take falls between the name and them —
  // and their own separator never ends up at the head of a line.
  const facts = document.createElement('span');
  facts.className = 'feed-row__facts';

  const at = Number(item.at) || 0;
  if (at) {
    const age = textEl('span', '', relativeTime(at, Date.now(), locale));
    const abs = absoluteTime(at, locale);
    if (abs) age.title = abs;
    facts.appendChild(age);
  }

  const views = Number(item.vw);
  if (Number.isFinite(views) && views > 0) {
    const count = compactCount(views, locale);
    if (count) facts.appendChild(textEl('span', 'feed-row__views', tCount('feedViews', views, [count])));
  }

  if (facts.childNodes.length) metaNodes.push(facts);

  if (metaNodes.length) {
    const meta = document.createElement('div');
    meta.className = 'feed-row__meta';
    metaNodes.forEach((node) => meta.appendChild(node));
    body.appendChild(meta);
  }

  row.appendChild(body);

  // The New marker goes above the buttons, in the space their centring
  // leaves free. In front of the title it pushed the whole title across, so
  // rows that arrived since the last visit did not line up with the rest.
  const actions = document.createElement('div');
  actions.className = 'feed-row__actions';
  if (isNew) actions.appendChild(textEl('span', 'feed-tag feed-tag--new', t('feedItemNew')));
  const buttons = document.createElement('div');
  buttons.className = 'feed-row__buttons';
  actions.appendChild(buttons);

  if (item.k !== 'live' && item.k !== 'premiere') {
    const queued = videoIsQueued(item.v);
    const qBtn = document.createElement('button');
    qBtn.type = 'button';
    qBtn.className = 'icon-btn feed-row__queue';
    const qLabel = t(queued ? 'queueRemove' : 'queueAdd');
    qBtn.setAttribute('aria-label', qLabel);
    qBtn.title = qLabel;
    qBtn.setAttribute('aria-pressed', queued ? 'true' : 'false');
    qBtn.appendChild(queueIcon(queued));
    qBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      void toggleQueued(item);
    });
    buttons.appendChild(qBtn);
  }

  const alt = document.createElement('button');
  alt.type = 'button';
  alt.className = 'icon-btn feed-row__open-alt';
  alt.setAttribute(
    'aria-label',
    t(modes.button === 'audio' ? 'feedOpenVideoAudio' : 'feedOpenVideoNormal', [title]),
  );
  alt.title = t(modes.button === 'audio' ? 'feedOpenAudioShort' : 'feedOpenNormalShort');
  if (modes.button === 'audio') alt.appendChild(headphonesIcon());
  else alt.textContent = '▶';
  alt.addEventListener('click', (event) => {
    event.stopPropagation();
    openFeedItem(item, modes.button);
  });
  buttons.appendChild(alt);

  row.appendChild(actions);
  return row;
}

/** '' unless checks are paused because YouTube pushed back. */
function slowDownText() {
  const until = Number(view.pollState?.backoffUntil) || 0;
  const now = Date.now();
  if (until <= now) return '';
  // Under a minute left reads "just now" otherwise, which is a past tense.
  const when = relativeTime(Math.max(until, now + 60_000), now, locale);
  return t('feedSlowDown', [when]);
}

function renderFeedGroups(locale, selected) {
  const row = document.getElementById('feed-groups');
  if (!row) return;
  const names = groupNamesInList(view.channels, locale);
  if (!names.length) {
    row.hidden = true;
    row.replaceChildren();
    feedGroupsScrolledTo = undefined;
    return;
  }
  row.hidden = false;
  const hadFocus = row.contains(document.activeElement);
  row.replaceChildren();
  const chips = [{ name: '', label: t('feedGroupAll') }, ...names.map((name) => ({ name, label: name }))];
  for (const chip of chips) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'feed-groups__chip';
    btn.textContent = chip.label;
    btn.dataset.group = chip.name;
    const on = chip.name === selected || (chip.name === '' && !selected);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    row.appendChild(btn);
  }
  const pressed = row.querySelector('[aria-pressed="true"]');
  if (selected !== feedGroupsScrolledTo) {
    pressed?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    feedGroupsScrolledTo = selected;
  }
  if (hadFocus) pressed?.focus();
}

function renderFeeds(locale) {
  const form = document.getElementById('feed-add-form');
  const filterEl = document.getElementById('feed-filter');
  const addBtn = document.getElementById('feed-add-btn');
  const clearBtn = document.getElementById('feed-clear');
  const countEl = document.getElementById('feed-count');
  const errorEl = document.getElementById('feed-error');
  const okEl = document.getElementById('feed-ok');
  const refreshBtn = document.getElementById('feed-refresh');
  const addSpinner = document.getElementById('feed-add-spinner');
  const spinner = document.getElementById('feed-refresh-spinner');
  const statusEl = document.getElementById('feed-status');
  const lastEl = document.getElementById('feed-last-poll');
  const noticeEl = document.getElementById('feed-notice');
  const listEl = document.getElementById('feed-list');
  const emptyNone = document.getElementById('feed-empty-no-channels');
  const emptyWait = document.getElementById('feed-empty-no-items');
  const emptyFilter = document.getElementById('feed-empty-filter');
  const emptyFav = document.getElementById('feed-empty-favorites');
  const emptyGroup = document.getElementById('feed-empty-group');
  const missEl = document.getElementById('feed-filter-miss');
  const emptyRefresh = document.getElementById('feed-waiting-refresh');
  const favBox = document.getElementById('feed-favorites-only');

  const sweeping = view.sweeping || !!view.pollState?.running;
  const locked = view.busy || sweeping;
  refreshBtn.disabled = locked;
  refreshBtn.hidden = sweeping;
  if (emptyRefresh) emptyRefresh.disabled = locked;
  if (addSpinner) addSpinner.hidden = !view.adding;
  spinner.hidden = !sweeping;
  form.classList.toggle('is-busy', view.adding);
  form.setAttribute('aria-busy', view.adding ? 'true' : 'false');
  statusEl.classList.toggle('is-busy', sweeping);
  statusEl.setAttribute('aria-busy', sweeping ? 'true' : 'false');
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

  const slowText = slowDownText();
  if (view.feedNotice) {
    noticeEl.hidden = false;
    noticeEl.textContent = view.feedNotice;
    noticeEl.classList.toggle('banner--error', view.feedNotice !== t('feedSweepRunning'));
  } else if (view.queueNotice) {
    noticeEl.hidden = false;
    noticeEl.textContent = view.queueNotice;
    noticeEl.classList.add('banner--error');
  } else if (slowText) {
    noticeEl.hidden = false;
    noticeEl.textContent = slowText;
    noticeEl.classList.remove('banner--error');
  } else {
    noticeEl.hidden = true;
    noticeEl.textContent = '';
    noticeEl.classList.remove('banner--error');
  }

  if (view.feedError) {
    errorEl.hidden = false;
    errorEl.textContent = view.feedError;
  } else {
    errorEl.hidden = true;
    errorEl.textContent = '';
  }

  if (view.feedOk) {
    okEl.hidden = false;
    okEl.textContent = view.feedOk;
  } else {
    okEl.hidden = true;
    okEl.textContent = '';
  }

  const channelsById = new Map(view.channels.map((ch) => [ch.id, ch]));
  // The feed has no read state: opening a video never hides it, and
  // nothing is marked. Newest first. Favourites-only is a view filter
  // on this tab only — the channel sheet still lists that channel.
  const feeds = feedsView({
    feed: view.feed,
    channels: view.channels,
    settings: view.settings,
    query: filterEl.value,
  });
  const favOnly = feeds.favOnly;
  if (favBox) favBox.checked = favOnly;
  const q = feeds.query;
  const { shown, onList, addable } = feeds;
  renderFeedGroups(locale, feeds.group);

  addBtn.disabled = view.adding || view.busy || !addable;
  addBtn.textContent = onList ? t('watchlistOnList') : t('watchlistAdd');
  addBtn.title = onList
    ? t('watchlistOnList')
    : (q ? t('feedFilterPlaceholder') : t('watchlistAddFromTab'));
  if (clearBtn) clearBtn.hidden = !q;

  const pageKey = JSON.stringify([q, favOnly, feeds.group, !!view.settings?.feed?.showShorts]);
  if (pageKey !== feedPageKey) {
    feedPageKey = pageKey;
    feedLimit = FEED_PAGE;
  }
  listEl.replaceChildren(...shown.slice(0, feedLimit).map((item) => feedRow(item, locale, channelsById.get(item.c))));
  const moreEl = document.getElementById('feed-more');
  const rest = shown.length - feedLimit;
  moreEl.hidden = rest <= 0;
  moreEl.textContent = rest > 0 ? t('feedShowMore', [String(Math.min(FEED_PAGE, rest))]) : '';

  const searching = feeds.searching;
  countEl.hidden = !searching;
  countEl.textContent = searching
    ? t('watchlistShowing', [String(shown.length), String(feeds.total)])
    : '';

  emptyNone.hidden = !feeds.showEmptyNone;
  emptyWait.hidden = !feeds.showEmptyWait;
  emptyFav.hidden = !feeds.showEmptyFav;
  if (emptyGroup) emptyGroup.hidden = !feeds.showEmptyGroup;
  emptyFilter.hidden = !feeds.showEmptyFilter;
  listEl.hidden = shown.length === 0;

  if (!emptyFilter.hidden && missEl) {
    missEl.textContent = addable
      ? t('feedNoMatchAdd', [q])
      : t('emptyFeedFilter', [q]);
  }
}

function showMoreFeed() {
  feedLimit += FEED_PAGE;
  renderFeeds(locale);
}

function showMoreWatchlist() {
  watchlistLimit += FEED_PAGE;
  renderWatchlist(locale);
}

function renderWatchlist(locale) {
  const form = document.getElementById('watchlist-add-form');
  const input = document.getElementById('watchlist-input');
  const addBtn = document.getElementById('watchlist-add-btn');
  const clearBtn = document.getElementById('watchlist-clear');
  const spinner = document.getElementById('watchlist-spinner');
  const errorEl = document.getElementById('watchlist-error');
  const okEl = document.getElementById('watchlist-ok');
  const countEl = document.getElementById('watchlist-count');
  const listEl = document.getElementById('watchlist-list');
  const emptyEl = document.getElementById('watchlist-empty');
  const missEl = document.getElementById('watchlist-nomatch');

  const channels = sortChannelsForDisplay(view.channels, view.feed);
  const watchlist = watchlistView({
    channels,
    feed: view.feed,
    query: input.value,
  });
  const q = watchlist.query;
  const { shown, onList, addable } = watchlist;

  form.classList.toggle('is-busy', view.adding);
  form.setAttribute('aria-busy', view.adding ? 'true' : 'false');
  addBtn.disabled = view.adding || view.busy || !addable;
  addBtn.textContent = onList ? t('watchlistOnList') : t('watchlistAdd');
  addBtn.title = onList
    ? t('watchlistOnList')
    : (q ? t('watchlistAddPlaceholder') : t('watchlistAddFromTab'));
  spinner.hidden = !view.adding;
  if (clearBtn) clearBtn.hidden = !q;

  if (view.error) {
    errorEl.hidden = false;
    errorEl.textContent = view.error;
  } else {
    errorEl.hidden = true;
    errorEl.textContent = '';
  }

  if (view.ok) {
    okEl.hidden = false;
    okEl.textContent = view.ok;
  } else {
    okEl.hidden = true;
    okEl.textContent = '';
  }

  const undoRow = document.getElementById('watchlist-undo');
  const undoText = document.getElementById('watchlist-undo-text');
  const undoBtn = document.getElementById('watchlist-undo-btn');
  undoRow.hidden = !view.undo;
  undoText.textContent = view.undo ? t('watchlistRemoved', [isolate(view.undo.title)]) : '';
  undoBtn.disabled = view.undoing;

  const searching = !!q;
  countEl.hidden = !searching;
  countEl.textContent = searching
    ? t('watchlistShowing', [String(shown.length), String(channels.length)])
    : '';

  if (q !== watchlistPageKey) {
    watchlistPageKey = q;
    watchlistLimit = FEED_PAGE;
  }
  listEl.replaceChildren(...shown.slice(0, watchlistLimit).map((ch) => channelRow(ch, locale)));
  const moreEl = document.getElementById('watchlist-more');
  const rest = shown.length - watchlistLimit;
  moreEl.hidden = rest <= 0;
  moreEl.textContent = rest > 0 ? t('feedShowMore', [String(Math.min(FEED_PAGE, rest))]) : '';
  emptyEl.hidden = watchlist.total > 0 || searching;
  const noMatch = watchlist.noMatch && !view.error;
  missEl.hidden = !noMatch;
  if (noMatch) {
    missEl.textContent = addable
      ? t('watchlistNoMatchAdd', [q])
      : t('watchlistNoMatch', [q]);
  }
}

/*
 * Only the open tab is drawn, and a tab is drawn again when it opens. Drawing
 * all four rebuilt a 500-row feed on every key typed in the Watchlist box.
 */
function render() {
  const open = openTabName();
  renderWhatsNew();
  if (open === 'feeds') renderFeeds(locale);
  if (open === 'watchlist') renderWatchlist(locale);
  if (open === 'audio') renderAudio();
  if (open === 'settings') renderSettings(locale);
  renderChannelSheet();
  renderGroupsSheet();
  renderSupportSheet();
}

const WHATS_NEW_PAGE = 'src/whatsnew/whatsnew.html';

function renderWhatsNew() {
  const note = document.getElementById('whats-new');
  if (note) {
    note.hidden = !showWhatsNew(view.whatsNewSeen, WHATS_NEW_VERSION);
    const open = document.getElementById('whats-new-open');
    if (open) open.textContent = t('whatsNewNote', [WHATS_NEW_VERSION]);
  }
  const link = document.getElementById('settings-whats-new');
  if (link) link.textContent = t('whatsNewOpen', [WHATS_NEW_VERSION]);
}

/** Acknowledges the release so neither the note nor a redraw brings it back. */
async function markWhatsNewSeen() {
  view.whatsNewSeen = WHATS_NEW_VERSION;
  renderWhatsNew();
  try {
    await send({ type: 'whatsNew.seen' });
  } catch {
    // The next open reads the stored value and offers it again.
  }
}

function openWhatsNew() {
  void markWhatsNewSeen();
  openUrl(chrome.runtime.getURL(WHATS_NEW_PAGE));
}

function renderChannelSheet() {
  const sheet = document.getElementById('channel-sheet');
  if (!sheet) return;

  const id = view.sheetId;
  const ch = id ? view.channels.find((c) => c.id === id) : null;
  if (!id || !ch) {
    const wasShown = !sheet.hidden;
    view.sheetId = null;
    sheet.hidden = true;
    // The channel went away while its sheet was open, so closeChannelSheet
    // never ran and focus is sitting inside a panel that just vanished.
    if (wasShown && id) focusSheetOpener(id);
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

  const locked = view.sweeping || !!view.pollState?.running;
  refreshBtn.disabled = locked;
  refreshBtn.hidden = locked;
  spinner.hidden = !locked;
  refreshBtn.setAttribute('aria-label', t('feedRefresh'));
  refreshBtn.title = t('feedRefresh');
  sheet.setAttribute('aria-busy', locked ? 'true' : 'false');

  const slowText = slowDownText();
  if (view.sheetError) {
    statusEl.hidden = false;
    statusEl.textContent = view.sheetError;
    statusEl.classList.add('banner--error');
  } else if (view.queueNotice) {
    statusEl.hidden = false;
    statusEl.textContent = view.queueNotice;
    statusEl.classList.add('banner--error');
  } else if (slowText) {
    statusEl.hidden = false;
    statusEl.textContent = slowText;
    statusEl.classList.remove('banner--error');
  } else {
    statusEl.hidden = true;
    statusEl.textContent = '';
    statusEl.classList.remove('banner--error');
  }

  const problemRow = document.getElementById('channel-sheet-problem');
  const problemText = document.getElementById('channel-sheet-problem-text');
  const retryBtn = document.getElementById('channel-sheet-retry');
  // While the check runs, the spinner is the answer; the old sentence would
  // read as the result of the retry.
  const problem = locked ? null : channelProblem(ch.lastError);
  problemRow.hidden = !problem;
  problemText.textContent = problem ? t(problem.key, problem.subs) : '';
  retryBtn.disabled = locked || !!slowText;

  const items = visibleFeedItems(view.feed, !!view.settings?.feed?.showShorts)
    .filter((item) => item.c === ch.id);
  listEl.replaceChildren();
  for (const item of items) {
    listEl.appendChild(feedRow(item, locale, ch, { showChannel: false }));
  }

  const hasItems = items.length > 0;
  listEl.hidden = !hasItems;
  emptyEl.hidden = locked || hasItems;

  const itemsNow = sheetFocusables();
  if (!itemsNow.includes(document.activeElement)) {
    // The focused video row was rebuilt, or ↻ was hidden under focus.
    document.getElementById('channel-sheet-close')?.focus?.();
  }
}

function renderGroupsSheet() {
  const sheet = document.getElementById('groups-sheet');
  if (!sheet) return;

  const id = view.groupsSheetId;
  const ch = id ? view.channels.find((c) => c.id === id) : null;
  if (!id || !ch) {
    const wasShown = !sheet.hidden;
    view.groupsSheetId = null;
    view.groupEdit = '';
    view.groupConfirm = '';
    groupRenameDraft = { name: '', value: '' };
    sheet.hidden = true;
    if (wasShown && id) focusGroupsOpener(id);
    return;
  }

  sheet.hidden = false;

  const channelEl = document.getElementById('groups-sheet-channel');
  if (channelEl) channelEl.textContent = ch.title || ch.handle || ch.id;

  const names = groupNamesInList(view.channels, locale);
  const mine = new Set(sanitizeChannelGroups(ch.groups).map((name) => fold(name)));
  const pending = view.groupPending || {};
  const listEl = document.getElementById('groups-sheet-list');
  const emptyEl = document.getElementById('groups-sheet-empty');
  if (emptyEl) emptyEl.hidden = names.length > 0;
  if (listEl) listEl.hidden = names.length === 0;
  if (!names.includes(view.groupEdit)) {
    view.groupEdit = '';
    groupRenameDraft = { name: '', value: '' };
  }
  if (!names.includes(view.groupConfirm)) view.groupConfirm = '';
  // The rename field is rebuilt on every render; hold on to unsent text so
  // a tick landing mid-typing does not wipe it.
  const liveDraft = listEl.querySelector('.groups-row--edit input');
  if (liveDraft && view.groupEdit) {
    groupRenameDraft = { name: view.groupEdit, value: liveDraft.value };
  }
  const prevName = document.activeElement?.dataset?.groupName;
  listEl.replaceChildren();
  for (const name of names) {
    if (view.groupEdit === name) {
      listEl.appendChild(groupRenameRow(name));
      continue;
    }
    if (view.groupConfirm === name) {
      listEl.appendChild(groupDeleteRow(name));
      continue;
    }
    const row = document.createElement('div');
    row.className = 'groups-row';
    const label = document.createElement('label');
    label.className = 'row';
    const box = document.createElement('input');
    box.type = 'checkbox';
    const key = fold(name);
    const waiting = Object.prototype.hasOwnProperty.call(pending, key);
    box.checked = waiting ? !!pending[key] : mine.has(key);
    box.dataset.groupName = name;
    if (waiting) box.setAttribute('aria-busy', 'true');
    box.addEventListener('change', () => {
      void applyGroup(ch.id, name, box.checked);
    });
    label.appendChild(box);
    label.appendChild(textEl('span', '', name));
    row.appendChild(label);
    const actions = document.createElement('span');
    actions.className = 'groups-row__actions';
    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'icon-btn groups-row__btn';
    renameBtn.dataset.groupName = name;
    renameBtn.setAttribute('aria-label', t('groupsRename', [name]));
    renameBtn.appendChild(groupIcon(PENCIL_PATH));
    renameBtn.addEventListener('click', () => {
      startGroupRename(name);
    });
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'icon-btn groups-row__btn';
    deleteBtn.dataset.groupName = name;
    deleteBtn.setAttribute('aria-label', t('groupsDelete', [name]));
    deleteBtn.appendChild(groupIcon(TRASH_PATH));
    deleteBtn.addEventListener('click', () => {
      askGroupDelete(name);
    });
    actions.appendChild(renameBtn);
    actions.appendChild(deleteBtn);
    row.appendChild(actions);
    listEl.appendChild(row);
  }

  const err = document.getElementById('groups-sheet-error');
  if (err) {
    if (view.groupsError) {
      err.hidden = false;
      err.textContent = view.groupsError;
    } else {
      err.hidden = true;
      err.textContent = '';
    }
  }

  if (prevName) {
    const again = [...listEl.querySelectorAll('input, button')].find((el) => el.dataset.groupName === prevName);
    again?.focus();
  } else if (!sheet.contains(document.activeElement)) {
    document.getElementById('groups-sheet-close')?.focus?.();
  }
}

// 16×16 pencil and trash outlines for the group row buttons. The
// aria-label names the group, so the drawing carries no meaning.
const PENCIL_PATH = 'M13.7 2.3a1 1 0 0 0-1.4 0L4 10.6V14h3.4l8.3-8.3a1 1 0 0 0 0-1.4l-2-2zM6.1 12H4.5V10.4L11 3.9l1.6 1.6-6.5 6.5z';
const TRASH_PATH = 'M6.5 2h3a.5.5 0 0 1 .5.5V3h2.6a.5.5 0 0 1 0 1H3.4a.5.5 0 0 1 0-1H6v-.5a.5.5 0 0 1 .5-.5zm-2.6 3h8.2l-.7 8.4a.5.5 0 0 1-.5.6H5.1a.5.5 0 0 1-.5-.6L3.9 5z';

function groupIcon(path) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const draw = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  draw.setAttribute('d', path);
  draw.setAttribute('fill', 'currentColor');
  svg.appendChild(draw);
  return svg;
}

// The rename state of one group row: a field prefilled with the name plus
// Save and Cancel. Submit saves, Escape cancels through the sheet's own
// key handler, which must not close the sheet while this is showing.
function groupRenameRow(name) {
  const form = document.createElement('form');
  form.className = 'groups-row groups-row--edit';
  const input = document.createElement('input');
  input.className = 'add-row__input';
  input.type = 'text';
  input.maxLength = 24;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.value = groupRenameDraft.name === name ? groupRenameDraft.value : name;
  input.dataset.groupName = name;
  input.setAttribute('aria-label', t('groupsRenameName', [name]));
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'btn btn--primary';
  save.dataset.groupName = name;
  save.textContent = t('groupsSave');
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn';
  cancel.dataset.groupName = name;
  cancel.textContent = t('groupsCancel');
  cancel.addEventListener('click', () => {
    cancelGroupEdit(name);
  });
  form.appendChild(input);
  form.appendChild(save);
  form.appendChild(cancel);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitGroupRename(name, input.value);
  });
  return form;
}

// The delete state of one group row: an inline confirm naming the group
// and how many channels lose it, with Delete and Cancel. A modal dialog
// would wedge the popup, so the question lives in the row instead.
function groupDeleteRow(name) {
  const row = document.createElement('div');
  row.className = 'groups-row groups-row--confirm';
  const count = view.channels.filter((ch) => channelInGroup(ch, name)).length;
  const prompt = document.createElement('span');
  prompt.className = 'confirm-prompt';
  prompt.textContent = tCount('groupsDeleteConfirm', count, [isolate(name), String(count)]);
  const yes = document.createElement('button');
  yes.type = 'button';
  yes.className = 'btn btn--primary';
  yes.dataset.groupName = name;
  yes.textContent = t('groupsDeleteConfirmYes');
  yes.addEventListener('click', () => {
    void confirmGroupDelete(name);
  });
  const no = document.createElement('button');
  no.type = 'button';
  no.className = 'btn';
  no.dataset.groupName = name;
  no.textContent = t('groupsCancel');
  no.addEventListener('click', () => {
    cancelGroupDelete(name);
  });
  row.appendChild(prompt);
  row.appendChild(yes);
  row.appendChild(no);
  return row;
}

// Back on the row's Rename button when it is still there, otherwise the
// first one, otherwise Close — a deleted row has nowhere to return to.
function focusGroupRow(name) {
  const listEl = document.getElementById('groups-sheet-list');
  const again = name && [...(listEl?.querySelectorAll('button') || [])]
    .find((el) => el.dataset.groupName === name && !el.closest('[hidden]'));
  if (again) {
    again.focus();
    return;
  }
  const first = listEl?.querySelector('.groups-row__actions button');
  if (first) {
    first.focus();
    return;
  }
  document.getElementById('groups-sheet-close')?.focus?.();
}

function startGroupRename(name) {
  view.groupEdit = name;
  view.groupConfirm = '';
  groupRenameDraft = { name: '', value: '' };
  view.groupsError = '';
  render();
  const input = document.getElementById('groups-sheet-list')?.querySelector('.groups-row--edit input');
  if (input) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

function cancelGroupEdit(name) {
  view.groupEdit = '';
  groupRenameDraft = { name: '', value: '' };
  render();
  focusGroupRow(name);
}

function askGroupDelete(name) {
  view.groupConfirm = name;
  view.groupEdit = '';
  groupRenameDraft = { name: '', value: '' };
  view.groupsError = '';
  render();
  const yes = [...(document.getElementById('groups-sheet-list')?.querySelectorAll('button') || [])]
    .find((el) => el.dataset.groupName === name && el.classList.contains('btn--primary'));
  yes?.focus();
}

function cancelGroupDelete(name) {
  view.groupConfirm = '';
  render();
  focusGroupRow(name);
}

function collapseSupportQr() {
  const root = document.getElementById('support-methods');
  if (!root) return;
  for (const btn of root.querySelectorAll('.support-method__qr-toggle')) {
    btn.setAttribute('aria-expanded', 'false');
    btn.textContent = t('supportShowQr');
  }
  for (const card of root.querySelectorAll('.support-method__qr-card')) {
    card.hidden = true;
  }
}

function selectNodeText(el) {
  const sel = window.getSelection?.();
  if (!sel || !el) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
}

function copySupportAddress(address, btn, codeEl, statusEl) {
  statusEl.hidden = true;
  statusEl.textContent = '';
  const write = navigator.clipboard && typeof navigator.clipboard.writeText === 'function'
    ? navigator.clipboard.writeText(address)
    : Promise.reject(new Error('clipboard'));
  Promise.resolve(write).then(() => {
    btn.textContent = t('supportCopied');
    const prev = supportCopiedTimers.get(btn);
    if (prev) window.clearTimeout(prev);
    const timer = window.setTimeout(() => {
      if (btn.isConnected) btn.textContent = t('supportCopy');
    }, 1500);
    supportCopiedTimers.set(btn, timer);
  }, () => {
    statusEl.hidden = false;
    statusEl.textContent = t('supportCopyFailed');
    selectNodeText(codeEl);
  });
}

function supportMethodRow(method) {
  const row = document.createElement('div');
  row.className = 'support-method';

  const text = document.createElement('div');
  text.appendChild(textEl('div', 'support-method__name', method.name));
  if (method.hintKey) {
    text.appendChild(textEl('p', 'support-method__hint', t(method.hintKey)));
  }
  row.appendChild(text);

  const actions = document.createElement('div');
  actions.className = 'support-method__actions';

  let codeEl = null;
  let statusEl = null;
  if (method.address) {
    codeEl = document.createElement('code');
    codeEl.className = 'support-method__address';
    codeEl.dir = 'ltr';
    codeEl.textContent = method.address;
    actions.appendChild(codeEl);

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn';
    copyBtn.textContent = t('supportCopy');
    copyBtn.addEventListener('click', () => {
      copySupportAddress(method.address, copyBtn, codeEl, statusEl);
    });
    actions.appendChild(copyBtn);

    statusEl = document.createElement('p');
    statusEl.className = 'support-method__status';
    statusEl.setAttribute('role', 'status');
    statusEl.hidden = true;
  }

  if (method.url) {
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'btn btn--primary';
    openBtn.textContent = t('supportOpenLink');
    openBtn.addEventListener('click', () => openUrl(method.url));
    actions.appendChild(openBtn);
  }

  let qrCard = null;
  if (method.qr) {
    const qrId = `support-qr-${method.id}`;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'btn support-method__qr-toggle';
    toggle.textContent = t('supportShowQr');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', qrId);
    toggle.addEventListener('click', () => {
      const show = qrCard.hidden;
      qrCard.hidden = !show;
      toggle.setAttribute('aria-expanded', show ? 'true' : 'false');
      toggle.textContent = t(show ? 'supportHideQr' : 'supportShowQr');
    });
    actions.appendChild(toggle);

    qrCard = document.createElement('div');
    qrCard.id = qrId;
    qrCard.className = 'support-method__qr-card';
    qrCard.hidden = true;
    const img = document.createElement('img');
    img.className = 'support-method__qr';
    img.src = method.qr;
    img.alt = t('supportQrAlt', [method.address || '']);
    img.width = 180;
    img.height = 180;
    qrCard.appendChild(img);
  }

  row.appendChild(actions);
  if (statusEl) row.appendChild(statusEl);
  if (qrCard) row.appendChild(qrCard);
  return row;
}

function fillSupportMethods() {
  const root = document.getElementById('support-methods');
  if (!root) return;
  root.replaceChildren();
  for (const method of supportRows(SUPPORT_METHODS)) {
    root.appendChild(supportMethodRow(method));
  }
}

function renderSupportSheet() {
  const sheet = document.getElementById('support-sheet');
  if (!sheet) return;
  const root = document.getElementById('support-methods');
  if (root && !root.childElementCount) fillSupportMethods();
  const open = !!view.supportOpen;
  sheet.hidden = !open;
  if (!open) collapseSupportQr();
}

function audioPanelVisible() {
  const panel = document.getElementById('audio');
  return !!panel && !panel.hidden;
}

function syncAudioPolling() {
  const want = audioPanelVisible() && view.audioReachable;
  if (want) {
    if (!audioPollTimer) {
      audioPollTimer = setInterval(() => { void refreshPlayerCard(); }, AUDIO_POLL_MS);
    }
  } else if (audioPollTimer) {
    clearInterval(audioPollTimer);
    audioPollTimer = null;
  }
}

function closestSelectValue(select, value) {
  const options = [...select.options].map((o) => Number(o.value));
  let best = options[0];
  let bestDist = Infinity;
  for (const n of options) {
    if (!Number.isFinite(n)) continue;
    const d = Math.abs(n - value);
    if (d < bestDist) {
      bestDist = d;
      best = n;
    }
  }
  return best;
}

function setSeekValueText(seek, current, duration) {
  if (!seek) return;
  seek.setAttribute(
    'aria-valuetext',
    t('audioSeekValue', [Core.formatTime(current), Core.formatTime(duration)]),
  );
}

function updateTitleScroll(el, text) {
  if (!el) return;
  if (el.textContent !== text) el.textContent = text;
  const wrap = el.parentElement;
  if (!wrap) return;
  const overflow = el.scrollWidth - wrap.clientWidth;
  if (overflow > 4) {
    // Overflow hangs off inline-end; RTL is +X so the CSS mask fade
    // on that side is `to left`, not the LTR `to right`.
    const rtl = getComputedStyle(document.documentElement).direction === 'rtl';
    const shift = `${rtl ? overflow + 10 : -(overflow + 10)}px`;
    if (el.style.getPropertyValue('--audio-title-shift') !== shift) {
      el.style.setProperty('--audio-title-shift', shift);
      el.style.setProperty('--audio-title-duration', `${Math.max(5, overflow * 0.08)}s`);
    }
    el.classList.add('is-scrolling');
  } else {
    el.classList.remove('is-scrolling');
    el.style.removeProperty('--audio-title-shift');
  }
}

async function goToAudioTab(tab) {
  if (!tab || tab.id == null) return;
  try {
    await chrome.tabs.update(tab.id, { active: true });
    // Activating a tab does not need its window id. windows.update does,
    // and calling it without one throws even though the tab came forward.
    if (tab.windowId != null) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch {
    // A tab that closed between the draw and the click throws. Leave the
    // popup open and redraw so that row drops out.
    await refreshAudioState();
    renderAudio();
    return;
  }
  window.close();
}

function renderAudioPicker(reachable) {
  const el = document.getElementById('audio-picker');
  if (!el) return;
  const tabs = view.audioTabs || [];
  const show = tabs.length >= 2;
  el.hidden = !show;
  if (!show) {
    el.replaceChildren();
    audioPickerKey = '';
    return;
  }
  const key = `${tabs.map((tab) => `${tab.id}\t${tab.windowId ?? ''}\t${tab.title || ''}`).join('\n')}#${view.audioTargetId}#${reachable}`;
  // One row per tab, so the child count is still the list length. A match
  // keeps the buttons (and keyboard focus) instead of rebuilding them.
  if (key === audioPickerKey && el.childElementCount === tabs.length) {
    for (const btn of el.querySelectorAll('.audio-picker__tab')) {
      btn.disabled = !reachable;
    }
    return;
  }
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  // The go-to control is a sibling of the select button. Sharing
  // data-tab-id would hand focus back to the select button.
  const focusedGo = active?.dataset.goTabId || '';
  const focusedId = focusedGo ? '' : (active?.dataset.tabId || '');
  audioPickerKey = key;
  el.replaceChildren();
  for (const tab of tabs) {
    const title = Core.tabTitleToVideoTitle(tab.title) || t('audioPlayerNoTitle');
    const row = document.createElement('div');
    row.className = 'audio-picker__row';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'audio-picker__tab';
    btn.dataset.tabId = String(tab.id);
    btn.appendChild(textEl('span', 'audio-picker__title', title));
    btn.setAttribute('aria-label', t('audioPickerTab', [title]));
    if (tab.id === view.audioTargetId) btn.setAttribute('aria-current', 'true');
    btn.disabled = !reachable;
    btn.addEventListener('click', () => {
      void selectAudioTab(tab.id);
    });

    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'icon-btn audio-picker__goto';
    go.dataset.goTabId = String(tab.id);
    const goLabel = t('audioPickerGoToTab', [title]);
    go.setAttribute('aria-label', goLabel);
    go.title = goLabel;
    const icon = document.createElement('span');
    icon.className = 'audio-picker__goto-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '\u2197';
    go.appendChild(icon);
    go.addEventListener('click', () => {
      void goToAudioTab(tab);
    });

    row.appendChild(btn);
    row.appendChild(go);
    el.appendChild(row);
  }
  if (focusedGo) {
    el.querySelector(`[data-go-tab-id="${focusedGo}"]`)?.focus?.();
  } else if (focusedId) {
    el.querySelector(`.audio-picker__tab[data-tab-id="${focusedId}"]`)?.focus?.();
  }
}

function renderAudioPlayer(reachable) {
  const player = view.audioPlayer;
  const tab = (view.audioTabs || []).find((row) => row.id === view.audioTargetId);
  const titleFromPlayer = player && player.title ? player.title : '';
  const titleFromTab = tab ? Core.tabTitleToVideoTitle(tab.title) : '';
  const title = titleFromPlayer || titleFromTab || t('audioPlayerNoTitle');
  const videoId = (player && player.videoId)
    || (tab ? Core.videoIdFromUrl(tab.url) : '')
    || '';

  updateTitleScroll(document.getElementById('audio-title'), title);

  const channelEl = document.getElementById('audio-channel');
  if (channelEl) renderPlayerChannels(channelEl, player, videoId);

  const thumb = document.getElementById('audio-thumb');
  if (thumb) {
    if (videoId) {
      const src = thumbUrl(videoId, 'mq');
      if (thumb.getAttribute('src') !== src) thumb.src = src;
      thumb.alt = title;
      thumb.hidden = false;
    } else {
      thumb.removeAttribute('src');
      thumb.alt = '';
      thumb.hidden = true;
    }
  }

  const elapsed = document.getElementById('audio-elapsed');
  const total = document.getElementById('audio-duration');
  const seek = document.getElementById('audio-seek');
  const currentTime = player ? player.currentTime : 0;
  const duration = player ? player.duration : 0;
  const hasDuration = duration > 0 && Number.isFinite(duration);
  const shown = audioSeeking && seek ? Number(seek.value) : currentTime;
  if (elapsed) elapsed.textContent = Core.formatTime(shown);
  if (total) total.textContent = Core.formatTime(duration);
  if (seek) {
    seek.disabled = !reachable || !hasDuration;
    if (shouldSyncAudioSeek(audioSeeking)) {
      seek.max = hasDuration ? String(duration) : '0';
      seek.value = hasDuration ? String(currentTime) : '0';
    }
    setSeekValueText(seek, shown, duration);
  }

  const paused = !player || player.paused !== false;
  const play = document.getElementById('audio-play');
  if (play) {
    play.disabled = !reachable;
    const label = paused ? t('audioPlayerPlay') : t('audioPlayerPause');
    play.textContent = paused ? '▶' : '❚❚';
    play.setAttribute('aria-label', label);
    play.title = label;
  }
  const back = document.getElementById('audio-back');
  const forward = document.getElementById('audio-forward');
  if (back) back.disabled = !reachable;
  if (forward) forward.disabled = !reachable;

  const speed = document.getElementById('audio-speed');
  if (speed) {
    speed.disabled = !reachable;
    if (player && shouldSyncAudioSelect(audioSpeedPending)) {
      const snapped = closestSelectValue(speed, Number(player.playbackRate) || 1);
      const next = String(snapped);
      if (speed.value !== next) speed.value = next;
    }
  }
  const volume = document.getElementById('audio-volume');
  if (volume) {
    volume.disabled = !reachable;
    if (player && shouldSyncAudioSelect(audioVolumePending)) {
      const vol = audioVolumeSelectValue(player);
      if (vol != null) {
        const snapped = closestSelectValue(volume, vol);
        const next = String(snapped);
        if (volume.value !== next) volume.value = next;
      }
    }
  }
  const sleep = document.getElementById('audio-sleep');
  if (sleep) {
    sleep.disabled = !reachable;
    if (shouldSyncAudioSelect(audioSleepPending)) {
      // While a timer runs the select shows what is left, not the length picked.
      const left = sleepMinutesLeft(player?.sleepAt, Date.now());
      const leftOption = document.getElementById('audio-sleep-left');
      if (leftOption) {
        leftOption.hidden = !left;
        leftOption.textContent = left ? t('audioSleepLeft', [String(left)]) : '';
      }
      const next = left ? 'left' : '0';
      if (sleep.value !== next) sleep.value = next;
    }
  }

  const queueBtn = document.getElementById('audio-queue');
  if (queueBtn) {
    const show = reachable && !!videoId;
    queueBtn.hidden = !show;
    if (show) {
      const queued = videoIsQueued(videoId);
      const qLabel = t(queued ? 'queueRemove' : 'queueAdd');
      queueBtn.setAttribute('aria-label', qLabel);
      queueBtn.title = qLabel;
      queueBtn.setAttribute('aria-pressed', queued ? 'true' : 'false');
      const pressed = queued ? '1' : '0';
      if (queueBtn.dataset.icon !== pressed) {
        queueBtn.replaceChildren(queueIcon(queued));
        queueBtn.dataset.icon = pressed;
      }
    }
  }
}

function fitAudioStatValue(el) {
  if (!el) return;
  el.style.fontSize = '';
  const have = el.clientWidth;
  const need = el.scrollWidth;
  if (!have || need <= have) return;
  const base = parseFloat(getComputedStyle(el).fontSize) || 14;
  let px = base * have / need;
  el.style.fontSize = Math.max(9, px) + 'px';
  // Width is not perfectly linear in font-size, so the first step can
  // still overflow by a fraction of a pixel and hit the ellipsis.
  let guard = 12;
  while (el.scrollWidth > have && px > 9 && guard--) {
    px -= 0.25;
    el.style.fontSize = Math.max(9, px) + 'px';
  }
}

function renderAudioStats() {
  const monthBtn = document.getElementById('audio-stats-month');
  const allBtn = document.getElementById('audio-stats-all');
  const scope = view.audioStatsScope === 'all' ? 'all' : 'month';
  if (monthBtn) {
    monthBtn.disabled = false;
    monthBtn.setAttribute('aria-pressed', scope === 'month' ? 'true' : 'false');
  }
  if (allBtn) {
    allBtn.disabled = false;
    allBtn.setAttribute('aria-pressed', scope === 'all' ? 'true' : 'false');
  }
  const folded = audioStatsView(view.audioStats, scope, Date.now(), Core);
  const units = { mb: t('audioStatsUnitMb'), gb: t('audioStatsUnitGb') };
  const used = document.getElementById('audio-stat-used');
  const saved = document.getElementById('audio-stat-saved');
  const listened = document.getElementById('audio-stat-listened');
  const active = document.getElementById('audio-stat-active');
  if (used) used.textContent = Core.formatData(folded.usedMb, units);
  if (saved) saved.textContent = Core.formatData(folded.savedMb, units);
  if (listened) listened.textContent = Core.formatTime(folded.listened);
  if (active) active.textContent = Core.formatTime(folded.active);
  fitAudioStatValue(used);
  fitAudioStatValue(saved);
  fitAudioStatValue(listened);
  fitAudioStatValue(active);

  const note = document.getElementById('audio-rate-note');
  if (note) {
    const allTime = audioStatsView(view.audioStats, 'all', Date.now(), Core);
    note.hidden = !showRateNote(allTime.savedMb, view.rateNoteDone);
  }
}

function currentFollow() {
  return followView({
    tab: view.activeTab,
    page: view.activePage,
    channels: view.channels,
    feed: view.feed,
    core: Core,
  });
}

function followCheck() {
  const mark = textEl('span', 'follow-check', '\u2714\uFE0E');
  mark.setAttribute('role', 'img');
  mark.setAttribute('aria-label', t('followingChannel'));
  mark.title = t('followingChannel');
  return mark;
}

function followRow(row, action) {
  const li = document.createElement('li');
  li.className = 'follow-card__row';
  if (row.followed) li.appendChild(followCheck());
  const name = textEl('span', 'follow-card__name', row.name);
  name.dir = 'auto';
  name.hidden = !row.name;
  li.appendChild(name);
  if (row.followed) return li;
  const spinner = document.createElement('span');
  spinner.className = 'spinner';
  spinner.hidden = !action?.pending;
  li.appendChild(spinner);
  const btn = buttonEl('btn btn--primary follow-card__btn', t('followButton'), () => {
    void followChannel(row.input);
  });
  btn.disabled = !!action?.disabled;
  btn.dataset.input = row.input;
  btn.setAttribute('aria-label', row.name ? t('followButtonNamed', [row.name]) : t('followButton'));
  li.appendChild(btn);
  const errText = view.followErrors[row.input];
  if (errText) {
    const err = textEl('p', 'follow-card__error', errText);
    err.setAttribute('role', 'status');
    li.appendChild(err);
  }
  return li;
}

function renderFollow() {
  const card = document.getElementById('follow-card');
  if (!card) return;
  const follow = currentFollow();
  card.hidden = !follow.show;
  const list = document.getElementById('follow-card-list');
  const actions = followActionState(follow.rows, view.followPending);
  // The card redraws every second with the player; rebuilding rows that did
  // not change would take keyboard focus off a Follow button.
  const sig = JSON.stringify([locale, follow, view.followPending, view.followErrors]);
  if (follow.show && card.dataset.sig !== sig) {
    card.dataset.sig = sig;
    const labels = { channel: 'followChannelLabel', video: 'followVideoLabel', collab: 'followCollabLabel' };
    document.getElementById('follow-card-label').textContent = t(labels[follow.kind]);
    const focused = document.activeElement?.dataset?.input;
    const byInput = new Map(actions.map((a) => [a.input, a]));
    list.replaceChildren(...follow.rows.map((row) => followRow(row, byInput.get(row.input))));
    if (focused) list.querySelector(`[data-input="${CSS.escape(focused)}"]`)?.focus();
  }

  const okEl = document.getElementById('follow-ok');
  okEl.hidden = !view.followOk;
  okEl.textContent = view.followOk;
  const errorEl = document.getElementById('follow-error');
  if (errorEl) {
    errorEl.hidden = true;
    errorEl.textContent = '';
  }
}

async function followChannel(input) {
  const row = currentFollow().rows.find((r) => r.input === input && !r.followed);
  if (!row) return;
  if (view.followPending.includes(input)) return;
  view.followOk = '';
  const cleared = { ...view.followErrors };
  delete cleared[input];
  view.followErrors = cleared;
  view.followPending = [...view.followPending, input];
  view.undo = null;
  render();
  try {
    const res = await send({ type: 'addChannel', input });
    if (!res || res.ok === false) {
      view.followErrors = { ...view.followErrors, [input]: formatError(res?.error) };
      return;
    }
    // A slower reply's snapshot can predate a Follow that already landed.
    const known = view.channels.slice();
    if (res.state) applySnapshot(res.state);
    else await refreshState();
    const have = new Set(view.channels.map((ch) => ch.id));
    const extra = known.filter((ch) => ch?.id && !have.has(ch.id));
    if (extra.length) view.channels = [...view.channels, ...extra];
    if (res.channel?.id && !have.has(res.channel.id) && !extra.some((ch) => ch.id === res.channel.id)) {
      view.channels = [...view.channels, res.channel];
    }
    const ch = res.channel || {};
    view.followOk = t('followDone', [isolate(ch.title || ch.handle || row.name || ch.id || '')]);
    const nextErr = { ...view.followErrors };
    delete nextErr[input];
    view.followErrors = nextErr;
  } catch (err) {
    view.followErrors = { ...view.followErrors, [input]: formatError(err?.message || err) };
  } finally {
    view.followPending = view.followPending.filter((id) => id !== input);
    render();
  }
  // The pressed button may have left with its row. Leave focus alone if the
  // reader already moved to another Follow button.
  const card = document.getElementById('follow-card');
  const active = document.activeElement;
  if (card && !card.hidden && card.contains(active) && active !== card) return;
  const buttons = card && !card.hidden ? [...card.querySelectorAll('.follow-card__btn')] : [];
  const target = buttons.find((btn) => btn.dataset.input === input) || buttons[0]
    || document.getElementById('tab-audio');
  target?.focus();
}

function queueRow(item) {
  const row = document.createElement('div');
  row.className = 'queue-row';
  const title = item.t || '';
  const modes = rowOpenModes(view.settings);

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'queue-row__open';
  openBtn.setAttribute(
    'aria-label',
    t(modes.row === 'audio' ? 'feedOpenVideoAudio' : 'feedOpenVideo', [title]),
  );
  openBtn.addEventListener('click', () => {
    void playQueueItem(item);
  });
  row.appendChild(openBtn);

  const thumb = document.createElement('div');
  thumb.className = 'queue-row__thumb';
  const img = document.createElement('img');
  img.alt = title;
  img.loading = 'lazy';
  img.decoding = 'async';
  img.src = thumbUrl(item.v, 'mq');
  thumb.appendChild(img);
  row.appendChild(thumb);

  const body = document.createElement('div');
  body.className = 'queue-row__body';
  body.appendChild(textEl('div', 'queue-row__title', title));
  const channelName = item.ct || '';
  if (channelName) body.appendChild(textEl('div', 'queue-row__channel', channelName));
  row.appendChild(body);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'icon-btn queue-row__remove';
  remove.setAttribute('aria-label', t('queueRemove'));
  remove.title = t('queueRemove');
  remove.textContent = '✕';
  remove.addEventListener('click', (event) => {
    event.stopPropagation();
    void removeQueued(item.v);
  });
  row.appendChild(remove);
  return row;
}

function renderQueue() {
  const root = document.getElementById('queue');
  if (!root) return;
  const folded = queueView({ queue: view.queue, open: view.queueOpen, cap: QUEUE_CAP });
  const toggle = document.getElementById('queue-toggle');
  const label = document.getElementById('queue-toggle-label');
  const play = document.getElementById('queue-play');
  const clear = document.getElementById('queue-clear');
  const list = document.getElementById('queue-list');
  const empty = document.getElementById('queue-empty');
  const notice = document.getElementById('queue-notice');
  const confirm = document.getElementById('queue-confirm');

  const title = folded.empty
    ? t('queueTitle')
    : tCount('queueTitleCount', folded.count);
  if (label) label.textContent = title;
  if (toggle) {
    toggle.setAttribute('aria-expanded', folded.open ? 'true' : 'false');
    toggle.title = t(folded.open ? 'queueHide' : 'queueShow');
  }
  // An empty queue leaves the header a quiet one-line label: the Player tab
  // is crowded enough without two buttons that would do nothing.
  if (play) play.hidden = folded.empty;
  if (clear) clear.hidden = folded.empty;
  if (confirm) confirm.hidden = !view.queueClearOpen || folded.empty;
  if (notice) {
    notice.hidden = !view.queueNotice;
    notice.textContent = view.queueNotice || '';
  }

  const showList = folded.open && !folded.empty;
  const showEmpty = folded.open && folded.empty;
  if (list) list.hidden = !showList;
  if (empty) empty.hidden = !showEmpty;

  // The signature is what stops a redraw from rebuilding rows that have not
  // changed, which would drop focus mid-keyboard. Only a hidden list is
  // emptied: clearing it on an unchanged redraw would blank the open list.
  const sig = JSON.stringify([locale, view.queue, folded.open]);
  if (!showList) {
    queueListSig = '';
    list?.replaceChildren();
  } else if (list && sig !== queueListSig) {
    const focusedV = document.activeElement instanceof HTMLElement
      ? document.activeElement.dataset.queueV
      : '';
    queueListSig = sig;
    list.replaceChildren();
    for (const item of folded.items) {
      const row = queueRow(item);
      row.dataset.queueV = item.v;
      list.appendChild(row);
    }
    if (focusedV) {
      list.querySelector(`[data-queue-v="${CSS.escape(focusedV)}"]`)?.querySelector('.queue-row__open')?.focus?.();
    }
  }
}

function applyQueueResult(res, { fullNotice = false } = {}) {
  if (res && Array.isArray(res.queue)) view.queue = res.queue;
  if (res && res.ok === false && res.error === 'full' && fullNotice) {
    view.queueNotice = t('queueFull');
  }
  render();
}

async function toggleQueued(item) {
  if (!item || !item.v) return;
  if (item.k === 'live' || item.k === 'premiere') return;
  view.queueNotice = '';
  view.queueClearOpen = false;
  const queued = videoIsQueued(item.v);
  try {
    if (queued) {
      const res = await send({ type: 'queue.remove', v: item.v });
      applyQueueResult(res);
      return;
    }
    const entry = queueEntryFromItem(item, Date.now()) || item;
    const res = await send({ type: 'queue.add', item: entry });
    applyQueueResult(res, { fullNotice: true });
  } catch (err) {
    view.queueNotice = formatError(err?.message || err);
    render();
  }
}

async function removeQueued(v) {
  view.queueNotice = '';
  view.queueClearOpen = false;
  try {
    const res = await send({ type: 'queue.remove', v });
    applyQueueResult(res);
  } catch (err) {
    view.queueNotice = formatError(err?.message || err);
    render();
  }
}

async function playQueueItem(item) {
  view.queueNotice = '';
  try {
    const res = await send({ type: 'queue.remove', v: item.v });
    if (res && Array.isArray(res.queue)) view.queue = res.queue;
  } catch {
    // Open anyway; the row click should still take you to the video.
  }
  openFeedItem(item, rowOpenModes(view.settings).row);
}

async function playQueue() {
  if (!(view.queue || []).length) return;
  view.queueNotice = '';
  view.queueClearOpen = false;
  try {
    const res = await send({ type: 'queue.playAll' });
    if (res && Array.isArray(res.queue)) view.queue = res.queue;
    if (res && res.ok === true) {
      window.close();
      return;
    }
    if (res && res.error === 'empty') render();
    else if (res && res.ok === false) {
      view.queueNotice = formatError(res.error);
      render();
    }
  } catch (err) {
    view.queueNotice = formatError(err?.message || err);
    render();
  }
}

async function clearQueued() {
  view.queueNotice = '';
  try {
    const res = await send({ type: 'queue.clear' });
    view.queueClearOpen = false;
    applyQueueResult(res);
  } catch (err) {
    view.queueNotice = formatError(err?.message || err);
    render();
  }
}

function toggleQueueOpen() {
  view.queueOpen = !view.queueOpen;
  void send({ type: 'queue.setOpen', on: view.queueOpen });
  renderQueue();
}

/**
 * The player card's channel line: every credited channel in the popup's own
 * list format ("A and B"), a check before each one on the list.
 */
function renderPlayerChannels(el, player, videoId) {
  const rows = pageChannelsView({ page: player, videoId, channels: view.channels, feed: view.feed });
  const fallback = (player && player.channel) || '';
  const sig = JSON.stringify([locale, rows, fallback]);
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  if (!rows.length) {
    el.textContent = fallback;
    return;
  }
  el.replaceChildren();
  const parts = new Intl.ListFormat(locale)
    .formatToParts(rows.map((row) => row.name));
  let i = 0;
  for (const part of parts) {
    if (part.type !== 'element') {
      el.append(part.value);
      continue;
    }
    const row = rows[i++];
    if (row?.followed) el.appendChild(followCheck());
    // A Latin name inside an Arabic list would otherwise reorder its neighbours.
    el.appendChild(textEl('bdi', '', part.value));
  }
}

function renderAudio() {
  renderFollow();
  const reachable = view.audioReachable;
  const notice = document.getElementById('audio-page-notice');
  if (notice) notice.hidden = !view.audioKnown || reachable;

  const toggle = document.getElementById('audio-toggle');
  if (toggle) {
    toggle.disabled = !reachable;
    toggle.checked = reachable && view.audioOn;
  }

  const restore = document.getElementById('audio-restore-quality');
  if (restore) {
    restore.disabled = !reachable;
    const q = view.settings?.audio?.restoreQuality || 'hd720';
    if (restore.value !== q) restore.value = q;
  }

  renderAudioPicker(reachable);
  renderAudioPlayer(reachable);
  renderQueue();
  renderAudioStats();

  const hint = document.getElementById('audio-shortcut');
  if (hint) {
    hint.disabled = view.audioKnown && !reachable;
    const shortcut = view.audioShortcut;
    const text = shortcut
      ? t('audioShortcutBound', [shortcut])
      : t('audioShortcutNone');
    hint.textContent = text;
    hint.title = text;
  }

  syncAudioPolling();
}

function renderSettings(locale) {
  const s = view.settings || {};
  // Empty when Chrome found the combination taken and bound nothing.
  for (const [id, keys] of [['settings-key-popup', view.popupShortcut], ['settings-key-audio', view.audioShortcut]]) {
    const el = document.getElementById(id);
    if (el) el.textContent = keys || t('settingsKeyNone');
  }
  for (const input of document.querySelectorAll('#settings [data-setting]')) {
    const value = readPath(s, input.dataset.setting);
    if (input.type === 'checkbox') input.checked = !!value;
    // Setting .value on a radio would overwrite its value instead of
    // checking the matching one.
    else if (input.type === 'radio') input.checked = input.value === value;
    else input.value = value ?? '';
  }

  const audio = s.audio || {};
  const usingImage = audio.backgroundType === 'image';
  const colorBlock = document.getElementById('settings-audio-color');
  const imageBlock = document.getElementById('settings-audio-image');
  if (colorBlock) colorBlock.hidden = usingImage;
  if (imageBlock) imageBlock.hidden = !usingImage;

  const preset = audio.preset || 'midnight';
  for (const btn of document.querySelectorAll('.swatch[data-preset]')) {
    const on = !usingImage && btn.dataset.preset === preset;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  const customWrap = document.querySelector('.swatch--custom');
  const customInput = document.getElementById('audio-custom-color');
  if (customWrap) customWrap.classList.toggle('is-selected', !usingImage && preset === 'custom');
  if (customInput) {
    const color = audio.customColor || '#0f0f14';
    if (customInput.value !== color) customInput.value = color;
    customWrap?.style.setProperty('background', color);
  }

  const hasCover = isCoverDataUrl(view.audioCover);
  const removeBtn = document.getElementById('audio-cover-remove');
  if (removeBtn) removeBtn.disabled = !hasCover;
  const hint = document.getElementById('audio-cover-hint');
  if (hint) hint.hidden = hasCover;
  const coverErr = document.getElementById('audio-cover-error');
  if (coverErr) {
    coverErr.hidden = !view.coverError;
    coverErr.textContent = view.coverError || '';
  }
  paintCoverPreview(hasCover ? view.audioCover : '');

  const locked = view.importBusy;
  const exportBtn = document.getElementById('settings-export');
  const importBtn = document.getElementById('settings-import');
  const mergeBtn = document.getElementById('settings-import-merge');
  const replaceBtn = document.getElementById('settings-import-replace');
  const confirmBtn = document.getElementById('settings-import-replace-confirm');
  const cancelBtn = document.getElementById('settings-import-replace-cancel');
  const clearYes = document.getElementById('settings-clear-yes');
  const clearCancel = document.getElementById('settings-clear-cancel');
  for (const btn of [exportBtn, importBtn, mergeBtn, replaceBtn, confirmBtn, cancelBtn, clearYes, clearCancel]) {
    if (btn) btn.disabled = locked;
  }
  const clearBtn = document.getElementById('settings-clear');
  if (clearBtn) clearBtn.disabled = locked || view.channels.length === 0;

  const choice = document.getElementById('settings-import-choice');
  const confirm = document.getElementById('settings-import-confirm');
  if (choice) choice.hidden = view.importStage !== 'choose';
  if (confirm) confirm.hidden = view.importStage !== 'confirm';
  const clearRow = document.getElementById('settings-clear-confirm');
  if (clearRow) clearRow.hidden = !view.clearOpen || view.channels.length === 0;
  const clearPrompt = document.getElementById('settings-clear-prompt');
  if (clearPrompt) clearPrompt.textContent = tCount('settingsClearPrompt', view.channels.length);

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
  if (chEl) chEl.textContent = tCount('settingsFooterChannels', nCh);
  if (feedEl) feedEl.textContent = tCount('settingsFooterFeed', nFeed);
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

async function withBusy(fn, errField = 'error') {
  if (view.busy) return;
  view.busy = true;
  view[errField] = '';
  render();
  try {
    await fn();
  } catch (err) {
    view[errField] = formatError(err?.message || err);
  } finally {
    view.busy = false;
    render();
  }
}

async function addChannel(input, dest = 'watchlist') {
  const errorField = dest === 'feeds' ? 'feedError' : 'error';
  const okField = dest === 'feeds' ? 'feedOk' : 'ok';
  const boxId = dest === 'feeds' ? 'feed-filter' : 'watchlist-input';
  if (view.adding) return;
  view.adding = true;
  view[errorField] = '';
  view[okField] = '';
  view.undo = null;
  render();
  try {
    const res = await send({ type: 'addChannel', input });
    if (!res || res.ok === false) {
      view[errorField] = formatError(res?.error);
      return;
    }
    const box = document.getElementById(boxId);
    if (box) box.value = '';
    if (res.state) applySnapshot(res.state);
    else await refreshState();
    const ch = res.channel || {};
    view[okField] = t('channelAdded', [isolate(ch.title || ch.handle || ch.id || '')]);
  } catch (err) {
    view[errorField] = formatError(err?.message || err);
  } finally {
    view.adding = false;
    render();
  }
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

async function toggleMuted(id, on) {
  await withBusy(async () => {
    const res = await send({ type: 'setMuted', id, on });
    if (res && res.ok === false) {
      view.error = formatError(res.error);
      return;
    }
    await refreshState();
  });
}

function groupsErrorText(error) {
  const key = error === 'channelCap'
    ? 'groupsChannelCap'
    : error === 'listCap'
      ? 'groupsListCap'
      : error === 'empty'
        ? 'groupsRenameEmpty'
        : error === 'missing'
          ? 'groupsGone'
          : '';
  return key ? t(key) : formatError(error);
}

async function applyGroup(id, name, on) {
  const key = fold(normalizeGroupName(name) || String(name || ''));
  if (!id || !key) return;
  const want = !!on;
  view.groupsError = '';
  view.groupPending = { ...view.groupPending, [key]: want };
  render();
  const write = chainSerial(groupWrite, async () => {
    try {
      const res = await send({ type: 'setChannelGroup', id, name, on: want });
      if (res && res.ok === false) {
        view.groupsError = groupsErrorText(res.error);
        return;
      }
      view.groupsError = '';
      await refreshState();
    } catch (err) {
      view.groupsError = formatError(err?.message || err);
    } finally {
      if (view.groupPending[key] === want) {
        const next = { ...view.groupPending };
        delete next[key];
        view.groupPending = next;
      }
      render();
    }
  });
  groupWrite = write;
  return write;
}

async function submitGroupRename(from, to) {
  const name = normalizeGroupName(to);
  if (!name) {
    view.groupsError = groupsErrorText('empty');
    render();
    document.getElementById('groups-sheet-list')?.querySelector('.groups-row--edit input')?.focus();
    return;
  }
  view.groupsError = '';
  render();
  const write = chainSerial(groupWrite, async () => {
    try {
      const res = await send({ type: 'renameGroup', from, to: name });
      view.groupEdit = '';
      groupRenameDraft = { name: '', value: '' };
      if (res && res.ok === false) {
        view.groupsError = groupsErrorText(res.error);
      } else {
        view.groupsError = '';
      }
      await refreshState();
    } catch (err) {
      view.groupEdit = '';
      groupRenameDraft = { name: '', value: '' };
      view.groupsError = formatError(err?.message || err);
    }
    render();
    // A merge lands on the other group's spelling; resolve it so focus
    // finds the row the name merged into.
    const landed = groupNamesInList(view.channels, locale).find((n) => fold(n) === fold(name)) || '';
    focusGroupRow(landed);
  });
  groupWrite = write;
  return write;
}

async function confirmGroupDelete(name) {
  if (!name) return;
  view.groupsError = '';
  render();
  const write = chainSerial(groupWrite, async () => {
    try {
      const res = await send({ type: 'deleteGroup', name });
      view.groupConfirm = '';
      if (res && res.ok === false) {
        view.groupsError = groupsErrorText(res.error);
      } else {
        view.groupsError = '';
      }
      await refreshState();
    } catch (err) {
      view.groupConfirm = '';
      view.groupsError = formatError(err?.message || err);
    }
    render();
    focusGroupRow('');
  });
  groupWrite = write;
  return write;
}

// Names are often in the other script from the sentence around them; without
// isolation a Latin name scrambles the full stop in Arabic text.
function isolate(text) {
  return `\u2068${text}\u2069`;
}

async function removeChannel(id) {
  const ch = view.channels.find((c) => c.id === id);
  const title = ch ? ch.title || ch.handle || ch.id : id;
  await withBusy(async () => {
    const res = await send({ type: 'removeChannel', id });
    if (res && res.ok === false) {
      view.error = formatError(res.error);
      return;
    }
    // No timer: an Undo that vanishes while someone reaches for it is worse
    // than one that stays until the next add, remove or close.
    view.ok = '';
    view.undo = { id, title };
    await refreshState();
  });
  // Focus was on the menu item, which left with its row. Undo is pinned in
  // view, and letting focus scroll would lose the reader's place in the list.
  if (view.undo?.id === id) document.getElementById('watchlist-undo-btn')?.focus({ preventScroll: true });
}

async function undoRemove() {
  const undo = view.undo;
  if (!undo || view.undoing) return;
  view.undoing = true;
  view.error = '';
  render();
  try {
    const res = await send({ type: 'undoRemove', id: undo.id });
    view.undo = null;
    if (!res || res.ok === false) {
      view.error = formatError(res?.error);
      return;
    }
    await refreshState();
    view.ok = t('watchlistRestored', [isolate(undo.title)]);
  } catch (err) {
    view.error = formatError(err?.message || err);
  } finally {
    view.undoing = false;
    render();
  }
  focusSheetOpener(undo.id);
}

async function currentTabUrl() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return String(tabs?.[0]?.url || '');
  } catch {
    return '';
  }
}

async function submitAdd(raw, dest = 'watchlist') {
  if (view.adding) return;
  const errorField = dest === 'feeds' ? 'feedError' : 'error';
  const okField = dest === 'feeds' ? 'feedOk' : 'ok';
  let input = String(raw || '').trim();
  let fromTab = false;
  view[okField] = '';
  if (!input) {
    fromTab = true;
    input = await currentTabUrl();
    if (!isChannelRef(input)) {
      view[errorField] = t('watchlistNoCurrentTab');
      render();
      return;
    }
  }
  if (!isChannelRef(input)) return;
  if (listedMatch(input, view.channels, view.feed)) {
    if (fromTab) {
      view[errorField] = t('watchlistAlreadyAdded');
      render();
    }
    return;
  }
  await addChannel(input, dest);
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
    // A pause is not an error: refreshState brings in backoffUntil, and the
    // feed and sheet show it as a plain notice.
    if (res && res.ok === false && res.error !== 'slow down') {
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

function clearFeedQuery() {
  const input = document.getElementById('feed-filter');
  if (!input || !input.value) return;
  input.value = '';
  view.feedError = '';
  view.feedOk = '';
  render();
  input.focus();
}

function bindFeeds() {
  const form = document.getElementById('feed-add-form');
  const filter = document.getElementById('feed-filter');
  const clear = document.getElementById('feed-clear');
  const refresh = document.getElementById('feed-refresh');
  const gotoWatchlist = document.getElementById('feed-goto-watchlist');
  const emptyRefresh = document.getElementById('feed-waiting-refresh');
  const emptyClear = document.getElementById('feed-filter-clear');
  const favBox = document.getElementById('feed-favorites-only');
  const groupsRow = document.getElementById('feed-groups');
  const emptyGroupAll = document.getElementById('feed-group-all');

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitAdd(filter.value, 'feeds');
  });
  filter.addEventListener('input', () => {
    view.feedError = '';
    view.feedOk = '';
    render();
  });
  const more = document.getElementById('feed-more');
  more.addEventListener('click', () => {
    const first = feedLimit;
    showMoreFeed();
    // A keyboard press lands on the first new row, not back at the button.
    document.getElementById('feed-list').children[first]?.focus();
  });
  // Scrolling near the end draws the next page without a click.
  new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting) && !more.hidden) showMoreFeed();
  }, { rootMargin: '300px' }).observe(more);
  filter.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!filter.value) return;
    event.preventDefault();
    clearFeedQuery();
  });
  clear.addEventListener('click', () => {
    clearFeedQuery();
  });
  refresh.addEventListener('click', () => {
    void requestSweep();
  });
  emptyRefresh.addEventListener('click', () => {
    void requestSweep();
  });
  emptyClear.addEventListener('click', () => {
    clearFeedQuery();
  });
  favBox.addEventListener('change', () => {
    void patchSettings(buildPatch('feed.favoritesOnly', favBox.checked));
  });
  groupsRow?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-group]');
    if (!btn || !groupsRow.contains(btn)) return;
    const name = btn.getAttribute('data-group') || '';
    void patchSettings(buildPatch('feed.group', name));
  });
  emptyGroupAll?.addEventListener('click', () => {
    void patchSettings(buildPatch('feed.group', ''));
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
  applyTheme(view.settings?.ui?.theme);
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
    text: tCount('settingsExportDone', (data.channels || []).length),
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
      view.backupNotice = { text: formatBackupNotice(res?.error), error: true };
      view.importStage = 'idle';
    } else {
      if (res.state) applySnapshot(res.state);
      await applyI18n(view.settings?.ui?.locale);
      applyTheme(view.settings?.ui?.theme);
      const added = Number(res.added) || 0;
      const skipped = Number(res.skipped) || 0;
      const text = mode === 'replace'
        ? tCount('settingsImportReplaced', added)
        : tCount('settingsImportAdded', added, [String(added), String(skipped)]);
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

async function clearWatchlist() {
  if (view.importBusy) return;
  view.importBusy = true;
  view.backupNotice = null;
  render();
  try {
    const res = await send({ type: 'clearChannels' });
    if (!res || res.ok === false) {
      view.backupNotice = { text: formatError(res?.error), error: true };
    } else {
      if (res.state) applySnapshot(res.state);
      view.undo = null;
      view.clearOpen = false;
      view.backupNotice = { text: tCount('settingsCleared', Number(res.removed) || 0), error: false };
    }
  } catch (err) {
    view.backupNotice = { text: formatError(err?.message || err), error: true };
  } finally {
    view.importBusy = false;
    render();
  }
  // The confirm row and the Clear button are gone or disabled now, and a
  // backup import is the usual next step.
  if (!view.clearOpen) document.getElementById('settings-import')?.focus();
}

async function frontTabId() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const id = tabs?.[0]?.id;
    return id == null ? null : id;
  } catch {
    return null;
  }
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    return null;
  }
}

async function loadLastSelectedId() {
  try {
    const got = await chrome.storage.session.get(LAST_TAB_KEY);
    const id = got && got[LAST_TAB_KEY];
    return typeof id === 'number' && Number.isFinite(id) ? id : null;
  } catch {
    return null;
  }
}

async function saveLastSelectedId(id) {
  if (typeof id !== 'number' || !Number.isFinite(id)) return;
  try {
    await chrome.storage.session.set({ [LAST_TAB_KEY]: id });
  } catch {
    // session storage is best-effort
  }
}

async function queryYoutubeTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
    return Array.isArray(tabs) ? tabs : [];
  } catch {
    return [];
  }
}

async function refreshAudioState() {
  const ytTabs = await queryYoutubeTabs();
  const activeId = await frontTabId();
  const lastId = await loadLastSelectedId();
  const unreachable = [];
  const playerTabIds = [];
  const playerById = new Map();

  await Promise.all(ytTabs.map(async (tab) => {
    if (tab == null || tab.id == null) return;
    const res = await sendToTab(tab.id, { type: 'audioMode.player' });
    if (res == null) {
      unreachable.push(tab.id);
      return;
    }
    playerById.set(tab.id, res);
    if (res.ok && !Core.isWatchUrl(tab.url)) playerTabIds.push(tab.id);
  }));

  const decision = audioTabView({
    tabs: ytTabs,
    activeTabId: activeId,
    lastSelectedId: lastId,
    playerTabIds,
    unreachableIds: unreachable,
    core: Core,
  });

  let target = decision.target;
  if (view.audioTargetId != null) {
    const kept = decision.tabs.find((tab) => tab.id === view.audioTargetId);
    if (kept) target = kept;
  }

  // Only YouTube tabs show their URL to this extension, so any other focused
  // tab reads as none.
  const activeTab = ytTabs.find((tab) => tab && tab.id === activeId) || null;
  // "You're following …" belongs to the page it was said on.
  if ((activeTab?.url || '') !== (view.activeTab?.url || '')) {
    view.followOk = '';
    view.followError = '';
  }
  view.activeTab = activeTab;
  const activePlayer = playerById.get(activeId);
  view.activePage = activePlayer && activePlayer.ok ? activePlayer : null;

  view.audioKnown = true;
  view.audioTabs = decision.tabs;
  view.audioTargetId = target ? target.id : null;
  view.audioReachable = !!target;
  if (target) {
    const player = playerById.get(target.id);
    view.audioOn = !!(player && player.on);
    view.audioPlayer = player && player.ok ? player : null;
  } else {
    view.audioOn = false;
    view.audioPlayer = null;
  }
  syncAudioPolling();
  const players = [...playerById.values()];
  return {
    players,
    audioOn: players.some((p) => p && p.on),
  };
}

async function refreshPlayerCard() {
  if (!view.audioTargetId) return;
  const res = await sendToTab(view.audioTargetId, { type: 'audioMode.player' });
  // A collab list or an owner link can arrive after the popup opened; the
  // Follow card reads the same answer when it is about the focused tab.
  if (res && view.activeTab && view.activeTab.id === view.audioTargetId) {
    view.activePage = res.ok ? res : null;
  }
  if (res == null) {
    view.audioTargetId = null;
    await refreshAudioState();
  } else if (res.ok) {
    view.audioPlayer = res;
    view.audioOn = !!res.on;
    view.audioReachable = true;
  } else {
    view.audioPlayer = null;
    view.audioOn = !!res.on;
  }
  renderAudio();
}

async function selectAudioTab(id) {
  const tab = (view.audioTabs || []).find((row) => row.id === id);
  if (!tab) return;
  view.audioTargetId = id;
  await saveLastSelectedId(id);
  const res = await sendToTab(id, { type: 'audioMode.player' });
  if (res == null) {
    view.audioTargetId = null;
    await refreshAudioState();
  } else {
    view.audioPlayer = res.ok ? res : null;
    view.audioOn = !!res.on;
    view.audioReachable = true;
  }
  renderAudio();
}

async function controlTarget(action, extra = {}) {
  try {
    const id = view.audioTargetId;
    if (id == null) return;
    const res = await sendToTab(id, { type: 'audioMode.control', action, ...extra });
    if (res == null) {
      view.audioTargetId = null;
      await refreshAudioState();
      renderAudio();
      return;
    }
    await refreshPlayerCard();
  } finally {
    if (action === 'speed') audioSpeedPending = false;
    if (action === 'volume') audioVolumePending = false;
    if (action === 'sleep') audioSleepPending = false;
  }
}

async function refreshAudioStats() {
  try {
    const got = await chrome.storage.local.get('audioStats');
    view.audioStats = got && got.audioStats && typeof got.audioStats === 'object'
      ? got.audioStats
      : { listened: {}, active: {}, totals: { listened: 0, active: 0 } };
  } catch {
    view.audioStats = { listened: {}, active: {}, totals: { listened: 0, active: 0 } };
  }
}

async function refreshAudioCover() {
  try {
    const got = await chrome.storage.local.get(AUDIO_COVER_KEY);
    const raw = got && got[AUDIO_COVER_KEY];
    view.audioCover = isCoverDataUrl(raw) ? raw : '';
  } catch {
    view.audioCover = '';
  }
}

async function refreshRateNote() {
  try {
    const got = await chrome.storage.local.get(RATE_NOTE_KEY);
    view.rateNoteDone = !!(got && got[RATE_NOTE_KEY]);
  } catch {
    view.rateNoteDone = false;
  }
}

async function dismissRateNote() {
  // Persist the moment it changes. MV3 can kill the popup between a
  // memory write and a later batch.
  try {
    await chrome.storage.local.set({ [RATE_NOTE_KEY]: true });
  } catch {
    // hide this session even if the write failed
  }
  view.rateNoteDone = true;
}

let paintedCover = '';

function paintCoverPreview(dataUrl) {
  const canvas = document.getElementById('audio-cover-preview');
  if (!canvas) return;
  if (!isCoverDataUrl(dataUrl)) {
    paintedCover = '';
    canvas.hidden = true;
    return;
  }
  if (paintedCover === dataUrl) {
    canvas.hidden = false;
    return;
  }
  paintedCover = dataUrl;
  void (async () => {
    try {
      const blob = blobFromDataUrl(dataUrl);
      if (!blob) return;
      const bmp = await createImageBitmap(blob);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        bmp.close?.();
        return;
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const scale = Math.max(canvas.width / bmp.width, canvas.height / bmp.height);
      const dw = bmp.width * scale;
      const dh = bmp.height * scale;
      ctx.drawImage(bmp, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
      bmp.close?.();
      if (paintedCover === dataUrl) canvas.hidden = false;
    } catch {
      if (paintedCover === dataUrl) paintedCover = '';
    }
  })();
}

function blobFromDataUrl(dataUrl) {
  const comma = String(dataUrl).indexOf(',');
  if (comma < 0) return null;
  const header = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  const mime = (header.match(/^data:([^;,]+)/i) || [])[1] || 'application/octet-stream';
  let binary;
  try {
    binary = atob(payload);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function rasterToJpeg(bitmap, width, height, quality) {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (ctx && typeof canvas.convertToBlob === 'function') {
      ctx.drawImage(bitmap, 0, 0, width, height);
      return canvas.convertToBlob({ type: 'image/jpeg', quality });
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas');
  ctx.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('encode'));
    }, 'image/jpeg', quality);
  });
}

async function encodeCoverFile(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, key: 'settingsAudioCoverBad' };
  }
  const size = coverOutputSize(bitmap.width, bitmap.height);
  let quality = COVER_JPEG_QUALITY;
  try {
    for (let i = 0; i < 8; i++) {
      const blob = await rasterToJpeg(bitmap, size.width, size.height, quality);
      if (blob.size <= COVER_MAX_STORED_BYTES) {
        const dataUrl = await blobToDataUrl(blob);
        if (!isCoverDataUrl(dataUrl)) return { ok: false, key: 'settingsAudioCoverBad' };
        return { ok: true, dataUrl };
      }
      const next = nextCoverJpegQuality(quality, blob.size);
      if (typeof next !== 'number') return { ok: false, key: 'settingsAudioCoverTooHeavy' };
      quality = next;
    }
    return { ok: false, key: 'settingsAudioCoverTooHeavy' };
  } catch {
    return { ok: false, key: 'settingsAudioCoverBad' };
  } finally {
    bitmap.close?.();
  }
}

async function pickCoverFile(file) {
  if (!file) return;
  view.coverError = '';
  if (file.size > COVER_MAX_INPUT_BYTES) {
    view.coverError = t('settingsAudioCoverTooLarge');
    render();
    return;
  }
  const result = await encodeCoverFile(file);
  if (!result.ok) {
    view.coverError = t(result.key);
    render();
    return;
  }
  try {
    await chrome.storage.local.set({ [AUDIO_COVER_KEY]: result.dataUrl });
  } catch {
    view.coverError = t('settingsAudioCoverBad');
    render();
    return;
  }
  view.audioCover = result.dataUrl;
  render();
}

async function removeCover() {
  view.coverError = '';
  try {
    await chrome.storage.local.set({ [AUDIO_COVER_KEY]: '' });
  } catch {
    render();
    return;
  }
  view.audioCover = '';
  paintedCover = '';
  render();
}

async function refreshAudioShortcut() {
  try {
    const res = await send({ type: 'audioMode.shortcut' });
    const raw = res && res.shortcut;
    view.audioShortcut = typeof raw === 'string' ? raw.trim() : '';
    view.popupShortcut = typeof res?.popup === 'string' ? res.popup.trim() : '';
  } catch {
    view.audioShortcut = '';
    view.popupShortcut = '';
  }
}

async function toggleAudioMode() {
  const id = view.audioTargetId;
  if (id == null) {
    view.audioOn = false;
    renderAudio();
    return;
  }
  const res = await sendToTab(id, { type: 'audioMode.toggle' });
  view.audioKnown = true;
  if (res == null) {
    view.audioTargetId = null;
    await refreshAudioState();
  } else if (res.ok) {
    view.audioReachable = true;
    view.audioOn = !!res.on;
  }
  renderAudio();
}

function scheduleAudioDiscover() {
  if (audioDiscoverTimer) clearTimeout(audioDiscoverTimer);
  audioDiscoverTimer = setTimeout(() => {
    audioDiscoverTimer = null;
    void refreshAudioState().then(() => renderAudio());
  }, 80);
}

function bindAudio() {
  const toggle = document.getElementById('audio-toggle');
  toggle?.addEventListener('change', () => {
    void toggleAudioMode();
  });

  const panel = document.getElementById('audio');
  panel?.addEventListener('change', (event) => {
    const el = event.target;
    if (!(el instanceof HTMLElement)) return;
    if (el.id === 'audio-speed') {
      audioSpeedPending = true;
      void controlTarget('speed', { rate: Number(el.value) });
      return;
    }
    if (el.id === 'audio-volume') {
      audioVolumePending = true;
      void controlTarget('volume', { volume: Number(el.value) });
      return;
    }
    if (el.id === 'audio-sleep') {
      if (el.value === 'left') return;
      audioSleepPending = true;
      void controlTarget('sleep', { minutes: Number(el.value) });
      return;
    }
    const path = el.dataset.setting;
    if (!path) return;
    void patchSettings(buildPatch(path, el.value));
  });

  document.getElementById('audio-shortcut')?.addEventListener('click', () => {
    openUrl('chrome://extensions/shortcuts');
  });

  document.getElementById('audio-play')?.addEventListener('click', () => {
    const paused = !view.audioPlayer || view.audioPlayer.paused !== false;
    void controlTarget(paused ? 'play' : 'pause');
  });
  document.getElementById('audio-back')?.addEventListener('click', () => {
    const now = Number(view.audioPlayer?.currentTime) || 0;
    void controlTarget('seek', { time: Math.max(0, now - 10) });
  });
  document.getElementById('audio-forward')?.addEventListener('click', () => {
    const now = Number(view.audioPlayer?.currentTime) || 0;
    const dur = Number(view.audioPlayer?.duration) || 0;
    const next = now + 10;
    void controlTarget('seek', { time: dur > 0 ? Math.min(dur, next) : Math.max(0, next) });
  });

  const seek = document.getElementById('audio-seek');
  seek?.addEventListener('pointerdown', () => { audioSeeking = true; });
  document.addEventListener('pointerup', () => { audioSeeking = false; });
  document.addEventListener('pointercancel', () => { audioSeeking = false; });
  seek?.addEventListener('input', () => {
    audioSeeking = true;
    const shown = Number(seek.value);
    const elapsed = document.getElementById('audio-elapsed');
    if (elapsed) elapsed.textContent = Core.formatTime(shown);
    setSeekValueText(seek, shown, Number(seek.max));
  });
  seek?.addEventListener('change', () => {
    audioSeeking = false;
    void controlTarget('seek', { time: Number(seek.value) });
  });

  document.getElementById('audio-stats-month')?.addEventListener('click', () => {
    view.audioStatsScope = 'month';
    renderAudio();
  });
  document.getElementById('audio-stats-all')?.addEventListener('click', () => {
    view.audioStatsScope = 'all';
    renderAudio();
  });

  document.getElementById('audio-rate-yes')?.addEventListener('click', () => {
    void dismissRateNote().then(() => {
      openUrl(storeReviewsUrl(navigator.userAgent));
    });
  });
  document.getElementById('audio-rate-no')?.addEventListener('click', () => {
    void dismissRateNote().then(() => renderAudio());
  });

  document.getElementById('audio-queue')?.addEventListener('click', () => {
    const player = view.audioPlayer;
    const tab = (view.audioTabs || []).find((row) => row.id === view.audioTargetId);
    const videoId = (player && player.videoId)
      || (tab ? Core.videoIdFromUrl(tab.url) : '')
      || '';
    if (!videoId) return;
    const titleFromPlayer = player && player.title ? player.title : '';
    const titleFromTab = tab ? Core.tabTitleToVideoTitle(tab.title) : '';
    void toggleQueued({
      v: videoId,
      t: titleFromPlayer || titleFromTab || '',
      ct: (player && player.channel) || '',
    });
  });
  document.getElementById('queue-toggle')?.addEventListener('click', () => {
    toggleQueueOpen();
  });
  document.getElementById('queue-play')?.addEventListener('click', () => {
    void playQueue();
  });
  document.getElementById('queue-clear')?.addEventListener('click', () => {
    view.queueClearOpen = true;
    renderQueue();
    document.getElementById('queue-clear-no')?.focus();
  });
  document.getElementById('queue-clear-yes')?.addEventListener('click', () => {
    void clearQueued();
  });
  document.getElementById('queue-clear-no')?.addEventListener('click', () => {
    view.queueClearOpen = false;
    renderQueue();
    document.getElementById('queue-clear')?.focus();
  });

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes) return;
      let touched = false;
      if (changes.audioStats) {
        const next = changes.audioStats.newValue;
        view.audioStats = next && typeof next === 'object'
          ? next
          : { listened: {}, active: {}, totals: { listened: 0, active: 0 } };
        touched = true;
      }
      if (changes.audioCover) {
        const raw = changes.audioCover.newValue;
        view.audioCover = isCoverDataUrl(raw) ? raw : '';
        touched = true;
      }
      if (changes.rateNoteDone) {
        view.rateNoteDone = !!changes.rateNoteDone.newValue;
        touched = true;
      }
      // Seed writes the list and the feed after Follow / Add has already
      // returned. render() draws only the open tab; the others catch up
      // when they open.
      if (changes.channels && Array.isArray(changes.channels.newValue)) {
        view.channels = changes.channels.newValue;
        touched = true;
      }
      if (changes.feed && Array.isArray(changes.feed.newValue)) {
        view.feed = changes.feed.newValue;
        touched = true;
      }
      if (changes.pollState && changes.pollState.newValue && typeof changes.pollState.newValue === 'object') {
        view.pollState = changes.pollState.newValue;
        touched = true;
      }
      if (touched) render();
    });
  } catch {
    // ignore
  }

  try {
    chrome.tabs.onRemoved.addListener(scheduleAudioDiscover);
    chrome.tabs.onCreated.addListener(scheduleAudioDiscover);
    chrome.tabs.onUpdated.addListener((_id, change) => {
      if (!change) return;
      if (
        change.url !== undefined
        || change.title !== undefined
        || change.audible !== undefined
        || change.status === 'complete'
      ) {
        scheduleAudioDiscover();
      }
    });
  } catch {
    // ignore
  }
}

function bindLookSettings() {
  for (const btn of document.querySelectorAll('.swatch[data-preset]')) {
    btn.addEventListener('click', () => {
      const name = btn.dataset.preset;
      if (!name) return;
      void patchSettings({ audio: { preset: name, backgroundType: 'color' } });
    });
  }

  document.getElementById('audio-custom-color')?.addEventListener('change', (event) => {
    const el = event.target;
    if (!(el instanceof HTMLInputElement)) return;
    void patchSettings({
      audio: { preset: 'custom', customColor: el.value, backgroundType: 'color' },
    });
  });

  document.getElementById('audio-cover-choose')?.addEventListener('click', () => {
    document.getElementById('audio-cover-file')?.click();
  });
  document.getElementById('audio-cover-file')?.addEventListener('change', (event) => {
    const el = event.target;
    if (!(el instanceof HTMLInputElement)) return;
    const file = el.files && el.files[0];
    el.value = '';
    void pickCoverFile(file);
  });
  document.getElementById('audio-cover-remove')?.addEventListener('click', () => {
    void removeCover();
  });
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
    // Checked before reading: file.text() on a wrong pick of several hundred
    // MB would hold the popup until it is killed.
    const tooLarge = backupSizeError(file.size);
    if (tooLarge) {
      view.pendingImportText = '';
      view.importStage = 'idle';
      view.backupNotice = { text: formatBackupNotice(tooLarge), error: true };
      render();
      return;
    }
    try {
      view.pendingImportText = await file.text();
      view.importStage = 'choose';
      view.clearOpen = false;
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

  document.getElementById('settings-clear').addEventListener('click', () => {
    view.clearOpen = true;
    view.importStage = 'idle';
    view.pendingImportText = '';
    view.backupNotice = null;
    render();
    document.getElementById('settings-clear-cancel')?.focus();
  });
  document.getElementById('settings-clear-yes').addEventListener('click', () => {
    void clearWatchlist();
  });
  document.getElementById('settings-clear-cancel').addEventListener('click', () => {
    view.clearOpen = false;
    render();
    document.getElementById('settings-clear')?.focus();
  });
}

function clearWatchlistQuery() {
  const input = document.getElementById('watchlist-input');
  if (!input || !input.value) return;
  input.value = '';
  view.error = '';
  view.ok = '';
  render();
  input.focus();
}

function bindWatchlist() {
  const form = document.getElementById('watchlist-add-form');
  const input = document.getElementById('watchlist-input');
  const clear = document.getElementById('watchlist-clear');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitAdd(input.value);
  });
  input.addEventListener('input', () => {
    view.error = '';
    view.ok = '';
    render();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!input.value) return;
    event.preventDefault();
    clearWatchlistQuery();
  });
  clear.addEventListener('click', () => {
    clearWatchlistQuery();
  });
  document.getElementById('watchlist-undo-btn').addEventListener('click', () => {
    void undoRemove();
  });
  const more = document.getElementById('watchlist-more');
  more.addEventListener('click', () => {
    const first = watchlistLimit;
    showMoreWatchlist();
    // A keyboard press lands on the first new row, not back at the button.
    document.getElementById('watchlist-list').children[first]?.querySelector('.channel-row__main')?.focus();
  });
  new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting) && !more.hidden) showMoreWatchlist();
  }, { rootMargin: '300px' }).observe(more);
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
  document.getElementById('channel-sheet-retry')?.addEventListener('click', () => {
    if (!view.sheetId) return;
    void requestSweep({ onlyId: view.sheetId });
  });
  sheet?.addEventListener('click', (event) => {
    if (event.target === sheet) closeChannelSheet();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') {
      trapSheetTab(event);
      return;
    }
    if (event.key !== 'Escape') return;
    if (closeAllMenus({ restoreFocus: true })) {
      event.preventDefault();
      return;
    }
    if (view.supportOpen) {
      event.preventDefault();
      closeSupportSheet();
      return;
    }
    if (view.groupsSheetId) {
      // Escape backs out of a rename or a delete confirm first; only a
      // second press closes the sheet.
      if (view.groupEdit || view.groupConfirm) {
        const name = view.groupEdit || view.groupConfirm;
        event.preventDefault();
        view.groupEdit = '';
        view.groupConfirm = '';
        groupRenameDraft = { name: '', value: '' };
        render();
        focusGroupRow(name);
        return;
      }
      event.preventDefault();
      closeGroupsSheet();
      return;
    }
    if (!view.sheetId) return;
    event.preventDefault();
    closeChannelSheet();
  });
}

function bindGroupsSheet() {
  const sheet = document.getElementById('groups-sheet');
  document.getElementById('groups-sheet-close')?.addEventListener('click', () => {
    closeGroupsSheet();
  });
  document.getElementById('groups-sheet-new')?.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitNewGroup();
  });
  sheet?.addEventListener('click', (event) => {
    if (event.target === sheet) closeGroupsSheet();
  });
}

async function submitNewGroup() {
  const input = document.getElementById('groups-sheet-input');
  const id = view.groupsSheetId;
  const name = normalizeGroupName(input?.value || '');
  if (!id || !name) return;
  view.groupsError = '';
  await applyGroup(id, name, true);
  if (!view.groupsError && input) input.value = '';
}

function bindSupportSheet() {
  document.getElementById('support-sheet-close')?.addEventListener('click', () => {
    closeSupportSheet();
  });
  document.getElementById('support-sheet')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeSupportSheet();
  });
  document.getElementById('appbar-support')?.addEventListener('click', (event) => {
    openSupportSheet(event.currentTarget);
  });
  document.getElementById('settings-keys-change')?.addEventListener('click', () => {
    openUrl('chrome://extensions/shortcuts');
  });
  document.getElementById('settings-support-open')?.addEventListener('click', (event) => {
    openSupportSheet(event.currentTarget);
  });
  document.getElementById('settings-whats-new')?.addEventListener('click', () => {
    openWhatsNew();
  });
  document.getElementById('whats-new-open')?.addEventListener('click', () => {
    openWhatsNew();
  });
  document.getElementById('whats-new-close')?.addEventListener('click', () => {
    void markWhatsNewSeen();
  });
}

// The YouTube tab takes focus and shows the scan. Closing here does not
// cancel the worker; the popup would only cover that tab.
function bindImportFromYouTube() {
  for (const btn of document.querySelectorAll('[data-import-youtube]')) {
    btn.addEventListener('click', () => {
      send({ type: 'importFromYouTube' }).catch(() => {});
      window.close();
    });
  }
}

document.addEventListener('click', closeAllMenus);

bindImportFromYouTube();
bindWatchlist();
bindFeeds();
bindAudio();
bindLookSettings();
bindSettings();
bindChannelSheet();
bindGroupsSheet();
bindSupportSheet();

void (async () => {
  await applyI18n('auto');
  view.busy = true;
  render();
  const probe = refreshAudioState().then(
    (r) => r || { players: [], audioOn: false },
    () => ({ players: [], audioOn: false }),
  );
  let opening = 'feeds';
  try {
    await migrateAudioCover();
    const snap = await send({ type: 'popupOpened' });
    if (!applySnapshot(snap)) view.error = formatError(snap?.error);
    // popupOpened overwrites lastSeenAt; the previous value rides on
    // previousLastSeenAt. A reply without that field never overwrote it.
    view.feedSeenAt = Object.prototype.hasOwnProperty.call(snap || {}, 'previousLastSeenAt')
      ? Number(snap.previousLastSeenAt) || 0
      : Number(snap?.pollState?.lastSeenAt) || 0;
    await applyI18n(view.settings?.ui?.locale);
    applyTheme(view.settings?.ui?.theme);
    const winner = await Promise.race([
      probe.then((r) => ({ kind: 'probe', r })),
      new Promise((resolve) => {
        setTimeout(() => resolve({ kind: 'timeout' }), OPENING_TAB_MS);
      }),
    ]);
    if (winner.kind === 'probe') opening = openingTab(winner.r);
    if (!openingChosen) {
      const tab = document.getElementById(`tab-${opening}`)
        || document.getElementById('tab-feeds');
      if (tab) activate(tab);
    }
    await Promise.all([
      refreshAudioShortcut(),
      refreshAudioStats(),
      refreshAudioCover(),
      refreshRateNote(),
    ]);
  } catch (err) {
    view.error = formatError(err?.message || err);
    if (!openingChosen) {
      const tab = document.getElementById('tab-feeds');
      if (tab) activate(tab);
    }
  } finally {
    view.busy = false;
    revealOpen();
    render();
  }
  void probe.then(() => {
    if (openTabName() === 'audio') renderAudio();
  });
})();
