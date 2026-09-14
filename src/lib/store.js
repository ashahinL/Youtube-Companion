/**
 * Channels, feed, videoMeta, and pollState accessors. Each lives on its
 * own chrome.storage.local key so a settings reset cannot wipe them.
 */

const DEFAULT_POLL_STATE = {
  running: false,
  lastPollAt: 0,
  lastFavPollAt: 0,
  lastSeenAt: 0,
  notified: [],
  // Set when YouTube pushes back: no check runs before backoffUntil, and each
  // pushback in a row doubles the wait. A clean check puts both back to 0.
  backoffUntil: 0,
  backoffLevel: 0,
};

const VIDEO_META_CAP = 3000;
const NOTIFIED_CAP = 500;

// Google publishes nothing about how long a block lasts. Doubling from 15
// minutes backs away quickly; the 6-hour cap still tries a few times a day
// while the IP stays blocked.
const BACKOFF_BASE_MS = 15 * 60_000;
const BACKOFF_MAX_MS = 6 * 60 * 60_000;

/** The wait after the `level`-th pushback in a row (1 → 15 min, 2 → 30 min…). */
export function backoffDelayMs(level) {
  const n = Math.max(1, Math.floor(Number(level)) || 1);
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (n - 1));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function getKey(key) {
  const result = await globalThis.chrome.storage.local.get(key);
  return result[key];
}

async function setKey(key, value) {
  await globalThis.chrome.storage.local.set({ [key]: value });
}

/* ---- channels ------------------------------------------------------- */

export async function readChannels() {
  const list = await getKey('channels');
  return Array.isArray(list) ? list : [];
}

export async function writeChannels(list) {
  const next = Array.isArray(list) ? list : [];
  await setKey('channels', next);
  return next;
}

export async function addChannel(entry) {
  const channels = await readChannels();
  const id = entry?.id;
  if (!id) return { added: false, channels };
  if (channels.some((ch) => ch.id === id)) return { added: false, channels };
  const record = {
    id,
    handle: entry.handle ?? '',
    title: entry.title ?? '',
    avatar: entry.avatar ?? '',
    favorite: !!entry.favorite,
    muted: !!entry.muted,
    addedAt: Number.isFinite(entry.addedAt) ? entry.addedAt : Date.now(),
    lastFetchAt: Number.isFinite(entry.lastFetchAt) ? entry.lastFetchAt : 0,
    lastVideoAt: Number.isFinite(entry.lastVideoAt) ? entry.lastVideoAt : 0,
    lastError: entry.lastError === undefined ? null : entry.lastError,
    seeded: !!entry.seeded,
  };
  const next = [...channels, record];
  await writeChannels(next);
  return { added: true, channels: next };
}

export async function updateChannel(id, patch) {
  const channels = await readChannels();
  const i = channels.findIndex((ch) => ch.id === id);
  if (i < 0) return channels;
  const next = channels.slice();
  next[i] = { ...next[i], ...patch };
  await writeChannels(next);
  return next;
}

/**
 * Several patches with one read and one write. An id no longer on the list is
 * skipped, so a channel removed while a check ran stays removed.
 */
export async function updateChannels(patches) {
  const channels = await readChannels();
  if (!(patches instanceof Map) || patches.size === 0) return channels;
  let changed = false;
  const next = channels.map((ch) => {
    const patch = patches.get(ch.id);
    if (!patch) return ch;
    changed = true;
    return { ...ch, ...patch };
  });
  if (changed) await writeChannels(next);
  return next;
}

export async function removeChannel(id) {
  const channels = (await readChannels()).filter((ch) => ch.id !== id);
  // Drop that channel's rows from the feed, or they would keep showing
  // after the channel itself is gone.
  const feed = (await readFeed()).filter((item) => item.c !== id);
  await writeChannels(channels);
  await saveFeed(feed);
  return { channels, feed };
}

export async function setFavorite(id, on) {
  return updateChannel(id, { favorite: !!on });
}

export async function setMuted(id, on) {
  return updateChannel(id, { muted: !!on });
}

function newestVideoAt(channel, feed) {
  let newest = Number(channel?.lastVideoAt) || 0;
  if (!Array.isArray(feed)) return newest;
  const id = channel?.id;
  for (const item of feed) {
    if (item && item.c === id) {
      const at = Number(item.at) || 0;
      if (at > newest) newest = at;
    }
  }
  return newest;
}

export function sortChannelsForDisplay(channels, feed) {
  const list = Array.isArray(channels) ? channels.slice() : [];
  list.sort((a, b) => {
    const favA = a?.favorite ? 1 : 0;
    const favB = b?.favorite ? 1 : 0;
    if (favA !== favB) return favB - favA;
    const atA = newestVideoAt(a, feed);
    const atB = newestVideoAt(b, feed);
    if (atA !== atB) return atB - atA;
    const tA = String(a?.title || '');
    const tB = String(b?.title || '');
    return tA.localeCompare(tB, undefined, { sensitivity: 'base' });
  });
  return list;
}

/* ---- feed ----------------------------------------------------------- */

export async function readFeed() {
  const list = await getKey('feed');
  return Array.isArray(list) ? list : [];
}

export async function saveFeed(feed) {
  const next = Array.isArray(feed) ? feed : [];
  await setKey('feed', next);
  return next;
}

export function mergeFeedItems(existing, incoming, maxItems) {
  const byV = new Map();
  for (const item of existing || []) {
    if (item && item.v) byV.set(item.v, { ...item });
  }
  const added = [];
  for (const item of incoming || []) {
    if (!item || !item.v) continue;
    if (byV.has(item.v)) {
      // Same id is a refresh (views, live settling into a finished video),
      // not a new upload.
      byV.set(item.v, { ...byV.get(item.v), ...item });
    } else {
      const copy = { ...item };
      byV.set(item.v, copy);
      added.push(copy);
    }
  }
  const feed = [...byV.values()].sort((a, b) => {
    const atA = Number(a.at) || 0;
    const atB = Number(b.at) || 0;
    if (atA !== atB) return atB - atA;
    const vA = String(a.v);
    const vB = String(b.v);
    if (vA < vB) return -1;
    if (vA > vB) return 1;
    return 0;
  });
  const cap = Number(maxItems);
  const capped = Number.isFinite(cap) && cap >= 0 ? feed.slice(0, cap) : feed;
  return { feed: capped, added };
}

export async function applyFeedMerge(incoming, maxItems) {
  const existing = await readFeed();
  const { feed, added } = mergeFeedItems(existing, incoming, maxItems);
  await saveFeed(feed);
  return { feed, added };
}

export function newSinceCount(feed, lastSeenAt, showShorts, channelIds) {
  let n = 0;
  const seen = Number(lastSeenAt) || 0;
  const restrict = channelIds != null;
  for (const item of feed || []) {
    if (!item) continue;
    if (!(item.at > seen)) continue;
    if (!showShorts && item.k === 'short') continue;
    if (restrict && !channelIds.has(item.c)) continue;
    n++;
  }
  return n;
}

/* ---- videoMeta ------------------------------------------------------ */

export async function readVideoMeta() {
  const map = await getKey('videoMeta');
  return isPlainObject(map) ? map : {};
}

export async function saveVideoMeta(map) {
  const next = isPlainObject(map) ? map : {};
  await setKey('videoMeta', next);
  return next;
}

export function putVideoMeta(map, entries) {
  const out = {};
  if (isPlainObject(map)) {
    for (const [id, rec] of Object.entries(map)) {
      out[id] = isPlainObject(rec) ? { ...rec } : rec;
    }
  }
  if (isPlainObject(entries)) {
    for (const [id, rec] of Object.entries(entries)) {
      out[id] = { ...(isPlainObject(out[id]) ? out[id] : {}), ...(isPlainObject(rec) ? rec : {}) };
    }
  }
  const ids = Object.keys(out);
  if (ids.length <= VIDEO_META_CAP) return out;
  // Oldest first. Records with no `at` cannot be ordered, so they go
  // first — otherwise they would never leave.
  ids.sort((a, b) => {
    const atA = out[a]?.at;
    const atB = out[b]?.at;
    const missingA = !Number.isFinite(atA);
    const missingB = !Number.isFinite(atB);
    if (missingA !== missingB) return missingA ? -1 : 1;
    return atA - atB;
  });
  const drop = ids.length - VIDEO_META_CAP;
  for (let i = 0; i < drop; i++) delete out[ids[i]];
  return out;
}

// A premiere next week does not need a player request on every check. Close
// to its start it is looked at every time; further out, a few times a day,
// which still notices a creator moving it earlier.
const PREMIERE_NEAR_MS = 60 * 60_000;
const PREMIERE_FAR_RECHECK_MS = 6 * 60 * 60_000;

/**
 * Live and premiere ids due for another look. `ck` is when a record was last
 * classified; a record without one is due.
 */
export function pendingLiveIds(map, now = Date.now()) {
  const ids = [];
  if (!isPlainObject(map)) return ids;
  for (const [id, rec] of Object.entries(map)) {
    if (!rec) continue;
    if (rec.k === 'live') ids.push(id);
    if (rec.k !== 'premiere') continue;
    const startsIn = (Number(rec.st) || 0) - now;
    const sinceCheck = now - (Number(rec.ck) || 0);
    if (startsIn <= PREMIERE_NEAR_MS || sinceCheck >= PREMIERE_FAR_RECHECK_MS) ids.push(id);
  }
  return ids;
}

/* ---- pollState ------------------------------------------------------ */

export async function readPollState() {
  const stored = await getKey('pollState');
  const merged = {
    ...DEFAULT_POLL_STATE,
    ...(isPlainObject(stored) ? stored : {}),
  };
  if (!Array.isArray(merged.notified)) merged.notified = [];
  else merged.notified = merged.notified.slice();
  return merged;
}

export async function writePollState(patch) {
  const current = await readPollState();
  const next = { ...current, ...(isPlainObject(patch) ? patch : {}) };
  if (!Array.isArray(next.notified)) next.notified = [];
  await setKey('pollState', next);
  return next;
}

export function markNotified(state, ids) {
  const notified = Array.isArray(state?.notified) ? state.notified.slice() : [];
  const seen = new Set(notified);
  for (const id of ids || []) {
    if (id == null || seen.has(id)) continue;
    seen.add(id);
    notified.push(id);
  }
  // A video is alerted once. Keep the newest 500 so a long-running
  // install cannot grow this list without bound; drop the oldest.
  const kept = notified.length > NOTIFIED_CAP ? notified.slice(-NOTIFIED_CAP) : notified;
  return { ...state, notified: kept };
}

export function hasNotified(state, id) {
  return Array.isArray(state?.notified) && state.notified.includes(id);
}
