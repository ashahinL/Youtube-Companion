/**
 * Background service worker.
 *
 * Owns all network, alarms, notifications and the badge. The popup and
 * the channel window never fetch — they ask this file and render.
 */

import {
  resolveChannelId,
  searchChannels,
  fetchChannelFeed,
  fetchChannelHeader,
  fetchChannelVideos,
  classifyVideo,
} from '../lib/yt.js';
import { readSettings, writeSettings, onSettingsChanged } from '../lib/settings.js';
import { parseBackup, mergeBackup } from '../lib/backup.js';
import { resolveLocale, loadMessages, translate } from '../lib/i18n.js';
import {
  readChannels,
  writeChannels,
  addChannel,
  updateChannel,
  removeChannel,
  setFavorite,
  readFeed,
  saveFeed,
  applyFeedMerge,
  newSinceCount,
  readVideoMeta,
  saveVideoMeta,
  putVideoMeta,
  pendingLiveIds,
  readPollState,
  writePollState,
  markNotified,
  hasNotified,
} from '../lib/store.js';

const ALARM_ALL = 'poll-all';
const ALARM_FAV = 'poll-fav';
const BADGE_COLOR = '#cc0000';
const EXT_ICON = 'icons/icon128.png';

// Innertube POSTs from the worker carry Origin: chrome-extension://… and
// YouTube 403s that Origin. Fetch cannot override it; this rule can.
const YT_ORIGIN_RULE_ID = 1;

// Politeness pause between channel fetches — not a rate limit YouTube published.
const CHANNEL_FETCH_DELAY_MS = 250;

// In-memory latch so two overlapping calls in the same worker cannot both
// pass the storage read. The durable twin is pollState.running.
let sweepActive = false;

const notificationVideos = new Map();

// Asking again for a channel that already has a window must focus it.
// Two windows on the same cid would fight over refresh.
/* Which channel each open window is showing, keyed by channel id.
 * This lives in chrome.storage.session rather than a module variable because
 * the worker is killed without warning: a map held in memory is gone by the
 * time the user clicks the same channel again, and they would get a second
 * window. Session storage survives that and is cleared on browser restart,
 * by which time no window it described still exists. */
const CHANNEL_WINDOWS_KEY = 'channelWindows';

async function readChannelWindows() {
  const area = chromeApi().storage?.session;
  if (!area) return {};
  const got = await area.get(CHANNEL_WINDOWS_KEY);
  const map = got?.[CHANNEL_WINDOWS_KEY];
  return map && typeof map === 'object' ? map : {};
}

async function writeChannelWindows(map) {
  const area = chromeApi().storage?.session;
  if (!area) return;
  await area.set({ [CHANNEL_WINDOWS_KEY]: map });
}

function chromeApi() {
  return globalThis.chrome;
}

function ytOpts() {
  return { fetch: globalThis.fetch };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errMessage(err) {
  return String(err?.message || err);
}

function watchUrl(videoId, kind) {
  if (kind === 'short') return `https://www.youtube.com/shorts/${videoId}`;
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function newestOf(items) {
  let best = null;
  for (const item of items) {
    if (!item) continue;
    if (!best) {
      best = item;
      continue;
    }
    const atA = Number(item.at) || 0;
    const atB = Number(best.at) || 0;
    if (atA > atB) best = item;
    else if (atA === atB && String(item.v) < String(best.v)) best = item;
  }
  return best;
}

function newestAt(feed, channelId) {
  let max = 0;
  for (const item of feed || []) {
    if (item && item.c === channelId) {
      const at = Number(item.at) || 0;
      if (at > max) max = at;
    }
  }
  return max;
}

/* Chrome's own lookup follows the browser language, which would leave a user
 * who chose Arabic with an Arabic interface and English alerts. The worker
 * resolves the same setting the interface does. */
async function nNewVideosText(n, settings) {
  const locale = resolveLocale(settings?.ui?.locale, globalThis.navigator?.language);
  try {
    const map = await loadMessages(locale);
    const text = translate(map, 'nNewVideos', [String(n)]);
    if (text && text !== 'nNewVideos') return text;
  } catch {
    // A missing or unreadable message file must not cost the user the alert.
  }
  const fallback = chromeApi()?.i18n?.getMessage?.('nNewVideos', [String(n)]);
  return fallback || `${n} new videos`;
}

function iconUrlFor(channel, settings) {
  if (settings.alerts.useAvatarIcon && channel?.avatar) return channel.avatar;
  return chromeApi().runtime.getURL(EXT_ICON);
}

function notificationIdFor(channelId) {
  return `yt:${channelId}`;
}

/**
 * MV3 can kill the worker between raising and lowering this flag, and
 * storage.local survives the restart. A stranded true would block polling
 * forever.
 */
export async function reconcileRunning() {
  await writePollState({ running: false });
}

let originRulePromise = null;

/**
 * Rewrite Origin/Referer on this extension's own youtube.com requests so
 * they look like they came from the site. initiatorDomains keeps the
 * user's YouTube tabs untouched.
 */
export function ensureYtOriginRule() {
  if (originRulePromise) return originRulePromise;
  originRulePromise = installYtOriginRule().catch((err) => {
    originRulePromise = null;
    throw err;
  });
  return originRulePromise;
}

async function installYtOriginRule() {
  const dnr = chromeApi().declarativeNetRequest;
  const id = chromeApi().runtime?.id;
  if (!dnr?.updateDynamicRules || !id) return;
  await dnr.updateDynamicRules({
    removeRuleIds: [YT_ORIGIN_RULE_ID],
    addRules: [
      {
        id: YT_ORIGIN_RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Origin', operation: 'set', value: 'https://www.youtube.com' },
            { header: 'Referer', operation: 'set', value: 'https://www.youtube.com/' },
          ],
        },
        condition: {
          initiatorDomains: [id],
          requestDomains: ['www.youtube.com'],
          resourceTypes: ['xmlhttprequest', 'other'],
        },
      },
    ],
  });
}

export async function syncAlarms() {
  const settings = await readSettings();
  const alarms = chromeApi().alarms;
  await alarms.clear(ALARM_ALL);
  await alarms.clear(ALARM_FAV);
  if (!settings.poll.enabled) return;
  await alarms.create(ALARM_ALL, { periodInMinutes: settings.poll.intervalMinutes });
  if (settings.poll.favoriteIntervalMinutes > 0) {
    await alarms.create(ALARM_FAV, {
      periodInMinutes: settings.poll.favoriteIntervalMinutes,
    });
  }
}

export async function refreshBadge() {
  const [settings, feed, poll] = await Promise.all([
    readSettings(),
    readFeed(),
    readPollState(),
  ]);
  const n = newSinceCount(feed, poll.lastSeenAt, settings.feed.showShorts);
  const text = n > 0 ? String(n) : '';
  await chromeApi().action.setBadgeText({ text });
}

async function collectState() {
  const [settings, channels, feed, pollState] = await Promise.all([
    readSettings(),
    readChannels(),
    readFeed(),
    readPollState(),
  ]);
  return { settings, channels, feed, pollState };
}

function pickChannels(channels, { scope, onlyId }) {
  if (onlyId) return channels.filter((ch) => ch.id === onlyId);
  if (scope === 'favorites') return channels.filter((ch) => ch.favorite);
  return channels.slice();
}

async function classifyIds(ids, videoMeta, fetchImpl, atById) {
  let meta = videoMeta;
  for (const id of ids) {
    try {
      const cls = await classifyVideo(id, { fetch: fetchImpl });
      const at = atById.get(id);
      const rec = { k: cls.k, d: cls.d, st: cls.st };
      if (Number.isFinite(at)) rec.at = at;
      else if (Number.isFinite(meta[id]?.at)) rec.at = meta[id].at;
      meta = putVideoMeta(meta, { [id]: rec });
    } catch {
      // Leave it out of videoMeta so the next sweep retries this id.
    }
  }
  return meta;
}

function itemFromEntry(entry, channelId, rec) {
  return {
    v: entry.v,
    c: channelId,
    t: entry.title,
    at: entry.at,
    d: rec.d ?? 0,
    vw: entry.views ?? 0,
    k: rec.k,
    st: rec.st ?? 0,
  };
}

function shouldNotifyItem(item, channel, settings, poll) {
  if (!settings.alerts.enabled) return false;
  if (item.k === 'short' && !settings.feed.showShorts) return false;
  if (hasNotified(poll, item.v)) return false;
  if (channel?.favorite) return true;
  return !!settings.alerts.notifyNormal;
}

async function notifyChannel(channel, items, settings) {
  const newest = newestOf(items);
  if (!newest) return;
  const title = channel.title || channel.handle || channel.id;
  const message = items.length === 1 ? newest.t : await nNewVideosText(items.length, settings);
  const id = notificationIdFor(channel.id);
  notificationVideos.set(id, newest.v);
  await chromeApi().notifications.create(id, {
    type: 'basic',
    iconUrl: iconUrlFor(channel, settings),
    title,
    message,
  });
}

async function notifyNewItems({ added, channels, unseeded, settings }) {
  let poll = await readPollState();
  const byId = new Map(channels.map((ch) => [ch.id, ch]));

  const seedIds = [];
  for (const item of added) {
    if (unseeded.has(item.c)) seedIds.push(item.v);
  }
  if (seedIds.length) {
    // First fetch backfills up to 15 videos. Mark them notified without
    // alerting, or adding a batch of channels would spam the desktop.
    poll = markNotified(poll, seedIds);
  }

  const gated = [];
  for (const item of added) {
    if (unseeded.has(item.c)) continue;
    if (!shouldNotifyItem(item, byId.get(item.c), settings, poll)) continue;
    gated.push(item);
  }

  const byChannel = new Map();
  for (const item of gated) {
    const list = byChannel.get(item.c) || [];
    list.push(item);
    byChannel.set(item.c, list);
  }

  const alerted = [];
  for (const [channelId, items] of byChannel) {
    const channel = byId.get(channelId);
    if (!channel) continue;
    await notifyChannel(channel, items, settings);
    for (const item of items) alerted.push(item.v);
  }
  if (alerted.length) poll = markNotified(poll, alerted);

  if (seedIds.length || alerted.length) {
    await writePollState({ notified: poll.notified });
  }
}

async function performSweep({ scope, onlyId }) {
  const settings = await readSettings();
  const fetchImpl = globalThis.fetch;
  const allChannels = await readChannels();
  const list = pickChannels(allChannels, { scope, onlyId });
  const unseeded = new Set(list.filter((ch) => !ch.seeded).map((ch) => ch.id));
  const succeeded = [];
  const incoming = [];

  for (let i = 0; i < list.length; i++) {
    if (i > 0) await sleep(CHANNEL_FETCH_DELAY_MS);
    const ch = list[i];
    try {
      const parsed = await fetchChannelFeed(ch.id, { fetch: fetchImpl });
      await updateChannel(ch.id, { lastError: null, lastFetchAt: Date.now() });
      succeeded.push({ channel: ch, entries: parsed.entries || [] });
    } catch (err) {
      await updateChannel(ch.id, {
        lastError: { at: Date.now(), message: errMessage(err) },
      });
    }
  }

  let videoMeta = await readVideoMeta();
  const atById = new Map();
  const toClassify = new Set();
  for (const { entries } of succeeded) {
    for (const entry of entries) {
      if (!entry?.v) continue;
      if (Number.isFinite(entry.at)) atById.set(entry.v, entry.at);
      if (!videoMeta[entry.v]) toClassify.add(entry.v);
    }
  }
  for (const id of pendingLiveIds(videoMeta)) toClassify.add(id);

  videoMeta = await classifyIds([...toClassify], videoMeta, fetchImpl, atById);
  await saveVideoMeta(videoMeta);

  const feedNow = await readFeed();
  const feedByV = new Map(feedNow.map((item) => [item.v, item]));
  const incomingIds = new Set();

  for (const { channel, entries } of succeeded) {
    for (const entry of entries) {
      const rec = videoMeta[entry.v];
      if (!rec || !rec.k) continue;
      incoming.push(itemFromEntry(entry, channel.id, rec));
      incomingIds.add(entry.v);
    }
  }

  // Live/premiere rows that settled this pass but dropped off the RSS
  // window still need their feed row updated.
  for (const [id, rec] of Object.entries(videoMeta)) {
    if (!rec || rec.k === 'live' || rec.k === 'premiere') continue;
    if (incomingIds.has(id)) continue;
    const existing = feedByV.get(id);
    if (!existing) continue;
    if (existing.k === rec.k && existing.d === rec.d && existing.st === rec.st) continue;
    incoming.push({ ...existing, k: rec.k, d: rec.d, st: rec.st });
  }

  const { feed, added } = await applyFeedMerge(incoming, settings.feed.maxItems);

  for (const { channel } of succeeded) {
    const patch = { lastVideoAt: newestAt(feed, channel.id) };
    if (unseeded.has(channel.id)) patch.seeded = true;
    await updateChannel(channel.id, patch);
  }

  const channels = await readChannels();
  await notifyNewItems({ added, channels, unseeded, settings });

  const now = Date.now();
  if (!onlyId) {
    if (scope === 'favorites') await writePollState({ lastFavPollAt: now });
    else await writePollState({ lastPollAt: now });
  }

  await refreshBadge();
  return { ok: true, added: added.length };
}

/**
 * One worker, one sweep. Overlapping passes would both treat the same
 * upload as new and fire duplicate alerts.
 */
export async function runSweep({ scope = 'all', onlyId = null } = {}) {
  await ensureYtOriginRule().catch(() => {});
  if (sweepActive) return { ok: false, error: 'already running' };
  sweepActive = true;
  try {
    const state = await readPollState();
    if (state.running) return { ok: false, error: 'already running' };
    // Persist running the moment it changes. Batching it with a later write
    // is how a kill leaves the flag stuck on.
    await writePollState({ running: true });
    try {
      return await performSweep({ scope, onlyId });
    } finally {
      await writePollState({ running: false });
    }
  } finally {
    sweepActive = false;
  }
}

export async function addChannelByInput(input) {
  const id = await resolveChannelId(input, ytOpts());
  if (!id) return { ok: false, error: 'not a channel' };
  const existing = (await readChannels()).find((ch) => ch.id === id);
  if (existing) return { ok: false, error: 'already added', id };
  const header = await fetchChannelHeader(id, ytOpts());
  const { added } = await addChannel({
    id,
    handle: header.handle || '',
    title: header.title || '',
    avatar: header.avatar || '',
  });
  if (!added) return { ok: false, error: 'already added', id };
  try {
    await runSweep({ scope: 'all', onlyId: id });
  } catch {
    // The channel is already stored. A failed seed must not look like
    // "could not add" — the next poll retries it.
  }
  const channel = (await readChannels()).find((ch) => ch.id === id);
  return { ok: true, channel };
}

export async function onChannelWindowRemoved(windowId) {
  const map = await readChannelWindows();
  let changed = false;
  for (const [cid, wid] of Object.entries(map)) {
    if (wid === windowId) {
      delete map[cid];
      changed = true;
    }
  }
  if (changed) await writeChannelWindows(map);
}

export async function openChannelWindow(id) {
  const cid = String(id || '').trim();
  if (!cid) return { ok: false, error: 'missing id' };

  const map = await readChannelWindows();
  const existing = map[cid];
  if (existing != null) {
    try {
      await chromeApi().windows.update(existing, { focused: true });
      return { ok: true, windowId: existing };
    } catch {
      // The window is gone and we were never told, so forget it and open anew.
      delete map[cid];
      await writeChannelWindows(map);
    }
  }

  const settings = await readSettings();
  const win = await chromeApi().windows.create({
    url: `src/channel/channel.html?cid=${encodeURIComponent(cid)}`,
    type: 'popup',
    width: settings.channelWindow.width,
    height: settings.channelWindow.height,
  });
  if (win && win.id != null) {
    map[cid] = win.id;
    await writeChannelWindows(map);
  }
  return { ok: true, windowId: win?.id };
}

export async function handleMessage(msg, _sender) {
  try {
    await ensureYtOriginRule().catch(() => {});
    const type = msg && msg.type;
    switch (type) {
      case 'getState':
        return await collectState();
      case 'popupOpened': {
        await writePollState({ lastSeenAt: Date.now() });
        await refreshBadge();
        return await collectState();
      }
      case 'sweep':
        return await runSweep({ scope: msg.scope || 'all' });
      case 'searchChannels': {
        const results = await searchChannels(String(msg.query ?? ''), ytOpts());
        const ids = new Set((await readChannels()).map((ch) => ch.id));
        return results.map((r) => ({ ...r, inList: ids.has(r.id) }));
      }
      case 'addChannel':
        return await addChannelByInput(msg.input);
      case 'removeChannel': {
        await removeChannel(msg.id);
        await refreshBadge();
        return { ok: true };
      }
      case 'setFavorite': {
        await setFavorite(msg.id, msg.on);
        await syncAlarms();
        return { ok: true };
      }
      case 'getChannelVideos':
        return await fetchChannelVideos(msg.id, {
          ...ytOpts(),
          continuation: msg.continuation,
        });
      case 'openChannelWindow':
        return await openChannelWindow(msg.id);
      case 'updateSettings': {
        // Alarms and the badge both derive from settings (poll periods,
        // showShorts). Writing storage from the popup would leave them stale.
        await writeSettings(msg.patch || {});
        await syncAlarms();
        await refreshBadge();
        return await collectState();
      }
      case 'importBackup': {
        const raw = msg.data;
        let text;
        if (typeof raw === 'string') text = raw;
        else {
          try {
            text = JSON.stringify(raw ?? null);
          } catch {
            return { ok: false, error: 'That file is not valid JSON.' };
          }
        }
        const parsed = parseBackup(text);
        if (!parsed.ok) return { ok: false, error: parsed.error };
        const current = await collectState();
        const mode = msg.mode === 'replace' ? 'replace' : 'merge';
        const result = mergeBackup(
          { settings: current.settings, channels: current.channels },
          parsed.data,
          mode,
        );
        await writeSettings(result.settings);
        await writeChannels(result.channels);
        // The file has no feed. Rows whose channel is gone would otherwise
        // keep showing until something else dropped them.
        const keep = new Set(result.channels.map((ch) => ch.id));
        const feed = (await readFeed()).filter((item) => keep.has(item.c));
        await saveFeed(feed);
        await syncAlarms();
        await refreshBadge();
        return {
          ok: true,
          added: result.added,
          skipped: result.skipped,
          state: await collectState(),
        };
      }
      default:
        return { ok: false, error: 'unknown message' };
    }
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
}

async function onNotificationClicked(id) {
  const v = notificationVideos.get(id);
  if (!v) return;
  const feed = await readFeed();
  const item = feed.find((row) => row.v === v);
  await chromeApi().tabs.create({ url: watchUrl(v, item?.k), active: true });
}

function onAlarm(alarm) {
  if (alarm?.name === ALARM_ALL) runSweep({ scope: 'all' }).catch(() => {});
  else if (alarm?.name === ALARM_FAV) runSweep({ scope: 'favorites' }).catch(() => {});
}

function onBoot() {
  ensureYtOriginRule().catch(() => {});
  reconcileRunning().then(syncAlarms).catch(() => {});
}

chromeApi().runtime.onInstalled.addListener(onBoot);
chromeApi().runtime.onStartup.addListener(onBoot);
chromeApi().alarms.onAlarm.addListener(onAlarm);
chromeApi().notifications.onClicked.addListener((id) => {
  onNotificationClicked(id).catch(() => {});
});
chromeApi().runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Keep the worker alive until sendResponse runs — MV3 drops the reply
  // otherwise.
  handleMessage(message, sender).then(sendResponse, (err) => {
    sendResponse({ ok: false, error: errMessage(err) });
  });
  return true;
});
onSettingsChanged(() => {
  syncAlarms().catch(() => {});
});
chromeApi().windows.onRemoved.addListener((windowId) => {
  void onChannelWindowRemoved(windowId);
});
chromeApi().action.setBadgeBackgroundColor({ color: BADGE_COLOR });

export const ready = Promise.all([
  reconcileRunning().catch(() => {}),
  ensureYtOriginRule().catch(() => {}),
]);
