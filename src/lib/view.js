/**
 * Popup view decisions for the Feeds, Watchlist and Player tabs: which
 * rows show, whether Add is live, which empty state applies, which
 * tab the popup opens on, which videos are newer than the last visit,
 * which YouTube tab the player drives, when the player card may sync a
 * control, how audioStats fold into the four cards, when the 1 GB
 * rating note shows, how a failed channel is described, when the Follow
 * card shows, which credited channels are followed, which Follow buttons
 * wait, how a backup merge-over-cap error is named, which ⋯ menu
 * item Arrow/Home/End would select, channel-group names, caps, and
 * the Feeds group filter, and how group writes queue so two ticks
 * cannot interleave.
 * Pure — no DOM, no chrome, no clock.
 */

import { normalizeChannelInput, normalizeVideoInput } from './yt.js';

export function fold(value) {
  return String(value || '').normalize('NFKC').toLowerCase();
}

export const GROUP_NAME_MAX = 24;
export const GROUP_MAX_PER_CHANNEL = 8;
export const GROUP_MAX_DISTINCT = 20;

/** Trim, collapse inner whitespace, drop empty, cap at GROUP_NAME_MAX. */
export function normalizeGroupName(raw) {
  const collapsed = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!collapsed) return '';
  const chars = [...collapsed];
  return chars.length > GROUP_NAME_MAX ? chars.slice(0, GROUP_NAME_MAX).join('') : collapsed;
}

function groupKey(name) {
  const normalised = normalizeGroupName(name);
  return normalised ? fold(normalised) : '';
}

/** Unique normalised names on one channel, first spelling kept, at most 8. */
export function sanitizeChannelGroups(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const name = normalizeGroupName(item);
    if (!name) continue;
    const key = fold(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= GROUP_MAX_PER_CHANNEL) break;
  }
  return out;
}

/**
 * Distinct group names on the list, first spelling kept, sorted for the
 * UI language. `locale` is `en` / `ar` / omitted.
 */
export function groupNamesInList(channels, locale) {
  const names = [];
  const seen = new Set();
  for (const ch of channels || []) {
    for (const name of sanitizeChannelGroups(ch?.groups)) {
      const key = fold(name);
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(name);
    }
  }
  const loc = locale === 'ar' ? 'ar' : locale === 'en' ? 'en' : undefined;
  names.sort((a, b) => a.localeCompare(b, loc, { sensitivity: 'base' }));
  return names;
}

/**
 * Drop junk names and enforce both caps across a whole list. Used on
 * backup import so a file cannot grow past 20 groups or 8 per channel.
 */
export function sanitizeListGroups(channels) {
  const list = Array.isArray(channels) ? channels : [];
  const allowed = [];
  const seen = new Set();
  for (const ch of list) {
    for (const name of sanitizeChannelGroups(ch?.groups)) {
      const key = fold(name);
      if (seen.has(key)) continue;
      if (allowed.length >= GROUP_MAX_DISTINCT) continue;
      seen.add(key);
      allowed.push(name);
    }
  }
  const canonical = new Map(allowed.map((name) => [fold(name), name]));
  return list.map((ch) => {
    const groups = [];
    const have = new Set();
    for (const name of sanitizeChannelGroups(ch?.groups)) {
      const key = fold(name);
      if (!canonical.has(key) || have.has(key)) continue;
      have.add(key);
      groups.push(canonical.get(key));
    }
    return { ...ch, groups };
  });
}

export function channelInGroup(ch, groupName) {
  const key = groupKey(groupName);
  if (!key) return false;
  return sanitizeChannelGroups(ch?.groups).some((name) => fold(name) === key);
}

/**
 * Run `job` after `prev` settles, even if `prev` rejected. Group ticks
 * share one chain so two read-modify-writes cannot skip a tick.
 */
export function chainSerial(prev, job) {
  return Promise.resolve(prev).then(() => job(), () => job());
}

/** Canonical spelling if that group still exists, otherwise '' (All). */
export function resolvedFeedGroup(channels, raw) {
  const key = fold(String(raw || '').trim());
  if (!key) return '';
  return groupNamesInList(channels).find((name) => fold(name) === key) || '';
}

/**
 * Channel ids the Feeds tab (and the badge) count. `null` means every
 * channel — favourites-only and an unknown group both fall through.
 */
export function feedChannelIds(channels, settings) {
  const favOnly = !!settings?.feed?.favoritesOnly;
  const group = resolvedFeedGroup(channels, settings?.feed?.group);
  if (!favOnly && !group) return null;
  const ids = new Set();
  for (const ch of channels || []) {
    if (!ch?.id) continue;
    if (favOnly && !ch.favorite) continue;
    if (group && !channelInGroup(ch, group)) continue;
    ids.add(ch.id);
  }
  return ids;
}

/**
 * Add or remove `rawName` on one channel. Caps refuse the change and
 * leave the list as it was. Error is `empty` | `missing` | `channelCap`
 * | `listCap` | ''.
 */
export function applyChannelGroup(channels, channelId, rawName, on) {
  const list = Array.isArray(channels) ? channels : [];
  const name = normalizeGroupName(rawName);
  if (!name) return { channels: list, error: 'empty' };
  const key = fold(name);
  const idx = list.findIndex((ch) => ch && ch.id === channelId);
  if (idx < 0) return { channels: list, error: 'missing' };

  const current = sanitizeChannelGroups(list[idx].groups);
  const already = current.findIndex((g) => fold(g) === key);

  if (!on) {
    if (already < 0) return { channels: list, error: '' };
    const groups = current.filter((_, i) => i !== already);
    const next = list.slice();
    next[idx] = { ...list[idx], groups };
    return { channels: next, error: '' };
  }

  if (already >= 0) return { channels: list, error: '' };
  if (current.length >= GROUP_MAX_PER_CHANNEL) {
    return { channels: list, error: 'channelCap' };
  }

  const existing = groupNamesInList(list);
  const known = existing.find((g) => fold(g) === key);
  if (!known && existing.length >= GROUP_MAX_DISTINCT) {
    return { channels: list, error: 'listCap' };
  }

  const next = list.slice();
  next[idx] = { ...list[idx], groups: [...current, known || name] };
  return { channels: next, error: '' };
}

export function isChannelRef(input) {
  return normalizeChannelInput(String(input || '').trim()) != null;
}

export function handleKey(handle) {
  return fold(String(handle || '').replace(/^@/, ''));
}

export function handleFromRef(ref) {
  if (!ref || ref.kind !== 'url') return '';
  try {
    const head = new URL(ref.url).pathname.split('/').filter(Boolean)[0] || '';
    return head.startsWith('@') ? handleKey(head) : '';
  } catch {
    return '';
  }
}

export function listedMatch(input, channels, feed) {
  const ref = normalizeChannelInput(String(input || '').trim());
  if (!ref) return null;
  if (ref.kind === 'id') return channels.find((ch) => ch.id === ref.id) || null;
  if (ref.kind === 'video') {
    const item = (feed || []).find((row) => row && row.v === ref.id);
    if (!item) return null;
    return channels.find((ch) => ch.id === item.c) || null;
  }
  const handle = handleFromRef(ref);
  if (!handle) return null;
  return channels.find((ch) => handleKey(ch.handle) === handle) || null;
}

export function listedVideo(input, items) {
  const ref = normalizeVideoInput(String(input || '').trim());
  if (!ref) return null;
  return items.find((item) => item && item.v === ref.id) || null;
}

export function matchesWatchlist(ch, raw) {
  const term = fold(raw);
  if (!term) return true;
  const handleTerm = term.replace(/^@/, '');
  return fold(ch.title).includes(term)
    || handleKey(ch.handle).includes(handleTerm)
    || String(ch.id || '').toLowerCase().includes(term);
}

export function matchesFeedFilter(item, channel, q) {
  const term = fold(q);
  if (!term) return true;
  if (fold(item.t).includes(term)) return true;
  if (fold(channel?.title || '').includes(term)) return true;
  const handleTerm = term.replace(/^@/, '');
  if (handleKey(channel?.handle || '').includes(handleTerm)) return true;
  if (fold(item.ct || '').includes(term)) return true;
  if (fold(item.v).includes(term)) return true;
  if (fold(item.c).includes(term)) return true;
  const ref = normalizeChannelInput(q);
  if (ref?.kind === 'video' && item.v === ref.id) return true;
  if (ref?.kind === 'id' && item.c === ref.id) return true;
  return false;
}

export function visibleFeedItems(feed, showShorts) {
  // Shorts stay in storage; the view drops them when the setting is off.
  const items = [];
  for (const item of feed) {
    if (!item || !item.v) continue;
    if (!showShorts && item.k === 'short') continue;
    items.push(item);
  }
  items.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  return items;
}

export function feedItemUrl(item) {
  const id = String(item?.v || '');
  if (!id) return '';
  return item.k === 'short'
    ? `https://www.youtube.com/shorts/${id}`
    : `https://www.youtube.com/watch?v=${id}`;
}

export function audioWatchUrl(item) {
  const id = String(item?.v || '');
  if (!id) return '';
  return `https://www.youtube.com/watch?v=${id}`;
}

export function rowOpenModes(settings) {
  if (settings?.audio?.openFeedInAudioMode) {
    return { row: 'audio', button: 'normal' };
  }
  return { row: 'normal', button: 'audio' };
}

export function feedsView({ feed, channels, settings, query }) {
  const q = String(query || '').trim();
  const onList = !!listedMatch(q, channels, feed);
  const addable = !q || (isChannelRef(q) && !onList);
  const showShorts = !!settings?.feed?.showShorts;
  const favOnly = !!settings?.feed?.favoritesOnly;
  const group = resolvedFeedGroup(channels, settings?.feed?.group);
  const channelsById = new Map(channels.map((ch) => [ch.id, ch]));
  const channelIds = feedChannelIds(channels, settings);
  const items = visibleFeedItems(feed, showShorts).filter((item) => {
    if (channelIds && !channelIds.has(item.c)) return false;
    return true;
  });
  let shown = q
    ? items.filter((item) => matchesFeedFilter(item, channelsById.get(item.c), q))
    : items;
  // An exact URL / id still surfaces that row when favourites-only, a
  // group, or hidden shorts would have dropped it — you asked for that video.
  const hit = listedVideo(q, feed);
  let forced = false;
  if (hit && !shown.some((item) => item.v === hit.v)) {
    shown = [hit];
    forced = true;
  }

  const searching = !!q;
  const hasChannels = channels.length > 0;
  const hasAnyFeed = feed.length > 0;
  const hasShown = shown.length > 0;
  const showEmptyNone = !(hasChannels || hasAnyFeed || searching);
  const showEmptyGroup = !!group && !hasShown && !q && !showEmptyNone;

  return {
    items,
    shown,
    forced,
    total: items.length,
    onList,
    addable,
    query: q,
    searching,
    favOnly,
    group,
    showEmptyNone,
    showEmptyWait: hasChannels && !hasShown && !q && !favOnly && !group,
    showEmptyFav: (hasChannels || hasAnyFeed) && !hasShown && !q && favOnly && !group,
    showEmptyGroup,
    showEmptyFilter: searching && !hasShown,
  };
}

function hasId(ids, id) {
  if (!ids || id == null) return false;
  if (Array.isArray(ids)) return ids.includes(id);
  return !!ids[id];
}

export function audioTabView({
  tabs,
  activeTabId,
  lastSelectedId,
  playerTabIds,
  unreachableIds,
  core,
}) {
  const listed = [];
  for (const tab of tabs || []) {
    if (!tab || hasId(unreachableIds, tab.id)) continue;
    if (core.isControllableTab(tab, playerTabIds)) listed.push(tab);
  }
  const target = core.pickTargetTab(listed, {
    activeTabId,
    lastSelectedId,
    playerTabIds,
  });
  return {
    tabs: listed,
    target: target || null,
    targetId: target ? target.id : null,
    showPicker: listed.length >= 2,
    showNotice: !target,
  };
}

// Chrome keeps a range focused after a mouse drag. Focus is not
// "the user is dragging".
export function shouldSyncAudioSeek(dragging) {
  return !dragging;
}

// A select keeps focus after a pick. Skip the poll only while that
// control's write is still in flight.
export function shouldSyncAudioSelect(pending) {
  return !pending;
}

export function audioVolumeSelectValue(player) {
  if (!player) return null;
  if (player.muted) return 0;
  if (player.volume == null) return null;
  const n = Number(player.volume);
  if (!Number.isFinite(n)) return null;
  return n;
}

export function audioStatsView(stats, scope, now, core) {
  const filter = scope === 'all' ? 'all' : 'month';
  let listened = 0;
  let active = 0;
  if (filter === 'all' && stats && stats.totals && typeof stats.totals === 'object') {
    listened = Math.max(0, Number(stats.totals.listened) || 0);
    active = Math.max(0, Number(stats.totals.active) || 0);
  } else {
    listened = core.sumLogs(stats && stats.listened, filter, now);
    active = core.sumLogs(stats && stats.active, filter, now);
  }
  const savings = core.computeSavings(listened);
  return {
    listened,
    active,
    usedMb: savings.usedMb,
    savedMb: savings.savedMb,
  };
}

// Same 1024-MB step formatData uses when it switches the popup to GB.
export const RATE_NOTE_SAVED_MB = 1024;
export const RATE_NOTE_KEY = 'rateNoteDone';
export const CHROME_REVIEWS_URL = 'https://chromewebstore.google.com/detail/hpajekcplhidhjidohfmebpeianbhcgd/reviews';
export const EDGE_ADDONS_URL = 'https://microsoftedge.microsoft.com/addons/detail/companion-for-youtube/neaandgimpffglakmlbmmkmmmlahibfh';

/** True when all-time saved has reached 1 GB and the note has never been dismissed. */
export function showRateNote(savedMb, rateNoteDone) {
  if (rateNoteDone) return false;
  const n = Number(savedMb);
  return Number.isFinite(n) && n >= RATE_NOTE_SAVED_MB;
}

export function storeReviewsUrl(userAgent) {
  return String(userAgent || '').includes('Edg/') ? EDGE_ADDONS_URL : CHROME_REVIEWS_URL;
}

/**
 * The sentence for a channel whose last check failed, as a message key and
 * its substitutions, or null when it did not fail. Records written before
 * the worker kept `kind` carry only the English message, so the status is
 * read back out of "feed failed (404)".
 */
export function channelProblem(lastError) {
  if (!lastError || typeof lastError !== 'object') return null;
  const message = String(lastError.message || '');
  let kind = lastError.kind;
  let status = Number(lastError.status) || 0;
  if (!kind) {
    const http = message.match(/failed \((\d{3})\)/);
    if (http) {
      kind = 'http';
      status = Number(http[1]);
    } else if (/network error/.test(message)) kind = 'network';
    else if (/parse error/.test(message)) kind = 'parse';
  }
  if (kind === 'http' && status === 404) return { key: 'channelProblemGone', subs: [] };
  if (kind === 'http' && status) return { key: 'channelProblemHttp', subs: [String(status)] };
  if (kind === 'network') return { key: 'channelProblemNetwork', subs: [] };
  if (kind === 'parse') return { key: 'channelProblemUnreadable', subs: [] };
  return { key: 'channelProblemOther', subs: [] };
}

/**
 * The channels a watch page credits, each marked when it is on the list.
 * `page` is what the content script read: `channels` holds a normal video's
 * channel (with its handle or id) or every channel of a collab video, and
 * `channel` is the name on the owner line. A channel with an id is matched by
 * it; otherwise by handle or exact title. A stored copy of the video means
 * its one channel is followed.
 */
export function pageChannelsView({ page, videoId, channels, feed }) {
  const list = Array.isArray(channels) ? channels : [];
  const credited = Array.isArray(page?.channels) ? page.channels.filter(Boolean) : [];
  const name = String(page?.channel || '').trim();
  // A collab line with no list behind it is several names in one string.
  const rows = credited.length ? credited : (name && !page?.collab ? [{ name }] : []);
  const stored = videoId ? (feed || []).find((row) => row && row.v === videoId) : null;
  return rows.map((row) => {
    const id = String(row.id || '');
    const handle = handleKey(row.handle);
    const title = String(row.name || '').trim();
    let followed;
    if (id) followed = list.some((ch) => ch.id === id);
    else {
      // A stored channel can lack a handle, so the name still counts.
      followed = list.some((ch) => (handle && handleKey(ch.handle) === handle) || fold(ch.title) === fold(title));
    }
    if (!followed && stored && rows.length === 1) followed = list.some((ch) => ch.id === stored.c);
    return { id, name: title, followed };
  });
}

const HIDDEN_FOLLOW = { show: false, kind: '', rows: [] };

/**
 * The Follow card for the focused tab: a YouTube channel or video page with a
 * channel not on the list. It fetches nothing, so "on the list" is what
 * stored data can tell. What slips past that is caught by Add's own
 * "already added".
 *
 * Each row is `{ name, input, followed }`. A collab video lists every channel
 * and stays up while any of them is not followed; a followed one keeps its
 * row with a check instead of a button. A channel page's name comes from the
 * tab title.
 */
export function followView({ tab, page, channels, feed, core }) {
  const url = String(tab?.url || '');
  const ref = normalizeChannelInput(url);
  if (!ref) return HIDDEN_FOLLOW;
  if (ref.kind === 'video') {
    const credited = pageChannelsView({ page, videoId: ref.id, channels, feed });
    if (credited.length > 1) {
      if (credited.every((row) => row.followed)) return HIDDEN_FOLLOW;
      const rows = credited.map((row) => ({ name: row.name, input: row.id, followed: row.followed }));
      return { show: true, kind: 'collab', rows };
    }
    if (listedMatch(url, channels, feed) || credited[0]?.followed) return HIDDEN_FOLLOW;
    return { show: true, kind: 'video', rows: [{ name: credited[0]?.name || '', input: url, followed: false }] };
  }
  if (listedMatch(url, channels, feed)) return HIDDEN_FOLLOW;
  const title = String(tab?.title || '');
  // Before a channel page settles, its title is just "YouTube".
  const name = /\s-\sYouTube\s*$/.test(title) ? core.tabTitleToVideoTitle(title) : '';
  if (name && channels.some((ch) => fold(ch.title) === fold(name))) return HIDDEN_FOLLOW;
  return { show: true, kind: 'channel', rows: [{ name, input: url, followed: false }] };
}

/**
 * Which Follow buttons wait, given the inputs already in flight.
 * Only a pending row is disabled; a followed row has no button.
 */
export function followActionState(rows, pendingInputs) {
  const pending = new Set(
    pendingInputs instanceof Set
      ? pendingInputs
      : (Array.isArray(pendingInputs) ? pendingInputs : []),
  );
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const input = row?.input || '';
    const followed = !!row?.followed;
    const waiting = !followed && input !== '' && pending.has(input);
    return { input, followed, pending: waiting, disabled: waiting };
  });
}

/**
 * Backup merge past the channel cap is an English sentence from the worker.
 * Map that one; every other backup error is already a sentence to show as-is.
 */
export function backupImportMessage(error, maxChannels) {
  const max = Number(maxChannels);
  const code = String(error || '');
  if (Number.isFinite(max) && code === `Merging that backup would go past ${max} channels.`) {
    return { key: 'settingsImportTooMany', subs: [String(max)] };
  }
  return { key: '', text: code };
}

/** Whole minutes left on a sleep timer, rounded up; 0 when none runs. */
export function sleepMinutesLeft(sleepAt, now) {
  const left = Number(sleepAt) - Number(now);
  return Number.isFinite(left) && left > 0 ? Math.ceil(left / 60000) : 0;
}

/**
 * Next ⋯-menu item for Arrow/Home/End. Wraps at both ends so Down
 * from the last item is the first, matching what a role=menu does.
 */
export function menuNavIndex(key, current, count) {
  const n = Math.max(0, Number(count) || 0);
  if (n === 0) return 0;
  const raw = Number(current);
  const i = Number.isFinite(raw) ? Math.min(Math.max(0, Math.trunc(raw)), n - 1) : 0;
  if (key === 'Home') return 0;
  if (key === 'End') return n - 1;
  if (key === 'ArrowDown') return (i + 1) % n;
  if (key === 'ArrowUp') return (i - 1 + n) % n;
  return i;
}

/**
 * True when `item.at` is a real upload time newer than the last popup
 * open. `at: 0` is "unknown", not 1970, and a missing/zero `seenAt`
 * treats every dated row as new — the same rule as the toolbar badge.
 */
export function isNewSince(item, seenAt) {
  const at = Number(item?.at);
  if (!(at > 0)) return false;
  const seen = Number(seenAt) || 0;
  return at > seen;
}

/**
 * A player reply counts when it is playing, or paused with a real
 * position that is not the end. Missing/NaN `currentTime` is not a
 * position, so that tab does not count.
 */
function playerIsActive(player) {
  if (!player || player.ok === false) return false;
  const t = Number(player.currentTime);
  if (!Number.isFinite(t) || t < 0) return false;
  if (player.ended === true) return false;
  const d = Number(player.duration);
  if (Number.isFinite(d) && d > 0 && t >= d) return false;
  if (player.paused === false) return true;
  return t > 0;
}

/**
 * Which tab the popup opens on, from the YouTube tabs probed at open.
 * `'audio'` is the Player tab's id. Audio mode on any tab wins;
 * otherwise a playing or paused-partway player; otherwise Feeds.
 */
export function openingTab({ players, audioOn } = {}) {
  if (audioOn) return 'audio';
  const list = Array.isArray(players) ? players : [];
  for (const player of list) {
    if (player && player.on) return 'audio';
    if (playerIsActive(player)) return 'audio';
  }
  return 'feeds';
}

export function watchlistView({ channels, feed, query }) {
  const q = String(query || '').trim();
  const shown = q ? channels.filter((ch) => matchesWatchlist(ch, q)) : channels;
  const onList = !!listedMatch(q, channels, feed);
  const addable = !q || (isChannelRef(q) && !onList);
  const searching = !!q;
  return {
    shown,
    total: channels.length,
    onList,
    addable,
    noMatch: shown.length === 0 && searching,
    query: q,
    searching,
  };
}
