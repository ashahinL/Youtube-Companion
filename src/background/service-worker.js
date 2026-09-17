/**
 * Background service worker.
 *
 * Owns all network, alarms, notifications, the badge, and the audio-mode
 * keyboard command. The popup never fetches — it asks this file and renders.
 */

import {
  YtError,
  normalizeChannelInput,
  normalizeVideoInput,
  resolveChannelId,
  fetchLatestUploads,
  fetchChannelHeader,
  classifyVideo,
  isPushback,
  isInnertubeForbidden,
  isAvatarUrl,
} from '../lib/yt.js';
import { readSettings, writeSettings, onSettingsChanged, migrateAudioCover } from '../lib/settings.js';
import { parseBackup, mergeBackup } from '../lib/backup.js';
import { parseTakeoutCsv, MAX_TAKEOUT_CHANNELS } from '../lib/takeout.js';
import { resolveLocale, loadMessages, translateCount } from '../lib/i18n.js';
import {
  readChannels,
  writeChannels,
  addChannel,
  updateChannels,
  removeChannel,
  setFavorite,
  setMuted,
  setChannelGroup,
  readFeed,
  saveFeed,
  mergeFeedItems,
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
  backoffDelayMs,
  isSameListing,
} from '../lib/store.js';
import { feedChannelIds } from '../lib/view.js';

const OVERLAY_MESSAGE_KEYS = ['overlayTitle', 'overlayExit', 'overlayExitShortcut'];

const ALARM_ALL = 'poll-all';
const ALARM_FAV = 'poll-fav';
// The icon's deep purple; Chrome's white badge text sits on it at 6.7:1.
const BADGE_COLOR = '#5b3fd6';
const EXT_ICON = 'icons/icon128.png';
const AUDIO_TOGGLE_COMMAND = 'toggle-audio-mode';
// Chrome opens the popup for this one itself; it never reaches onCommand.
const POPUP_COMMAND = '_execute_action';

// Innertube POSTs from the worker carry Origin: chrome-extension://… and
// YouTube 403s that Origin. Fetch cannot override it; this rule can.
const YT_ORIGIN_RULE_ID = 1;

// YouTube publishes no rate limit. Three requests at a time, with a pause
// between channel fetches in each lane, is a choice, not a measured ceiling.
const LANES = 3;
const CHANNEL_FETCH_DELAY_MS = 250;

// A channel imported from a file has a name but no picture or handle, and
// filling one in is a Videos-tab browse of about 35 KB. A few per check keeps
// an import of hundreds from doubling the requests of the checks after it.
const HEADER_FILLS_PER_SWEEP = 10;
const HEADER_RETRY_MS = 24 * 60 * 60_000;

// Chrome stops a worker after 30 seconds without an event or an extension
// API call, and a fetch in flight is neither. A check of hundreds of channels
// runs for minutes, so it makes a trivial API call more often than that.
const KEEPALIVE_MS = 25_000;

const WELCOME_PAGE = 'src/welcome/welcome.html';
const UNINSTALL_PAGE = 'https://ashahinl.github.io/Youtube-Companion/uninstall.html';

// The content script shares a renderer with youtube.com, so it is the sender
// a compromised page would speak as. It needs these two and nothing else;
// anything that reads or changes stored data must come from an extension page.
const CONTENT_SCRIPT_MESSAGES = new Set(['audioMode.boot', 'audioMode.shortcut']);

// In-memory latch so two overlapping calls in the same worker cannot both
// pass the storage read. The durable twin is pollState.running.
let sweepActive = false;

// A poll-all or poll-fav that fired while another sweep was in flight.
// Memory only: a killed worker just waits for the next period.
let skippedScheduled = null;
let activeCoverage = null;

// Channel ids added while a check is running, or after Add replies and
// before their silent seed. One follow-up sweep covers the whole set.
const pendingSeeds = new Set();
let seeding = false;

function sweepCoverage({ scope, onlyId, onlyIds }) {
  if (onlyId || (onlyIds && onlyIds.length)) return 'partial';
  return scope === 'favorites' ? 'favorites' : 'all';
}

function scheduledCoveredBy(running, incoming) {
  if (running === 'all') return incoming === 'all' || incoming === 'favorites';
  return running === incoming;
}

function rememberSkipped(scope) {
  if (scope === 'all') skippedScheduled = 'all';
  else if (scope === 'favorites' && skippedScheduled !== 'all') skippedScheduled = 'favorites';
}

// Fast path for the video that was announced. MV3 kills the worker shortly
// after idle, so the click handler must also rebuild from storage.
const notificationVideos = new Map();

// The tab starts loading as soon as tabs.create returns, so a very
// fast content-script boot could ask before the flag exists.
let audioOpenInFlight = Promise.resolve();

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

function overlayPackFrom(map) {
  const pack = {};
  for (const key of OVERLAY_MESSAGE_KEYS) {
    pack[key] = map && typeof map[key] === 'string' ? map[key] : '';
  }
  return pack;
}

async function overlayStringsForSettings(settings) {
  // Both languages go in the reply so a language change while the tab is
  // open can still switch overlay copy, the way a refetch of messages.json
  // used to.
  const locale = resolveLocale(settings?.ui?.locale, globalThis.navigator?.language);
  let en = overlayPackFrom(null);
  let ar = overlayPackFrom(null);
  try { en = overlayPackFrom(await loadMessages('en')); } catch { /* empty */ }
  try { ar = overlayPackFrom(await loadMessages('ar')); } catch { /* empty */ }
  const overlays = { en, ar };
  return { locale, overlay: locale === 'ar' ? ar : en, overlays };
}

/* Chrome's own lookup follows the browser language, which would leave a user
 * who chose Arabic with an Arabic interface and English alerts. The worker
 * resolves the same setting the interface does. */
async function nNewVideosText(n, settings) {
  const locale = resolveLocale(settings?.ui?.locale, globalThis.navigator?.language);
  try {
    const map = await loadMessages(locale);
    const text = translateCount(map, 'nNewVideos', n);
    if (text && text !== 'nNewVideos' && text !== 'nNewVideosOne') return text;
  } catch {
    // A missing or unreadable message file must not cost the user the alert.
  }
  const key = Number(n) === 1 ? 'nNewVideosOne' : 'nNewVideos';
  const fallback = chromeApi()?.i18n?.getMessage?.(key, [String(n)]);
  return fallback || (Number(n) === 1 ? `${n} new video` : `${n} new videos`);
}

function iconUrlFor(channel, settings) {
  if (settings.alerts.useAvatarIcon && channel?.avatar) return channel.avatar;
  return chromeApi().runtime.getURL(EXT_ICON);
}

function notificationIdFor(channelId) {
  return `yt:${channelId}`;
}

function channelIdFromNotificationId(id) {
  const raw = String(id || '');
  if (!raw.startsWith('yt:')) return '';
  const channelId = raw.slice(3);
  // Only a real channel id is a safe path segment, and yt.js already owns
  // what "real" means — a second copy of that pattern would drift.
  return normalizeChannelInput(channelId)?.kind === 'id' ? channelId : '';
}

function newestForChannel(feed, channelId) {
  return newestOf((feed || []).filter((row) => row && row.c === channelId));
}

/**
 * MV3 can kill the worker between raising and lowering this flag, and
 * storage.local survives the restart. A stranded true would block polling
 * forever. There is only one worker instance, so a stored running: true
 * at script start cannot belong to a live sweep.
 */
export async function reconcileRunning() {
  await writePollState({ running: false });
}

// Alarm and popup-message wakes do not fire onStartup. Reconcile before
// any sweep reads the flag, including one delivered in this same wake.
// The rejection is not swallowed here: runSweep still recovers a leftover
// running flag when this worker is not sweeping.
const reconciled = reconcileRunning();
const coverMigrated = migrateAudioCover();

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

function resetYtOriginRule() {
  originRulePromise = null;
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

// chrome.alarms.create on an existing name restarts the countdown from
// now. A settings write that is not a period change must not recreate.
const ALARM_MIN_DELAY_MS = 60_000;

function nextAlarmWhen(lastAt, periodMinutes) {
  const due = (Number(lastAt) || 0) + Number(periodMinutes) * 60_000;
  return Math.max(Date.now() + ALARM_MIN_DELAY_MS, due);
}

async function ensureAlarm(name, periodMinutes, lastAt) {
  const alarms = chromeApi().alarms;
  const existing = await alarms.get(name);
  if (existing && existing.periodInMinutes === periodMinutes) return;
  await alarms.create(name, {
    when: nextAlarmWhen(lastAt, periodMinutes),
    periodInMinutes: periodMinutes,
  });
}

export async function syncAlarms() {
  const settings = await readSettings();
  const alarms = chromeApi().alarms;
  if (!settings.poll.enabled) {
    await alarms.clear(ALARM_ALL);
    await alarms.clear(ALARM_FAV);
    return;
  }
  const poll = await readPollState();
  const lastAll = Number(poll.lastPollAt) || 0;
  const lastFav = Math.max(Number(poll.lastFavPollAt) || 0, lastAll);
  await ensureAlarm(ALARM_ALL, settings.poll.intervalMinutes, lastAll);
  const favPeriod = settings.poll.favoriteIntervalMinutes;
  if (!(favPeriod > 0)) {
    await alarms.clear(ALARM_FAV);
    return;
  }
  await ensureAlarm(ALARM_FAV, favPeriod, lastFav);
}

export async function refreshBadge() {
  const [settings, feed, poll] = await Promise.all([
    readSettings(),
    readFeed(),
    readPollState(),
  ]);
  let channelIds = null;
  const groupOn = typeof settings.feed.group === 'string' && settings.feed.group.trim() !== '';
  if (settings.feed.favoritesOnly || groupOn) {
    const channels = await readChannels();
    channelIds = feedChannelIds(channels, settings);
  }
  const n = newSinceCount(feed, poll.lastSeenAt, settings.feed.showShorts, channelIds);
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

function pickChannels(channels, { scope, onlyId, onlyIds }) {
  if (onlyIds && onlyIds.length) {
    const want = new Set(onlyIds);
    return channels.filter((ch) => want.has(ch.id));
  }
  if (onlyId) return channels.filter((ch) => ch.id === onlyId);
  if (scope === 'favorites') return channels.filter((ch) => ch.favorite);
  return channels.slice();
}

function listingGenerations(channels) {
  const generations = new Map();
  for (const ch of channels || []) {
    if (ch?.id) generations.set(ch.id, Number(ch.addedAt) || 0);
  }
  return generations;
}

/**
 * Runs `task` over `items` in `lanes` parallel lanes, each pausing `pauseMs`
 * between its own items. A task that returns true stops the run: requests
 * already in flight finish, and no lane starts another.
 */
async function inLanes(items, lanes, pauseMs, task) {
  let next = 0;
  let stopped = false;
  async function lane() {
    for (let first = true; ; first = false) {
      if (!first && pauseMs) await sleep(pauseMs);
      if (stopped || next >= items.length) return;
      const i = next++;
      if (await task(items[i], i)) stopped = true;
    }
  }
  await Promise.all(Array.from({ length: Math.min(lanes, items.length) }, lane));
}

async function classifyIds(ids, videoMeta, fetchImpl, atById, shouldStop) {
  let meta = videoMeta;
  let pushedBack = false;
  await inLanes(ids, LANES, 0, async (id) => {
    try {
      const cls = await classifyVideo(id, { fetch: fetchImpl });
      const at = atById.get(id);
      const rec = { k: cls.k, d: cls.d, st: cls.st };
      if (at > 0) rec.at = at;
      else if (meta[id]?.at > 0) rec.at = meta[id].at;
      else if (cls.pa > 0) rec.at = cls.pa;
      if (cls.k === 'live' || cls.k === 'premiere') rec.ck = Date.now();
      meta = putVideoMeta(meta, { [id]: rec });
    } catch (err) {
      // Leave it out of videoMeta so the next sweep retries this id.
      if (isPushback(err) || await shouldStop(err)) {
        pushedBack = true;
        return true;
      }
    }
    return false;
  });
  return { meta, pushedBack };
}

/**
 * The upload time a video needs to stay in a feed capped at `maxItems`,
 * counting the rows already in it and every upload time just fetched, or
 * -Infinity while there is room. An older video would be cut the moment it
 * went in. Each channel brings 15 uploads, so 300 channels bring 4,500 to a
 * feed of 500, and more than the 3,000 records videoMeta keeps: without this
 * floor the overflow was asked about again on every check.
 */
function feedFloor(feed, atById, maxItems) {
  const cap = Number(maxItems);
  const times = new Map();
  for (const row of feed || []) {
    const at = Number(row?.at);
    if (row?.v && at > 0) times.set(row.v, at);
  }
  for (const [v, at] of atById) times.set(v, at);
  if (!(cap > 0) || times.size <= cap) return -Infinity;
  return [...times.values()].sort((a, b) => b - a)[cap - 1];
}

/**
 * Picture, handle and current name for channels that have no picture, a few
 * per check. Returns true when YouTube pushed back.
 */
async function fillHeaders(channels, patchChannel, fetchImpl, shouldStop) {
  const now = Date.now();
  const due = channels
    .filter((ch) => !ch.avatar && now - (Number(ch.headerAt) || 0) >= HEADER_RETRY_MS)
    .slice(0, HEADER_FILLS_PER_SWEEP);
  let pushedBack = false;
  await inLanes(due, LANES, CHANNEL_FETCH_DELAY_MS, async (ch) => {
    try {
      const header = await fetchChannelHeader(ch.id, { fetch: fetchImpl });
      patchChannel(ch.id, {
        headerAt: Date.now(),
        title: header.title || ch.title,
        handle: header.handle || ch.handle,
        avatar: isAvatarUrl(header.avatar) ? header.avatar : '',
      });
    } catch (err) {
      if (isPushback(err) || await shouldStop(err)) {
        pushedBack = true;
        return true;
      }
      // Tried again tomorrow; a picture is not worth a request every check.
      patchChannel(ch.id, { headerAt: Date.now() });
    }
    return false;
  });
  return pushedBack;
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

/** What the popup needs to explain a failed channel in the reader's language. */
function channelError(err) {
  const record = { at: Date.now(), message: errMessage(err) };
  if (err instanceof YtError) {
    record.kind = err.kind;
    if (err.kind === 'http') record.status = err.status;
  }
  return record;
}

function shouldNotifyItem(item, channel, settings, poll) {
  if (!channel) return false;
  if (!settings.alerts.enabled) return false;
  if (item.k === 'short' && !settings.feed.showShorts) return false;
  if (hasNotified(poll, item.v)) return false;
  // Muting beats the star: the channel stays a favourite in the list and the
  // feed, just without alerts.
  if (channel?.muted) return false;
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

async function notifyNewItems({ added, unseeded, quiet, settings, generations }) {
  let poll = await readPollState();
  const liveChannels = await readChannels();
  const live = new Map();
  const byId = new Map();
  for (const ch of liveChannels) {
    if (!ch?.id) continue;
    live.set(ch.id, Number(ch.addedAt) || 0);
    if (!isSameListing(ch.id, live, generations)) continue;
    byId.set(ch.id, ch);
  }
  const silent = (item) => unseeded.has(item.c) || quiet.has(item.v);

  const seedIds = [];
  for (const item of added) {
    if (silent(item)) seedIds.push(item.v);
  }
  if (seedIds.length) {
    // First fetch backfills up to 15 videos. Mark them notified without
    // alerting, or adding a batch of channels would spam the desktop.
    poll = markNotified(poll, seedIds);
  }

  const gated = [];
  for (const item of added) {
    if (silent(item)) continue;
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

async function performSweep({ scope, onlyId, onlyIds }) {
  const settings = await readSettings();
  const fetchImpl = globalThis.fetch;
  const allChannels = await readChannels();
  const generations = listingGenerations(allChannels);
  const list = pickChannels(allChannels, { scope, onlyId, onlyIds });
  const unseeded = new Set();
  const silentNew = new Set();
  for (const ch of list) {
    if (ch.seeded) continue;
    unseeded.add(ch.id);
    // lastVideoAt from a backup already quiets old rows; a full silent
    // seed would also hide uploads posted after the file was written.
    if (!(Number(ch.lastVideoAt) > 0)) silentNew.add(ch.id);
  }
  const incoming = [];
  let pushedBack = false;
  let innertube403 = 0;
  let originRetried = false;
  // One 403 is a dead video. Three on player/browse in one check is the
  // Origin rewrite missing; reinstall it once, and if they keep coming
  // treat it like pushback so the feed does not sit frozen.
  const shouldStop = async (err) => {
    if (!isInnertubeForbidden(err)) return false;
    innertube403 += 1;
    if (innertube403 < 3) return false;
    if (!originRetried) {
      originRetried = true;
      resetYtOriginRule();
      await ensureYtOriginRule().catch(() => {});
      return false;
    }
    return true;
  };

  // Every channel's changes go out in one write after the fetches. A write
  // per change rewrote the whole list about twice per channel per check.
  const patches = new Map();
  const patchChannel = (id, fields) => patches.set(id, { ...patches.get(id), ...fields });

  const fetched = new Array(list.length);
  await inLanes(list, LANES, CHANNEL_FETCH_DELAY_MS, async (ch, i) => {
    try {
      const uploads = await fetchLatestUploads(ch.id, { fetch: fetchImpl });
      patchChannel(ch.id, { lastError: null, lastFetchAt: Date.now() });
      fetched[i] = { channel: ch, entries: uploads.entries || [], via: uploads.via };
    } catch (err) {
      // The channel is fine; YouTube is refusing this IP. Every further
      // request deepens the block, and marking the rest as broken would
      // be wrong, so stop here and keep what already arrived.
      if (isPushback(err) || await shouldStop(err)) {
        pushedBack = true;
        return true;
      }
      patchChannel(ch.id, { lastError: channelError(err) });
    }
    return false;
  });
  const succeeded = fetched.filter(Boolean);

  let videoMeta = await readVideoMeta();
  const atById = new Map();
  for (const { entries } of succeeded) {
    for (const entry of entries) {
      if (entry?.v && entry.at > 0) atById.set(entry.v, entry.at);
    }
  }
  const feedBefore = await readFeed();
  const floor = feedFloor(feedBefore, atById, settings.feed.maxItems);
  const toClassify = new Set();
  const tooOld = new Set();
  for (const { entries } of succeeded) {
    for (const entry of entries) {
      if (!entry?.v || videoMeta[entry.v]) continue;
      // A Videos-tab row has no time until the player gives it one.
      if (atById.get(entry.v) < floor) tooOld.add(entry.v);
      else toClassify.add(entry.v);
    }
  }
  const inFeed = new Set();
  for (const row of feedBefore) {
    if (row?.v) inFeed.add(row.v);
  }
  for (const id of pendingLiveIds(videoMeta, Date.now(), inFeed)) toClassify.add(id);

  if (!pushedBack) {
    const classified = await classifyIds([...toClassify], videoMeta, fetchImpl, atById, shouldStop);
    videoMeta = classified.meta;
    pushedBack = classified.pushedBack;
  }
  await saveVideoMeta(videoMeta);

  const feedNow = await readFeed();
  const feedByV = new Map(feedNow.map((item) => [item.v, item]));
  const incomingIds = new Set();
  const quiet = new Set();

  // Each channel's newest upload this check, including ones too old for the
  // feed. An upload that failed to classify is left out: counted now, it
  // would arrive next check as old news and never alert.
  const newestSeen = new Map();
  for (const { channel, entries } of succeeded) {
    // An upload no newer than one already seen from this channel is not new.
    // It is a row the feed's cap pushed out, back because a removed channel
    // made room, or a Videos-tab row reaching past the feed's window because
    // that tab leaves out shorts. Either would alert for old videos.
    const newestBefore = Math.max(Number(channel.lastVideoAt) || 0, newestAt(feedNow, channel.id));
    // A restored backup can be months old. lastVideoAt only quiets rows the
    // file already knew; anything posted after it but long before this
    // listing would otherwise fire one alert per channel.
    const restoreFloor = (!channel.seeded && Number(channel.lastVideoAt) > 0)
      ? (Number(channel.addedAt) || 0) - 24 * 60 * 60_000
      : -Infinity;
    let newest = 0;
    for (const entry of entries) {
      if (tooOld.has(entry.v)) newest = Math.max(newest, atById.get(entry.v));
      const rec = videoMeta[entry.v];
      if (!rec || !rec.k) continue;
      const at = entry.at > 0 ? entry.at : Number(rec.at);
      if (!(at > 0)) continue;
      newest = Math.max(newest, at);
      if (at <= newestBefore || at < restoreFloor) quiet.add(entry.v);
      incoming.push(itemFromEntry({ ...entry, at }, channel.id, rec));
      incomingIds.add(entry.v);
    }
    newestSeen.set(channel.id, newest);
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

  const { feed, added } = await applyFeedMerge(
    incoming,
    settings.feed.maxItems,
    generations,
  );

  for (const { channel } of succeeded) {
    // Never lowered: a channel whose rows the cap pushed out still knows its
    // newest upload, and that is what keeps those rows quiet if they return.
    const lastVideoAt = Math.max(
      Number(channel.lastVideoAt) || 0,
      newestAt(feed, channel.id),
      newestSeen.get(channel.id) || 0,
    );
    const fields = { lastVideoAt };
    // A pushback can stop classification before a new channel's backfill is
    // all in. Left unseeded, the rest arrives silently next time instead of
    // as a burst of alerts for old videos.
    if (unseeded.has(channel.id) && !pushedBack) fields.seeded = true;
    patchChannel(channel.id, fields);
  }
  if (!pushedBack) {
    pushedBack = await fillHeaders(succeeded.map((s) => s.channel), patchChannel, fetchImpl, shouldStop);
  }
  await updateChannels(patches, generations);

  await notifyNewItems({ added, unseeded: silentNew, quiet, settings, generations });

  const now = Date.now();
  if (pushedBack) {
    const level = (Number((await readPollState()).backoffLevel) || 0) + 1;
    const until = now + backoffDelayMs(level);
    // Before the badge, which can throw: a lost write here would let the
    // next alarm walk straight back into the block.
    await writePollState({ backoffLevel: level, backoffUntil: until });
    await refreshBadge();
    return { ok: false, error: 'slow down', until, added: added.length };
  }
  const patch = { backoffLevel: 0, backoffUntil: 0 };
  if (!onlyId && !(onlyIds && onlyIds.length)) {
    if (scope === 'favorites') patch.lastFavPollAt = now;
    else patch.lastPollAt = now;
  }
  await writePollState(patch);

  await refreshBadge();
  return { ok: true, added: added.length };
}

/**
 * One worker, one sweep. Overlapping passes would both treat the same
 * upload as new and fire duplicate alerts.
 */
export async function runSweep({
  scope = 'all',
  onlyId = null,
  onlyIds = null,
  scheduled = false,
} = {}) {
  try {
    await reconciled;
  } catch {
    // Boot write failed. A leftover running flag is cleared below when this
    // worker is not sweeping.
  }
  await ensureYtOriginRule().catch(() => {});
  if (sweepActive) {
    if (scheduled && !onlyId && !(onlyIds && onlyIds.length)) {
      const incoming = scope === 'favorites' ? 'favorites' : 'all';
      if (!scheduledCoveredBy(activeCoverage, incoming)) rememberSkipped(incoming);
    }
    return { ok: false, error: 'already running' };
  }
  sweepActive = true;
  activeCoverage = sweepCoverage({ scope, onlyId, onlyIds });
  try {
    const state = await readPollState();
    if (state.running) {
      await writePollState({ running: false });
    }
    // A manual refresh waits too: a tap during a block is still a request.
    const until = Number(state.backoffUntil) || 0;
    if (until > Date.now()) return { ok: false, error: 'slow down', until };
    // Persist running the moment it changes. Batching it with a later write
    // is how a kill leaves the flag stuck on.
    await writePollState({ running: true });
    const keepAlive = setInterval(() => {
      chromeApi().runtime.getPlatformInfo?.().catch?.(() => {});
    }, KEEPALIVE_MS);
    try {
      return await performSweep({ scope, onlyId, onlyIds });
    } finally {
      clearInterval(keepAlive);
      await writePollState({ running: false });
    }
  } finally {
    sweepActive = false;
    const next = skippedScheduled;
    skippedScheduled = null;
    activeCoverage = null;
    if (next) {
      // Do not await: the caller (Refresh, a seed follow-up) would sit on
      // the reply until this extra check finishes. The follow-up has its
      // own keepalive; its finally flushes pendingSeeds.
      void runSweep({ scope: next, scheduled: true }).catch(() => {});
    } else {
      void flushSeeds();
    }
  }
}

function queueSeed(id) {
  if (!id) return;
  pendingSeeds.add(id);
  void flushSeeds();
}

async function flushSeeds() {
  if (seeding) return;
  seeding = true;
  try {
    while (pendingSeeds.size) {
      if (sweepActive) return;
      const poll = await readPollState();
      const until = Number(poll.backoffUntil) || 0;
      if (until > Date.now()) {
        pendingSeeds.clear();
        return;
      }
      const ids = [...pendingSeeds];
      pendingSeeds.clear();
      const listed = await readChannels();
      const want = new Set(ids);
      const targets = listed.filter((ch) => want.has(ch.id) && !ch.seeded).map((ch) => ch.id);
      if (!targets.length) continue;
      let result;
      try {
        result = await runSweep({ scope: 'all', onlyIds: targets });
      } catch {
        // Stored unseeded; the next check retries.
        continue;
      }
      if (result && result.error === 'already running') {
        for (const id of targets) pendingSeeds.add(id);
        return;
      }
    }
  } finally {
    seeding = false;
    if (pendingSeeds.size && !sweepActive) void flushSeeds();
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
    avatar: isAvatarUrl(header.avatar) ? header.avatar : '',
  });
  if (!added) return { ok: false, error: 'already added', id };
  const channel = (await readChannels()).find((ch) => ch.id === id);
  const state = await collectState();
  // Reply first. The silent seed runs after; if MV3 kills the worker, the
  // row stays unseeded and the next check fills it without alerts.
  queueSeed(id);
  return { ok: true, channel, state };
}

/**
 * Adds the channels of a Takeout subscriptions.csv that are not on the list
 * yet, in one write, as long as the list stays within MAX_TAKEOUT_CHANNELS.
 * They start unseeded, so their first check fills the feed without alerts.
 * New ids go on pendingSeeds so a check already in flight follows up;
 * the page that sent the file also asks for a check, which covers them
 * when nothing is running.
 */
export async function importTakeout(text) {
  const parsed = parseTakeoutCsv(text);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const channels = await readChannels();
  const have = new Set(channels.map((ch) => ch.id));
  const now = Date.now();
  const fresh = [];
  for (const { id, title } of parsed.channels) {
    if (have.has(id)) continue;
    fresh.push({
      id,
      handle: '',
      title,
      avatar: '',
      favorite: false,
      muted: false,
      addedAt: now,
      lastFetchAt: 0,
      lastVideoAt: 0,
      lastError: null,
      seeded: false,
    });
  }
  // The limit is on the list, not the file: every channel is a request on
  // every check.
  if (channels.length + fresh.length > MAX_TAKEOUT_CHANNELS) return { ok: false, error: 'count' };
  if (fresh.length) {
    await writeChannels([...channels, ...fresh]);
    // Do not flushSeeds here: that would race the welcome page's own
    // all-check. A live sweep's finally picks the ids up.
    for (const ch of fresh) pendingSeeds.add(ch.id);
  }
  return { ok: true, added: fresh.length, skipped: parsed.channels.length - fresh.length };
}

/*
 * One level of undo for Remove. storage.session because the popup that shows
 * Undo can close and reopen, and because it is gone after a browser restart
 * and unreadable to content scripts.
 */
const LAST_REMOVED_KEY = 'lastRemovedChannel';

async function rememberRemoved(id) {
  const [channels, feed] = await Promise.all([readChannels(), readFeed()]);
  const index = channels.findIndex((ch) => ch.id === id);
  if (index < 0) return;
  await chromeApi().storage.session.set({
    [LAST_REMOVED_KEY]: {
      channel: channels[index],
      index,
      rows: feed.filter((row) => row && row.c === id),
    },
  });
}

/**
 * Puts the channel back as it was: same record (seeded, favourite, stamps),
 * same place in the list, and its videos. The videos were alerted or
 * silently seeded before, and merging them back announces nothing.
 */
export async function undoRemove(id) {
  const session = chromeApi().storage.session;
  const got = await session.get(LAST_REMOVED_KEY);
  const snap = got && got[LAST_REMOVED_KEY];
  if (!snap?.channel || snap.channel.id !== id) return { ok: false, error: 'nothing to undo' };
  await session.remove(LAST_REMOVED_KEY);
  const channels = await readChannels();
  if (channels.some((ch) => ch.id === id)) return { ok: false, error: 'already added' };
  const next = channels.slice();
  next.splice(Math.min(Number(snap.index) || 0, next.length), 0, snap.channel);
  await writeChannels(next);
  const settings = await readSettings();
  const rows = Array.isArray(snap.rows) ? snap.rows : [];
  await saveFeed(mergeFeedItems(await readFeed(), rows, settings.feed.maxItems).feed);
  await refreshBadge();
  return { ok: true };
}

/**
 * Empties the list and the feed. Alert history stays, so a channel added back
 * never alerts again for a video it already alerted for.
 */
export async function clearChannels() {
  const removed = (await readChannels()).length;
  await writeChannels([]);
  await saveFeed([]);
  await chromeApi().storage.session.remove(LAST_REMOVED_KEY);
  await syncAlarms();
  await refreshBadge();
  return { ok: true, removed, state: await collectState() };
}

/**
 * Chrome fills `sender` in the browser process, so a page cannot claim an
 * extension URL. The popup's sender.url is chrome-extension://<id>/…; a
 * content script's is the youtube.com page it runs in.
 */
export function senderMayCall(type, sender) {
  const runtime = chromeApi().runtime;
  if (!sender || !runtime?.id || sender.id !== runtime.id) return false;
  if (CONTENT_SCRIPT_MESSAGES.has(type)) return true;
  const extensionRoot = runtime.getURL('');
  return typeof sender.url === 'string' && sender.url.startsWith(extensionRoot);
}

/** Trusts its caller; the onMessage listener checks the sender first. */
export async function handleMessage(msg, sender) {
  try {
    await ensureYtOriginRule().catch(() => {});
    const type = msg && msg.type;
    switch (type) {
      case 'getState':
        return await collectState();
      case 'popupOpened': {
        // The popup paints "new" dots from the last visit. Writing
        // lastSeenAt first would make every row look old by the time
        // the popup reads the reply.
        const poll = await readPollState();
        const previousLastSeenAt = Number(poll.lastSeenAt) || 0;
        await writePollState({ lastSeenAt: Date.now() });
        await refreshBadge();
        return { ...(await collectState()), previousLastSeenAt };
      }
      case 'sweep':
        return await runSweep({
          scope: msg.scope || 'all',
          onlyId: msg.onlyId || null,
        });
      case 'addChannel':
        return await addChannelByInput(msg.input);
      case 'importTakeout':
        return await importTakeout(msg.data);
      case 'removeChannel': {
        await rememberRemoved(msg.id);
        await removeChannel(msg.id);
        await refreshBadge();
        return { ok: true };
      }
      case 'undoRemove':
        return await undoRemove(msg.id);
      case 'clearChannels':
        return await clearChannels();
      case 'setFavorite': {
        await setFavorite(msg.id, msg.on);
        await syncAlarms();
        await refreshBadge();
        return { ok: true };
      }
      case 'setMuted':
        await setMuted(msg.id, msg.on);
        return { ok: true };
      case 'setChannelGroup': {
        const result = await setChannelGroup(msg.id, msg.name, msg.on);
        if (result.error) return { ok: false, error: result.error };
        await refreshBadge();
        return { ok: true };
      }
      case 'updateSettings': {
        // Alarms and the badge both derive from settings (poll periods,
        // showShorts). Writing storage from the popup would leave them stale.
        await writeSettings(msg.patch || {});
        await syncAlarms();
        await refreshBadge();
        return await collectState();
      }
      case 'audioMode.shortcut':
        return await readAudioModeShortcut();
      case 'openInAudioMode': {
        const parsed = normalizeVideoInput(msg && msg.v);
        if (!parsed || parsed.kind !== 'video') {
          return { ok: false, error: 'not a video' };
        }
        const url = `https://www.youtube.com/watch?v=${parsed.id}`;
        const run = (async () => {
          const tab = await chromeApi().tabs.create({ url, active: true });
          const tabId = tab && tab.id;
          if (tabId == null) return;
          // One key per tab, so two quick opens never race a read-modify-write.
          await chromeApi().storage.session.set({ [`audioOpen:${tabId}`]: true });
        })();
        audioOpenInFlight = audioOpenInFlight.then(() => run, () => run);
        await run;
        return { ok: true };
      }
      case 'audioMode.boot': {
        const tabId = sender?.tab?.id;
        if (tabId == null) return { ok: false, error: 'no tab' };
        await audioOpenInFlight.then(() => {}, () => {});
        const key = `audioOpen:${tabId}`;
        // MV3 can kill the worker before the page loads, so an in-memory
        // flag would be gone. storage.local would outlive a browser restart
        // and could force audio mode on an unrelated tab later. Tab ids are
        // not reused within a browser session, so a flag whose tab never
        // booted is inert.
        const got = await chromeApi().storage.session.get(key);
        const open = !!(got && got[key]);
        if (open) await chromeApi().storage.session.remove(key);
        const settings = await readSettings();
        const strings = await overlayStringsForSettings(settings);
        return { ok: true, openInAudioMode: open, ...strings };
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
        if (result.error) return { ok: false, error: result.error };
        await writeSettings(result.settings);
        await writeChannels(result.channels);
        // The file has no feed. Rows whose channel is gone would otherwise
        // keep showing until something else dropped them.
        const keep = new Set(result.channels.map((ch) => ch.id));
        const feed = (await readFeed()).filter((item) => keep.has(item.c));
        await saveFeed(feed);
        await syncAlarms();
        await refreshBadge();
        // Same as Takeout: a live check already snapshotted the list.
        const had = new Set(current.channels.map((ch) => ch.id));
        let queued = false;
        for (const ch of result.channels) {
          if (!ch?.id) continue;
          if (mode === 'replace' || !had.has(ch.id)) {
            pendingSeeds.add(ch.id);
            queued = true;
          }
        }
        const state = await collectState();
        // The popup does not send a sweep after a backup. Start one when
        // nothing is already running; a live check's finally covers the rest.
        if (queued && !sweepActive) void flushSeeds();
        return {
          ok: true,
          added: result.added,
          skipped: result.skipped,
          state,
        };
      }
      default:
        return { ok: false, error: 'unknown message' };
    }
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
}

export async function onNotificationClicked(id) {
  const mapped = notificationVideos.get(id);
  if (mapped) notificationVideos.delete(id);

  let url;
  if (mapped) {
    const feed = await readFeed();
    const item = (feed || []).find((row) => row && row.v === mapped);
    url = watchUrl(mapped, item?.k);
  } else {
    const channelId = channelIdFromNotificationId(id);
    if (!channelId) return;
    const newest = newestForChannel(await readFeed(), channelId);
    url = newest?.v
      ? watchUrl(newest.v, newest.k)
      : `https://www.youtube.com/channel/${channelId}/videos`;
  }
  await chromeApi().tabs.create({ url, active: true });
}

function onAlarm(alarm) {
  if (alarm?.name === ALARM_ALL) return runSweep({ scope: 'all', scheduled: true }).catch(() => {});
  if (alarm?.name === ALARM_FAV) return runSweep({ scope: 'favorites', scheduled: true }).catch(() => {});
}

/**
 * The page a browser opens after the extension is removed. It carries the
 * language, so the page can ask in the words the user read, and the version;
 * nothing that tells one user from another.
 */
export async function syncUninstallUrl() {
  const runtime = chromeApi().runtime;
  if (typeof runtime.setUninstallURL !== 'function') return;
  const settings = await readSettings();
  const url = new URL(UNINSTALL_PAGE);
  url.searchParams.set('lang', resolveLocale(settings.ui.locale, globalThis.navigator?.language));
  const version = runtime.getManifest?.()?.version;
  if (version) url.searchParams.set('v', version);
  await runtime.setUninstallURL(url.href);
}

function onBoot() {
  ensureYtOriginRule().catch(() => {});
  migrateAudioCover().catch(() => {});
  syncAlarms().catch(() => {});
  syncUninstallUrl().catch(() => {});
}

/** The welcome page opens on a fresh install only, never on an update. */
export async function onInstalled(details) {
  onBoot();
  if (details?.reason !== 'install') return;
  await chromeApi().tabs.create({ url: chromeApi().runtime.getURL(WELCOME_PAGE), active: true });
}

chromeApi().runtime.onInstalled.addListener((details) => {
  onInstalled(details).catch(() => {});
});
chromeApi().runtime.onStartup.addListener(onBoot);
chromeApi().alarms.onAlarm.addListener(onAlarm);
chromeApi().notifications.onClicked.addListener((id) => {
  onNotificationClicked(id).catch(() => {});
});
chromeApi().runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!senderMayCall(message?.type, sender)) {
    sendResponse({ ok: false, error: 'not allowed' });
    return false;
  }
  // Keep the worker alive until sendResponse runs — MV3 drops the reply
  // otherwise.
  handleMessage(message, sender).then(sendResponse, (err) => {
    sendResponse({ ok: false, error: errMessage(err) });
  });
  return true;
});
onSettingsChanged(() => {
  syncAlarms().catch(() => {});
  syncUninstallUrl().catch(() => {});
});
chromeApi().action.setBadgeBackgroundColor({ color: BADGE_COLOR });

/**
 * The keys Chrome actually bound: `shortcut` toggles audio mode, `popup` opens
 * the popup. Either is empty when the suggested combination was taken —
 * Chrome registers the command with no shortcut instead of the suggested_key.
 */
async function readAudioModeShortcut() {
  const api = chromeApi();
  const getAll = api?.commands?.getAll;
  if (typeof getAll !== 'function') return { ok: true, shortcut: '', popup: '' };
  try {
    const list = await getAll.call(api.commands);
    const bound = (name) => {
      const found = (Array.isArray(list) ? list : []).find((c) => c && c.name === name);
      const raw = found && found.shortcut;
      return typeof raw === 'string' ? raw.trim() : '';
    };
    return { ok: true, shortcut: bound(AUDIO_TOGGLE_COMMAND), popup: bound(POPUP_COMMAND) };
  } catch {
    return { ok: true, shortcut: '', popup: '' };
  }
}

/**
 * Scoped to the active tab on purpose. Targeting another YouTube tab
 * from a mistyped shortcut elsewhere used to switch audio mode off
 * silently; the first sign was a larger bandwidth bill.
 */
export async function handleCommand(command, tab) {
  if (command !== AUDIO_TOGGLE_COMMAND) return;
  const api = chromeApi();
  let id = tab && tab.id;
  if (id == null) {
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    id = tabs && tabs[0] && tabs[0].id;
  }
  if (id == null) return;
  try {
    await api.tabs.sendMessage(id, { type: 'audioMode.toggle' });
  } catch {
    // No content script in this tab.
  }
}

chromeApi().commands?.onCommand?.addListener((command, tab) => {
  handleCommand(command, tab).catch(() => {});
});

export const ready = Promise.all([
  reconciled.catch(() => {}),
  coverMigrated.catch(() => {}),
  ensureYtOriginRule().catch(() => {}),
]);
