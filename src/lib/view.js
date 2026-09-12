/**
 * Popup view decisions for the Feeds and Watchlist tabs: which rows
 * show, whether Add is live, and which empty state applies. Pure — no
 * DOM, no chrome, no clock.
 */

import { normalizeChannelInput, normalizeVideoInput } from './yt.js';

export function fold(value) {
  return String(value || '').normalize('NFKC').toLowerCase();
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

export function feedsView({ feed, channels, settings, query }) {
  const q = String(query || '').trim();
  const onList = !!listedMatch(q, channels, feed);
  const addable = !q || (isChannelRef(q) && !onList);
  const showShorts = !!settings?.feed?.showShorts;
  const favOnly = !!settings?.feed?.favoritesOnly;
  const channelsById = new Map(channels.map((ch) => [ch.id, ch]));
  const items = visibleFeedItems(feed, showShorts).filter((item) => {
    if (!favOnly) return true;
    return !!channelsById.get(item.c)?.favorite;
  });
  let shown = q
    ? items.filter((item) => matchesFeedFilter(item, channelsById.get(item.c), q))
    : items;
  // An exact URL / id still surfaces that row when favourites-only (or
  // hidden shorts) would have dropped it — you asked for that video.
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
    showEmptyNone: !(hasChannels || hasAnyFeed || searching),
    showEmptyWait: hasChannels && !hasShown && !q && !favOnly,
    showEmptyFav: (hasChannels || hasAnyFeed) && !hasShown && !q && favOnly,
    showEmptyFilter: searching && !hasShown,
  };
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
