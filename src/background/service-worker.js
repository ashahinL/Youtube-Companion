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
  isAvatarUrl,
} from '../lib/yt.js';
import { readSettings, writeSettings, onSettingsChanged } from '../lib/settings.js';
import { parseBackup, mergeBackup } from '../lib/backup.js';
import { parseTakeoutCsv, MAX_TAKEOUT_CHANNELS } from '../lib/takeout.js';
import { resolveLocale, loadMessages, translate } from '../lib/i18n.js';
import {
  readChannels,
  writeChannels,
  addChannel,
  updateChannels,
  removeChannel,
  setFavorite,
  setMuted,
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
} from '../lib/store.js';

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
const HEADER_FILLS_PER_SWEEP = 20;
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
const reconciled = reconcileRunning().catch(() => {});

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
  if (settings.feed.favoritesOnly) {
    const channels = await readChannels();
    channelIds = new Set();
    for (const ch of channels) {
      if (ch?.favorite && ch.id) channelIds.add(ch.id);
    }
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

function pickChannels(channels, { scope, onlyId }) {
  if (onlyId) return channels.filter((ch) => ch.id === onlyId);
  if (scope === 'favorites') return channels.filter((ch) => ch.favorite);
  return channels.slice();
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

async function classifyIds(ids, videoMeta, fetchImpl, atById) {
  let meta = videoMeta;
  let pushedBack = false;
  await inLanes(ids, LANES, 0, async (id) => {
    try {
      const cls = await classifyVideo(id, { fetch: fetchImpl });
      const at = atById.get(id);
      const rec = { k: cls.k, d: cls.d, st: cls.st };
      if (Number.isFinite(at)) rec.at = at;
      else if (Number.isFinite(meta[id]?.at)) rec.at = meta[id].at;
      else if (cls.pa > 0) rec.at = cls.pa;
      if (cls.k === 'live' || cls.k === 'premiere') rec.ck = Date.now();
      meta = putVideoMeta(meta, { [id]: rec });
    } catch (err) {
      // Leave it out of videoMeta so the next sweep retries this id.
      if (isPushback(err)) {
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
    if (row?.v && Number.isFinite(at)) times.set(row.v, at);
  }
  for (const [v, at] of atById) times.set(v, at);
  if (!(cap > 0) || times.size <= cap) return -Infinity;
  return [...times.values()].sort((a, b) => b - a)[cap - 1];
}

/**
 * Picture, handle and current name for channels that have no picture, a few
 * per check. Returns true when YouTube pushed back.
 */
async function fillHeaders(channels, patchChannel, fetchImpl) {
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
      if (isPushback(err)) {
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

async function notifyNewItems({ added, channels, unseeded, quiet, settings }) {
  let poll = await readPollState();
  const byId = new Map(channels.map((ch) => [ch.id, ch]));
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

async function performSweep({ scope, onlyId }) {
  const settings = await readSettings();
  const fetchImpl = globalThis.fetch;
  const allChannels = await readChannels();
  const list = pickChannels(allChannels, { scope, onlyId });
  const unseeded = new Set(list.filter((ch) => !ch.seeded).map((ch) => ch.id));
  const incoming = [];
  let pushedBack = false;

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
      if (isPushback(err)) {
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
      if (entry?.v && Number.isFinite(entry.at)) atById.set(entry.v, entry.at);
    }
  }
  const floor = feedFloor(await readFeed(), atById, settings.feed.maxItems);
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
  for (const id of pendingLiveIds(videoMeta)) toClassify.add(id);

  if (!pushedBack) {
    const classified = await classifyIds([...toClassify], videoMeta, fetchImpl, atById);
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
    let newest = 0;
    for (const entry of entries) {
      if (tooOld.has(entry.v)) newest = Math.max(newest, atById.get(entry.v));
      const rec = videoMeta[entry.v];
      if (!rec || !rec.k) continue;
      const at = Number.isFinite(entry.at) ? entry.at : Number(rec.at);
      if (!(at > 0)) continue;
      newest = Math.max(newest, at);
      if (at <= newestBefore) quiet.add(entry.v);
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

  // A check takes minutes on a long list, and the list can change meanwhile.
  // Rows from a channel removed, or a list cleared, mid-check would come back
  // into the feed with no channel behind them.
  const listed = new Set((await readChannels()).map((ch) => ch.id));
  const { feed, added } = await applyFeedMerge(
    incoming.filter((item) => listed.has(item.c)),
    settings.feed.maxItems,
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
    pushedBack = await fillHeaders(succeeded.map((s) => s.channel), patchChannel, fetchImpl);
  }
  const channels = await updateChannels(patches);

  await notifyNewItems({ added, channels, unseeded, quiet, settings });

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
  if (!onlyId) {
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
export async function runSweep({ scope = 'all', onlyId = null } = {}) {
  await reconciled;
  await ensureYtOriginRule().catch(() => {});
  if (sweepActive) return { ok: false, error: 'already running' };
  sweepActive = true;
  try {
    const state = await readPollState();
    if (state.running) return { ok: false, error: 'already running' };
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
      return await performSweep({ scope, onlyId });
    } finally {
      clearInterval(keepAlive);
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

/**
 * Adds the channels of a Takeout subscriptions.csv that are not on the list
 * yet, in one write, as long as the list stays within MAX_TAKEOUT_CHANNELS. They start unseeded, so their first check fills the feed
 * without alerts; the page that sent the file asks for that check.
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
  if (fresh.length) await writeChannels([...channels, ...fresh]);
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
        await writePollState({ lastSeenAt: Date.now() });
        await refreshBadge();
        return await collectState();
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
        return { ok: true };
      }
      case 'setMuted':
        await setMuted(msg.id, msg.on);
        return { ok: true };
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
        return { ok: true, openInAudioMode: open };
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
  if (alarm?.name === ALARM_ALL) return runSweep({ scope: 'all' }).catch(() => {});
  if (alarm?.name === ALARM_FAV) return runSweep({ scope: 'favorites' }).catch(() => {});
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
 * The real binding, not suggested_key. Chrome registers the command with
 * an empty shortcut when the combination is already taken.
 */
/**
 * The keys Chrome actually bound: `shortcut` toggles audio mode, `popup` opens
 * the popup. Either is empty when the suggested combination was taken.
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
  reconciled,
  ensureYtOriginRule().catch(() => {}),
]);
