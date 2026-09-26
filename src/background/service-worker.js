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
  isChannelId,
} from '../lib/yt.js';
import { readSettings, writeSettings, onSettingsChanged, migrateAudioCover } from '../lib/settings.js';
import { parseBackup, mergeBackup, buildBackup, backupSizeError } from '../lib/backup.js';
import { parseTakeoutCsv, MAX_TAKEOUT_CHANNELS } from '../lib/takeout.js';
import { resolveLocale, loadMessages, translate, translateCount } from '../lib/i18n.js';
import {
  readChannels,
  writeChannels,
  addChannel,
  updateChannels,
  removeChannel,
  setFavorite,
  setMuted,
  setChannelGroup,
  renameGroup,
  deleteGroup,
  readFeed,
  saveFeed,
  mergeFeedItems,
  applyFeedMerge,
  newSinceCount,
  readVideoMeta,
  saveVideoMeta,
  putVideoMeta,
  clearVideoMeta,
  pendingLiveIds,
  readPollState,
  writePollState,
  markNotified,
  hasNotified,
  backoffDelayMs,
  isSameListing,
  readQueue,
  addToQueue,
  removeFromQueue,
  clearQueue,
  takeFromQueue,
  withListLock,
  readQueueOpen,
  writeQueueOpen,
  readWhatsNewSeen,
  writeWhatsNewSeen,
  MAX_CHANNELS,
} from '../lib/store.js';
import {
  feedChannelIds,
  fold,
  normalizeGroupName,
  queueEntryFromItem,
  resolvedFeedGroup,
  WHATS_NEW_VERSION,
} from '../lib/view.js';

const OVERLAY_MESSAGE_KEYS = [
  'overlayTitle',
  'overlayExit',
  'overlayExitShortcut',
  'scanTitle',
  'scanStay',
  'scanFound',
  'scanLoaded',
  'scanAdded',
  'scanAddedOne',
  'scanSkipped',
  'scanSkippedOne',
  'scanNothing',
  'scanSignedOut',
  'scanSignedOutFile',
  'scanFailed',
  'scanDone',
  'scanAccounts',
  'scanChoose',
  'scanAccount',
  'scanAccountChannels',
  'scanAccountChannelsOne',
  'scanAccountMore',
  'scanAccountNone',
  'scanAccountUncounted',
  'scanAccountHere',
  'scanAccountScan',
  'scanAnother',
  'scanExpired',
  'scanDifferTitle',
  'scanDifferLine',
  'scanAddNew',
  'scanReplaceList',
  'scanReplaceWarn',
  'scanReplaceWarnOne',
  'scanReplaceExport',
  'scanReplaceDelete',
  'scanReplaceCancel',
  'scanExportSaved',
  'scanExportFailed',
  'scanRemoved',
  'scanRemovedOne',
  'scanReplaceEmpty',
  'subsGroupsAll',
  'subsGroupsLabel',
  'subsGroupsMatch',
  'subsGroupsMatchOne',
];

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
// A list imported in the last day is still mostly blank circles, and that
// is when people look at it most, so its checks fill more. Pushback still
// stops them at once.
const HEADER_FILLS_FRESH = 40;
const HEADER_FRESH_MS = 24 * 60 * 60_000;
const HEADER_RETRY_MS = 24 * 60 * 60_000;

// Chrome stops a worker after 30 seconds without an event or an extension
// API call, and a fetch in flight is neither. A check of hundreds of channels
// runs for minutes, so it makes a trivial API call more often than that.
const KEEPALIVE_MS = 25_000;
// A subscription scan waits on a tab for longer than that too.
const SCAN_KEEPALIVE_MS = 20_000;
// Chrome kills a service worker when one event runs longer than 5 minutes.
// The keepalive ping does not reset that clock, so the account picker
// gives up with a minute to spare. The content script uses the same wait.
const ACCOUNT_PICK_MS = 4 * 60 * 1000;
// A tab that keeps answering "export" would hold this event open until
// Chrome kills the worker. A handful of backups is enough to end the loop.
const MAX_IMPORT_EXPORTS = 5;
const SCAN_READY_MS = 30_000;
const SCAN_READY_GAP_MS = 300;
const CHANNELS_PAGE = 'https://www.youtube.com/feed/channels';

const WELCOME_PAGE = 'src/welcome/welcome.html';
const UNINSTALL_PAGE = 'https://ashahinl.github.io/Youtube-Companion/uninstall.html';

// The content script shares a renderer with youtube.com, so it is the sender
// a compromised page would speak as. It may ask the two audio-mode questions,
// report that the main video ended, and close its own tab after a
// subscription scan. queue.ended is only honoured when sender.tab.id and
// msg.v both match the session record this worker wrote. subscriptions.close
// only removes sender.tab, and only on youtube.com. A page must not be able
// to hand this worker a list of channels to add.
export const CONTENT_SCRIPT_MESSAGES = new Set([
  'audioMode.boot',
  'audioMode.shortcut',
  'queue.ended',
  'subscriptions.close',
]);

const QUEUE_PLAY_KEY = 'queuePlay';

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

/**
 * What a reply carries when something threw. A YouTube failure keeps its
 * message, which the pages translate; anything else is a bug or a browser
 * error whose English text means nothing to the reader, so it is logged
 * here and answered with a code.
 */
function replyError(err) {
  if (err instanceof YtError) return err.message;
  console.warn('Companion for YouTube:', err);
  return 'failed';
}

function watchUrl(videoId, kind) {
  if (kind === 'short') return `https://www.youtube.com/shorts/${videoId}`;
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function audioWatchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

async function markAudioOpen(tabId) {
  if (tabId == null) return;
  const run = chromeApi().storage.session.set({ [`audioOpen:${tabId}`]: true });
  audioOpenInFlight = audioOpenInFlight.then(() => run, () => run);
  await run;
}

async function openVideoTab(videoId, kind, { audio } = {}) {
  const url = audio ? audioWatchUrl(videoId) : watchUrl(videoId, kind);
  if (!audio) return chromeApi().tabs.create({ url, active: true });
  const run = (async () => {
    const tab = await chromeApi().tabs.create({ url, active: true });
    const tabId = tab && tab.id;
    if (tabId != null) await chromeApi().storage.session.set({ [`audioOpen:${tabId}`]: true });
    return tab;
  })();
  audioOpenInFlight = audioOpenInFlight.then(() => run, () => run);
  return run;
}

function asQueuePlay(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tabId = raw.tabId;
  if (typeof tabId !== 'number' || !Number.isFinite(tabId)) return null;
  const parsed = normalizeVideoInput(raw.v);
  if (!parsed || parsed.kind !== 'video') return null;
  return { tabId, v: parsed.id };
}

async function readQueuePlay() {
  const got = await chromeApi().storage.session.get(QUEUE_PLAY_KEY);
  return asQueuePlay(got && got[QUEUE_PLAY_KEY]);
}

async function writeQueuePlay(rec) {
  if (!rec) {
    await chromeApi().storage.session.remove(QUEUE_PLAY_KEY);
    return;
  }
  await chromeApi().storage.session.set({ [QUEUE_PLAY_KEY]: rec });
}

async function queueOpensInAudioMode() {
  const settings = await readSettings();
  return !!settings?.audio?.openFeedInAudioMode;
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

/** One message in the language the interface uses, like nNewVideosText. */
async function workerText(settings, key, fallback) {
  const locale = resolveLocale(settings?.ui?.locale, globalThis.navigator?.language);
  try {
    const text = translate(await loadMessages(locale), key);
    if (text && text !== key) return text;
  } catch {
    // Fall through to Chrome's own lookup.
  }
  return chromeApi()?.i18n?.getMessage?.(key) || fallback;
}

/* The toolbar tooltip says what the badge number means. With nothing new it
 * is the plain name again, in the language the interface uses. */
async function actionTitleText(n, settings) {
  const name = await workerText(settings, 'extActionTitle', 'Companion for YouTube');
  return n > 0 ? `${name} — ${await nNewVideosText(n, settings)}` : name;
}

// Live streams and premieres cannot be queued from a feed row, so their
// alerts carry no buttons either.
function alertHasButtons(item) {
  return !!item && item.k !== 'live' && item.k !== 'premiere';
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
  // No channels means no sweep has anything to fetch, so the alarms stay
  // cleared until the first channel lands again.
  if ((await readChannels()).length === 0) {
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
  await chromeApi().action.setTitle({ title: await actionTitleText(n, settings) });
}

async function collectState() {
  const [settings, channels, feed, pollState, queue, queueOpen, whatsNewSeen] = await Promise.all([
    readSettings(),
    readChannels(),
    readFeed(),
    readPollState(),
    readQueue(),
    readQueueOpen(),
    readWhatsNewSeen(),
  ]);
  return { settings, channels, feed, pollState, queue, queueOpen, whatsNewSeen };
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
  const waiting = channels
    .filter((ch) => !ch.avatar && now - (Number(ch.headerAt) || 0) >= HEADER_RETRY_MS);
  const fresh = waiting.some((ch) => now - (Number(ch.addedAt) || 0) < HEADER_FRESH_MS);
  const due = waiting.slice(0, fresh ? HEADER_FILLS_FRESH : HEADER_FILLS_PER_SWEEP);
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

/**
 * True when the alert is on screen. Chrome rejects a notification whose
 * icon it cannot load, and a channel picture is a remote image, so that
 * one retries with the extension's own icon. A failure is this channel's
 * alone: throwing here used to end the check before the channels after it
 * were alerted or anything was marked.
 */
async function notifyChannel(channel, items, settings) {
  const newest = newestOf(items);
  if (!newest) return false;
  const title = channel.title || channel.handle || channel.id;
  const message = items.length === 1 ? newest.t : await nNewVideosText(items.length, settings);
  const id = notificationIdFor(channel.id);
  const ownIcon = chromeApi().runtime.getURL(EXT_ICON);
  const icons = [...new Set([iconUrlFor(channel, settings), ownIcon])];
  // Both act on the newest video, the same one a click on the alert opens.
  const buttons = alertHasButtons(newest)
    ? [
      { title: await workerText(settings, 'alertListen', 'Listen') },
      { title: await workerText(settings, 'alertUpNext', 'Add to Up next') },
    ]
    : null;
  for (const iconUrl of icons) {
    try {
      const options = { type: 'basic', iconUrl, title, message };
      if (buttons) options.buttons = buttons;
      await chromeApi().notifications.create(id, options);
      notificationVideos.set(id, newest.v);
      return true;
    } catch {
      // Next icon, or give up on this channel only.
    }
  }
  return false;
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
    if (!(await notifyChannel(channel, items, settings))) continue;
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
  const listed = await readChannels();
  if (listed.some((ch) => ch.id === id)) return { ok: false, error: 'already added', id };
  // Checked before the header fetch too, so a full list costs no request.
  if (listed.length >= MAX_CHANNELS) return { ok: false, error: 'list full', id };
  const header = await fetchChannelHeader(id, ytOpts());
  const { added, full } = await addChannel({
    id,
    handle: header.handle || '',
    title: header.title || '',
    avatar: isAvatarUrl(header.avatar) ? header.avatar : '',
  });
  if (full) return { ok: false, error: 'list full', id };
  if (!added) return { ok: false, error: 'already added', id };
  await syncAlarms();
  const channel = (await readChannels()).find((ch) => ch.id === id);
  const state = await collectState();
  // Reply first. The silent seed runs after; if MV3 kills the worker, the
  // row stays unseeded and the next check fills it without alerts.
  queueSeed(id);
  return { ok: true, channel, state };
}

function cleanImportedHandle(value) {
  if (typeof value !== 'string') return '';
  const handle = value.trim();
  // A handle we already know saves a lookup later. A bad one is left blank
  // and the header read fills it in.
  if (!/^@[^\s/?#@]{1,100}$/.test(handle)) return '';
  return handle;
}

function cleanImportedTitle(value) {
  return String(value || '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .trim()
    .slice(0, 200);
}

function newImportedChannel(row, now) {
  return {
    id: row.id,
    handle: cleanImportedHandle(row.handle),
    title: cleanImportedTitle(row.title),
    avatar: '',
    favorite: false,
    muted: false,
    addedAt: now,
    lastFetchAt: 0,
    lastVideoAt: 0,
    lastError: null,
    seeded: false,
  };
}

function scannedChannelRows(list) {
  const rows = [];
  const seen = new Set();
  let considered = 0;
  const incoming = Array.isArray(list) ? list : [];
  for (const row of incoming) {
    if (!row || typeof row !== 'object') continue;
    if (!isChannelId(row.id)) continue;
    considered += 1;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
  }
  return { rows, seen, considered };
}

/** How many scanned ids are new, and how many watchlist ids the scan lacks. */
function importedIdDiff(channels, scanned) {
  const { seen } = scannedChannelRows(scanned);
  const have = new Set();
  const list = Array.isArray(channels) ? channels : [];
  for (const ch of list) {
    if (ch && isChannelId(ch.id)) have.add(ch.id);
  }
  let fresh = 0;
  for (const id of seen) {
    if (!have.has(id)) fresh += 1;
  }
  let extra = 0;
  for (const id of have) {
    if (!seen.has(id)) extra += 1;
  }
  return { fresh, extra };
}

/**
 * The next channel list and feed when an import replaces the watchlist.
 * A channel in both lists keeps the stored record: the scan only has an
 * id, a title and a handle, and favourite, mute, groups and stamps are
 * newer than that. An empty scan is refused so it cannot wipe the list.
 * The result is capped at MAX_TAKEOUT_CHANNELS. Pure: no storage, no chrome.
 */
export function planImportedReplace(channels, feed, scanned, now = Date.now()) {
  const current = Array.isArray(channels) ? channels : [];
  const rows = Array.isArray(feed) ? feed : [];
  const { rows: incoming, seen, considered } = scannedChannelRows(scanned);
  const empty = {
    ok: false,
    channels: current,
    feed: rows,
    added: 0,
    removed: 0,
    skipped: 0,
    removedIds: [],
    freshIds: [],
  };
  if (seen.size === 0) return { ...empty, error: 'empty' };

  const have = new Set();
  for (const ch of current) {
    if (ch && isChannelId(ch.id)) have.add(ch.id);
  }
  const kept = [];
  const removedIds = [];
  const removedSeen = new Set();
  const keptSeen = new Set();
  for (const ch of current) {
    if (!ch || !isChannelId(ch.id)) continue;
    if (!seen.has(ch.id)) {
      if (!removedSeen.has(ch.id)) {
        removedSeen.add(ch.id);
        removedIds.push(ch.id);
      }
      continue;
    }
    if (keptSeen.has(ch.id)) continue;
    keptSeen.add(ch.id);
    kept.push(ch);
  }
  const fresh = [];
  for (const row of incoming) {
    if (have.has(row.id)) continue;
    fresh.push(newImportedChannel(row, now));
  }
  const next = [...kept, ...fresh];
  if (next.length > MAX_TAKEOUT_CHANNELS) return { ...empty, error: 'count' };
  const keep = new Set(next.map((ch) => ch.id));
  return {
    ok: true,
    channels: next,
    feed: rows.filter((item) => keep.has(item.c)),
    added: fresh.length,
    removed: removedIds.length,
    skipped: considered - fresh.length,
    removedIds,
    freshIds: fresh.map((ch) => ch.id),
  };
}

/**
 * Adds channels that are not on the list yet, in one write, as long as the
 * list stays within MAX_TAKEOUT_CHANNELS. They start unseeded, so their
 * first check fills the feed without alerts. New ids go on pendingSeeds so
 * a check already in flight follows up; the caller also asks for a check
 * when nothing is running. A handle is kept when the caller has one.
 */
export async function addImportedChannels(list) {
  const incoming = Array.isArray(list) ? list : [];
  const planned = await withListLock(async () => {
    const channels = await readChannels();
    const have = new Set(channels.map((ch) => ch.id));
    const now = Date.now();
    const fresh = [];
    const seen = new Set();
    let considered = 0;
    for (const row of incoming) {
      if (!row || typeof row !== 'object') continue;
      const id = row.id;
      if (!isChannelId(id)) continue;
      considered += 1;
      if (have.has(id) || seen.has(id)) continue;
      seen.add(id);
      fresh.push(newImportedChannel(row, now));
    }
    // The limit is on the list, not the input: every channel is a request
    // on every check.
    if (channels.length + fresh.length > MAX_TAKEOUT_CHANNELS) return null;
    if (fresh.length) await writeChannels([...channels, ...fresh]);
    return { fresh, considered };
  });
  if (!planned) return { ok: false, error: 'count' };
  const { fresh, considered } = planned;
  if (fresh.length) {
    await syncAlarms();
    // Do not flushSeeds here: that would race the caller's own all-check.
    // A live sweep's finally picks the ids up.
    for (const ch of fresh) pendingSeeds.add(ch.id);
  }
  return { ok: true, added: fresh.length, skipped: considered - fresh.length, removed: 0 };
}

/**
 * One write of the channel list. Channels in both lists keep their records.
 * Extras leave the list and the feed together. Fresh rows are unseeded, the
 * same shape as an add. Alert history is not touched: a channel added back
 * must not alert twice. An empty scan is refused.
 */
async function replaceWithScanned(scanned) {
  const plan = await withListLock(async () => {
    const [channels, feed] = await Promise.all([readChannels(), readFeed()]);
    const next = planImportedReplace(channels, feed, scanned);
    if (!next.ok) return next;
    await writeChannels(next.channels);
    await saveFeed(next.feed);
    // Records carry no channel id, so the rows this replace dropped are the
    // only way to find a removed channel's videos. Older ones leave at the cap.
    const gone = new Set(next.removedIds);
    const kept = new Set(next.feed.map((item) => item.v));
    const deadVideos = feed.filter((item) => gone.has(item.c) && !kept.has(item.v)).map((item) => item.v);
    return { ...next, deadVideos };
  });
  if (!plan.ok) return { ok: false, error: plan.error };
  if (plan.deadVideos.length) {
    const meta = await readVideoMeta();
    for (const v of plan.deadVideos) delete meta[v];
    await saveVideoMeta(meta);
  }
  for (const id of plan.removedIds) pendingSeeds.delete(id);
  for (const id of plan.freshIds) pendingSeeds.add(id);
  await syncAlarms();
  await refreshBadge();
  return {
    ok: true,
    added: plan.added,
    removed: plan.removed,
    skipped: plan.skipped,
  };
}

/** The Takeout file's rows, through the same add as a YouTube-tab import. */
export async function importTakeout(text) {
  const parsed = parseTakeoutCsv(text);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return addImportedChannels(parsed.channels);
}

async function focusTab(tab) {
  const api = chromeApi();
  if (!tab || typeof tab.id !== 'number') return tab;
  try {
    await api.tabs.update(tab.id, { active: true });
  } catch {
    // The caller carries on even if the tab could not be activated.
  }
  if (typeof tab.windowId === 'number') {
    try {
      await api.windows.update(tab.windowId, { focused: true });
    } catch {
      // The tab is active even if its window could not be focused.
    }
  }
  return tab;
}

async function openChannelsTab() {
  const api = chromeApi();
  let existing = [];
  try {
    existing = await api.tabs.query({ url: `${CHANNELS_PAGE}*` });
  } catch {
    existing = [];
  }
  const found = (existing || []).find((tab) => tab && typeof tab.id === 'number');
  if (found) return focusTab(found);
  const created = await api.tabs.create({ url: CHANNELS_PAGE, active: true });
  return focusTab(created);
}

async function sendToTab(tabId, message) {
  try {
    const reply = await chromeApi().tabs.sendMessage(tabId, message);
    return { rejected: false, reply };
  } catch {
    return { rejected: true, reply: null };
  }
}

async function tellTab(tabId, fields) {
  const account = accountIndex(fields && fields.account);
  const avatar = isAvatarUrl(fields && fields.avatar) ? fields.avatar : '';
  try {
    await chromeApi().tabs.sendMessage(tabId, {
      type: 'subscriptions.result',
      added: Number(fields && fields.added) || 0,
      skipped: Number(fields && fields.skipped) || 0,
      removed: Number(fields && fields.removed) || 0,
      error: (fields && fields.error) || '',
      account,
      avatar,
    });
  } catch {
    // The tab can close while the scan runs.
  }
}

/*
 * A tab that was already open kept the previous content script until its
 * next load. An answer of nothing is that script; reloading once picks up
 * the current one. A tab that is still loading has no listener and rejects,
 * which is not a reason to reload it.
 */
function accountIndex(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 9) return null;
  return value;
}

async function requestTab(tabId, message) {
  const deadline = Date.now() + SCAN_READY_MS;
  let reloaded = false;
  let wrong = null;
  while (Date.now() <= deadline) {
    const sent = await sendToTab(tabId, message);
    const reply = !sent.rejected && sent.reply && typeof sent.reply === 'object' ? sent.reply : null;
    // tabs.update returns before the old page is gone, and that page is on
    // /feed/channels too. It refuses a scan meant for another account; the
    // next try reaches the page that was asked for.
    if (reply && reply.error === 'wrongAccount') wrong = reply;
    else if (reply) return reply;
    else if (!sent.rejected && !reloaded) {
      reloaded = true;
      try { await chromeApi().tabs.reload(tabId); } catch { /* the next try reports no script */ }
    }
    if (Date.now() >= deadline) break;
    await sleep(SCAN_READY_GAP_MS);
  }
  return wrong || { ok: false, error: 'no script' };
}

async function requestAccounts(tabId, message) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), ACCOUNT_PICK_MS);
  });
  try {
    return await Promise.race([requestTab(tabId, message), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function sendImportBackup(tabId) {
  const [settings, channels] = await Promise.all([readSettings(), readChannels()]);
  const data = buildBackup({ settings, channels });
  let text = '';
  try {
    text = JSON.stringify(data, null, 2);
  } catch {
    return 'failed';
  }
  // The file stays here until the tab asks. A backup past the size cap is
  // a failure line on the tab, not a download.
  if (backupSizeError(text.length)) return 'size';
  const name = `youtube-companion-${new Date().toISOString().slice(0, 10)}.json`;
  const sent = await sendToTab(tabId, { type: 'subscriptions.download', name, text });
  if (sent.rejected || !sent.reply || sent.reply.ok !== true) return 'failed';
  return 'ok';
}

async function askImportChoice(tabId, fields) {
  let exportsDone = 0;
  let exported = false;
  let exportError = false;
  while (true) {
    const message = {
      type: 'subscriptions.choose',
      fresh: fields.fresh,
      extra: fields.extra,
      account: fields.account,
      avatar: fields.avatar,
    };
    if (exported) message.exported = true;
    if (exportError) message.exportError = true;
    exported = false;
    exportError = false;
    const reply = await requestAccounts(tabId, message);
    if (!reply || reply.ok !== true) {
      return { ok: false, error: (reply && reply.error) || 'failed' };
    }
    if (reply.mode === 'merge' || reply.mode === 'replace') return reply;
    if (reply.mode !== 'export') return { ok: false, error: 'failed' };
    if (exportsDone >= MAX_IMPORT_EXPORTS) return { ok: false, error: 'failed' };
    exportsDone += 1;
    const outcome = await sendImportBackup(tabId);
    if (outcome === 'ok') exported = true;
    else if (outcome === 'size') exportError = true;
    else return { ok: false, error: 'failed' };
  }
}

async function openAccount(tabId, index) {
  await chromeApi().tabs.update(tabId, {
    url: `https://www.youtube.com/feed/channels?authuser=${index}`,
    active: true,
  });
}

/**
 * Opens All subscriptions in front of the user and reads the rows there.
 * New channels are added. When the watchlist has channels this account is
 * not subscribed to, the tab asks whether to add only the new ones or
 * replace the list. The tab shows the result.
 */
export async function importFromYouTube() {
  const api = chromeApi();
  const keepAlive = setInterval(() => {
    api.runtime.getPlatformInfo?.().catch?.(() => {});
  }, SCAN_KEEPALIVE_MS);
  try {
    const tab = await openChannelsTab();
    const tabId = tab && tab.id;
    if (typeof tabId !== 'number') return { ok: false, error: 'no tab' };
    let last = null;
    for (let round = 0; round < 10; round++) {
      const choice = await requestAccounts(tabId, {
        type: 'subscriptions.accounts',
        again: round > 0,
      });
      if (!choice || choice.ok !== true) {
        if (choice && choice.error === 'timeout') return last || { ok: false, error: 'timeout' };
        if (choice && choice.error === 'done' && last) return last;
        const error = (choice && choice.error) || 'failed';
        if (error !== 'done') await tellTab(tabId, { error });
        return last || { ok: false, error };
      }
      const index = accountIndex(choice.index);
      if (index == null) {
        await tellTab(tabId, { error: 'failed' });
        return { ok: false, error: 'failed' };
      }
      const current = accountIndex(choice.current);
      // Unknown current still navigates: the open tab may be a later account.
      if (current == null || current !== index) {
        try {
          await openAccount(tabId, index);
        } catch (err) {
          await tellTab(tabId, { error: 'failed' });
          return { ok: false, error: 'failed' };
        }
      }
      const scanned = await requestTab(tabId, { type: 'subscriptions.scan', index });
      if (!scanned || scanned.ok !== true) {
        const error = (scanned && scanned.error) || 'failed';
        await tellTab(tabId, { error, account: index, avatar: choice.avatar });
        return { ok: false, error };
      }
      const avatar = isAvatarUrl(choice.avatar) ? choice.avatar : '';
      const listed = await readChannels();
      const diff = importedIdDiff(listed, scanned.channels);
      let imported;
      if (diff.extra === 0) {
        imported = await addImportedChannels(scanned.channels);
      } else {
        const answer = await askImportChoice(tabId, {
          fresh: diff.fresh,
          extra: diff.extra,
          account: index,
          avatar,
        });
        if (!answer || answer.ok !== true) {
          const error = (answer && answer.error) || 'failed';
          if (error === 'done') return last || { ok: false, error: 'done' };
          if (error === 'timeout') return last || { ok: false, error: 'timeout' };
          await tellTab(tabId, { error, account: index, avatar });
          return last || { ok: false, error };
        }
        if (answer.mode === 'merge') imported = await addImportedChannels(scanned.channels);
        else if (answer.mode === 'replace') imported = await replaceWithScanned(scanned.channels);
        else {
          await tellTab(tabId, { error: 'failed', account: index, avatar });
          return { ok: false, error: 'failed' };
        }
      }
      if (!imported.ok) {
        await tellTab(tabId, { error: imported.error || 'failed', account: index, avatar });
        return { ok: false, error: imported.error || 'failed' };
      }
      const removed = Number(imported.removed) || 0;
      await tellTab(tabId, {
        added: imported.added,
        skipped: imported.skipped,
        removed,
        account: index,
        avatar,
      });
      // Not awaited: a first check of hundreds of channels takes minutes.
      void runSweep({ scope: 'all' }).catch(() => {});
      last = { ok: true, added: imported.added, skipped: imported.skipped, removed };
    }
    return last || { ok: false, error: 'failed' };
  } catch (err) {
    return { ok: false, error: replyError(err) };
  } finally {
    clearInterval(keepAlive);
  }
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
  const settings = await readSettings();
  const restored = await withListLock(async () => {
    const channels = await readChannels();
    if (channels.some((ch) => ch.id === id)) return false;
    const next = channels.slice();
    next.splice(Math.min(Number(snap.index) || 0, next.length), 0, snap.channel);
    await writeChannels(next);
    const rows = Array.isArray(snap.rows) ? snap.rows : [];
    await saveFeed(mergeFeedItems(await readFeed(), rows, settings.feed.maxItems).feed);
    return true;
  });
  if (!restored) return { ok: false, error: 'already added' };
  await syncAlarms();
  await refreshBadge();
  return { ok: true };
}

/**
 * Empties the list and the feed. Alert history stays, so a channel added back
 * never alerts again for a video it already alerted for.
 */
export async function clearChannels() {
  const removed = await withListLock(async () => {
    const count = (await readChannels()).length;
    await writeChannels([]);
    await saveFeed([]);
    return count;
  });
  await clearVideoMeta();
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
      case 'importFromYouTube':
        return await importFromYouTube();
      case 'subscriptions.close': {
        const tab = sender && sender.tab;
        const tabId = tab && tab.id;
        const url = (tab && tab.url) || (sender && sender.url) || '';
        if (typeof tabId !== 'number' || !Number.isFinite(tabId)) return { ok: false, error: 'no tab' };
        if (!url.startsWith('https://www.youtube.com/')) return { ok: false, error: 'not allowed' };
        await chromeApi().tabs.remove(tabId);
        return { ok: true };
      }
      case 'removeChannel': {
        await rememberRemoved(msg.id);
        await removeChannel(msg.id);
        await syncAlarms();
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
      case 'renameGroup': {
        // Popup-only: a YouTube page must not be able to change groups, so
        // this stays out of CONTENT_SCRIPT_MESSAGES with setChannelGroup.
        const result = await renameGroup(msg.from, msg.to);
        if (result.error) return { ok: false, error: result.error };
        const settings = await readSettings();
        const fromKey = fold(normalizeGroupName(msg.from));
        if (fromKey && fold(String(settings?.feed?.group || '')) === fromKey) {
          // After a merge the surviving spelling is the other group's, so
          // resolve rather than writing the raw new name.
          const follow = resolvedFeedGroup(result.channels, msg.to) || normalizeGroupName(msg.to);
          await writeSettings({ feed: { group: follow } });
        }
        await refreshBadge();
        return { ok: true };
      }
      case 'deleteGroup': {
        // Popup-only, same as renameGroup above.
        const result = await deleteGroup(msg.name);
        if (result.error) return { ok: false, error: result.error };
        const settings = await readSettings();
        const key = fold(normalizeGroupName(msg.name));
        if (key && fold(String(settings?.feed?.group || '')) === key) {
          await writeSettings({ feed: { group: '' } });
        }
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
        // One key per tab, so two quick opens never race a read-modify-write.
        await openVideoTab(parsed.id, 'video', { audio: true });
        return { ok: true };
      }
      case 'queue.add': {
        const built = queueEntryFromItem(msg && msg.item, Date.now());
        if (!built) return { ok: false, error: 'invalid' };
        const result = await addToQueue(built);
        if (result.added) return { ok: true, queue: result.queue };
        if (result.full) return { ok: false, error: 'full', queue: result.queue };
        return { ok: true, queue: result.queue };
      }
      case 'queue.remove': {
        const result = await removeFromQueue(msg && msg.v);
        return { ok: true, queue: result.queue };
      }
      case 'queue.clear': {
        const result = await clearQueue();
        return { ok: true, queue: result.queue };
      }
      case 'queue.setOpen':
        await writeQueueOpen(msg && msg.on);
        return { ok: true };
      case 'whatsNew.seen':
        await writeWhatsNewSeen(WHATS_NEW_VERSION);
        return { ok: true };
      case 'queue.playAll': {
        const queue = await readQueue();
        const first = queue[0];
        if (!first) return { ok: false, error: 'empty' };
        const audio = await queueOpensInAudioMode();
        const tab = await openVideoTab(first.v, first.k, { audio });
        const tabId = tab && tab.id;
        if (tabId == null) return { ok: false, error: 'no tab' };
        await writeQueuePlay({ tabId, v: first.v });
        return { ok: true, queue };
      }
      case 'queue.ended': {
        // A record left by a closed tab is never cleared: tab ids are not
        // reused within a browser session and session storage ends with it,
        // so no live tab can match it, and the next playAll overwrites it.
        // Listening for tab closes woke the worker for every tab closed
        // anywhere in the browser.
        const play = await readQueuePlay();
        if (!play) return { ok: false };
        if (sender?.tab?.id !== play.tabId) return { ok: false };
        if (msg.v !== play.v) return { ok: false };
        await takeFromQueue(play.v);
        const queue = await readQueue();
        const next = queue[0];
        if (!next) {
          await writeQueuePlay(null);
          return { ok: true, done: true };
        }
        const audio = await queueOpensInAudioMode();
        const url = audio ? audioWatchUrl(next.v) : watchUrl(next.v, next.k);
        if (audio) await markAudioOpen(play.tabId);
        // YouTube's own autoplay may show a suggestion first; tabs.update
        // still wins. Do not try to suppress YouTube's autoplay.
        await chromeApi().tabs.update(play.tabId, { url });
        await writeQueuePlay({ tabId: play.tabId, v: next.v });
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
            return { ok: false, error: 'json' };
          }
        }
        const parsed = parseBackup(text);
        if (!parsed.ok) return { ok: false, error: parsed.error };
        const mode = msg.mode === 'replace' ? 'replace' : 'merge';
        const applied = await withListLock(async () => {
          const current = { settings: await readSettings(), channels: await readChannels() };
          const merged = mergeBackup(current, parsed.data, mode);
          if (merged.error) return { error: merged.error };
          await writeSettings(merged.settings);
          await writeChannels(merged.channels);
          // The file has no feed. Rows whose channel is gone would otherwise
          // keep showing until something else dropped them.
          const keep = new Set(merged.channels.map((ch) => ch.id));
          await saveFeed((await readFeed()).filter((item) => keep.has(item.c)));
          return { current, result: merged };
        });
        if (applied.error) return { ok: false, error: applied.error };
        const { current, result } = applied;
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
    return { ok: false, error: replyError(err) };
  }
}

/**
 * Button 0 opens the alert's video in audio mode, button 1 adds it to Up
 * next. Like a click, it rebuilds from storage when the worker restarted.
 */
export async function onNotificationButtonClicked(id, index) {
  try {
    Promise.resolve(chromeApi().notifications.clear(id)).catch(() => {});
  } catch {
    // The action matters more than removing the alert.
  }
  const channelId = channelIdFromNotificationId(id);
  if (!channelId) return;
  const mapped = notificationVideos.get(id);
  if (mapped) notificationVideos.delete(id);
  const [feed, channels] = await Promise.all([readFeed(), readChannels()]);
  const item = mapped
    ? (feed || []).find((row) => row && row.v === mapped)
    : newestForChannel(feed, channelId);
  const v = item?.v || mapped;
  if (!v) return;
  if (index === 0) {
    await openVideoTab(v, 'video', { audio: true });
    return;
  }
  if (index === 1 && alertHasButtons(item)) {
    const channel = channels.find((ch) => ch.id === channelId);
    await addToQueue({ ...item, ct: item.ct || channel?.title || '' });
  }
}

export async function onNotificationClicked(id) {
  // Chrome leaves a clicked notification on screen, so every further click
  // opened the same video in one more tab. Clear it before anything awaits.
  try {
    Promise.resolve(chromeApi().notifications.clear(id)).catch(() => {});
  } catch {
    // Opening the video matters more than removing the alert.
  }
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
  // macOS can keep a clicked alert in Notification Center, so a later click
  // still arrives: go to the tab it already opened instead of a new one.
  const api = chromeApi();
  let open = [];
  try {
    open = await api.tabs.query({ url: `${url}*` });
  } catch {
    open = [];
  }
  const found = (open || []).find((tab) => tab && typeof tab.id === 'number');
  if (found) {
    await focusTab(found);
    return;
  }
  await api.tabs.create({ url, active: true });
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
  // A first install is reading the welcome page right now, so it has missed
  // nothing: stamping the flag here keeps the popup's What's new note for
  // people who are actually being updated.
  await writeWhatsNewSeen(WHATS_NEW_VERSION);
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
chromeApi().notifications.onButtonClicked?.addListener((id, index) => {
  onNotificationButtonClicked(id, index).catch(() => {});
});
chromeApi().runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!senderMayCall(message?.type, sender)) {
    sendResponse({ ok: false, error: 'not allowed' });
    return false;
  }
  // Keep the worker alive until sendResponse runs — MV3 drops the reply
  // otherwise.
  handleMessage(message, sender).then(sendResponse, (err) => {
    sendResponse({ ok: false, error: replyError(err) });
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
