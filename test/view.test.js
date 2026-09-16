/**
 * Popup view decisions: feed/watchlist filters, row matching, Add-enabled,
 * the exact-URL force-show, Audio-tab target choice, stats folding, how a
 * failed channel is described, and the Follow card.
 * Hand-made rows; no fixtures, no network.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  fold,
  handleKey,
  handleFromRef,
  isChannelRef,
  listedMatch,
  listedVideo,
  matchesWatchlist,
  matchesFeedFilter,
  visibleFeedItems,
  feedItemUrl,
  audioWatchUrl,
  rowOpenModes,
  feedsView,
  watchlistView,
  audioTabView,
  audioStatsView,
  shouldSyncAudioSeek,
  shouldSyncAudioSelect,
  audioVolumeSelectValue,
  channelProblem,
  followView,
  followActionState,
  backupImportMessage,
  pageChannelsView,
  sleepMinutesLeft,
  menuNavIndex,
} from '../src/lib/view.js';
import { MAX_BACKUP_CHANNELS } from '../src/lib/backup.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FAV = 'UCfav0000000000000000001';
const OTH = 'UCoth0000000000000000001';
const VID_NEW = 'vidNewest01';
const VID_MID = 'vidMiddle01';
const VID_OLD = 'vidOldest01';
const VID_SHORT = 'vidShorts01';
const VID_OTH = 'vidOther001';

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function item(v, extra = {}) {
  return {
    v,
    c: extra.c || FAV,
    t: extra.t || v,
    at: extra.at ?? 0,
    d: extra.d ?? 0,
    vw: extra.vw ?? 0,
    k: extra.k || 'video',
    st: extra.st ?? 0,
    ct: extra.ct,
  };
}

function channel(id, extra = {}) {
  return {
    id,
    title: extra.title || id,
    handle: extra.handle || `@${id}`,
    favorite: !!extra.favorite,
  };
}

function sample() {
  return {
    channels: [
      channel(FAV, { title: 'Favourite Channel', handle: '@favchannel', favorite: true }),
      channel(OTH, { title: 'Other Channel', handle: '@otherchannel', favorite: false }),
    ],
    feed: [
      item(VID_OLD, { t: 'Old favourite', at: 100 }),
      item(VID_SHORT, { t: 'Favourite short', at: 400, k: 'short' }),
      item(VID_MID, { t: 'Mid favourite', at: 200 }),
      item(VID_OTH, { c: OTH, t: 'Other upload', at: 300 }),
      item(VID_NEW, { t: 'New favourite', at: 500 }),
    ],
  };
}

function settings({ showShorts = false, favoritesOnly = false } = {}) {
  return { feed: { showShorts, favoritesOnly } };
}

function vids(rows) {
  return rows.map((row) => row.v).join(',');
}

function ids(rows) {
  return rows.map((row) => row.id).join(',');
}

export default async function run(t) {
  const src = fs.readFileSync(path.join(ROOT, 'src/lib/view.js'), 'utf8');

  t.section('purity');

  t.check('does not import store.js', !/from ['"].*store\.js['"]/.test(src));
  t.check('does not import settings.js', !/from ['"].*settings\.js['"]/.test(src));
  t.check('does not touch chrome', !/\bchrome\./.test(src));
  t.check('does not touch the DOM', !/\bdocument\b/.test(src) && !/\bwindow\b/.test(src));
  t.check('does not capture Date.now', !/Date\.now/.test(src));

  t.section('fold / handles');

  t.check('fold lowercases', fold('MKBHD') === 'mkbhd');
  t.check(
    'fold NFKC-normalises fullwidth letters',
    fold('\uFF2D\uFF2B\uFF22\uFF28\uFF24') === 'mkbhd',
  );
  t.check('fold NFKC-splits a fi ligature', fold('\uFB01lm') === 'film');
  t.check('handleKey strips a leading @', handleKey('@MKBHD') === 'mkbhd');
  t.check('handleKey folds a bare handle', handleKey('MKBHD') === 'mkbhd');
  t.check(
    'handleFromRef reads an @handle URL',
    handleFromRef({ kind: 'url', url: 'https://www.youtube.com/@MKBHD' }) === 'mkbhd',
  );
  t.check(
    'handleFromRef ignores a /channel/ URL',
    handleFromRef({ kind: 'url', url: `https://www.youtube.com/channel/${FAV}` }) === '',
  );
  t.check('handleFromRef ignores kind id', handleFromRef({ kind: 'id', id: FAV }) === '');

  t.section('feedItemUrl');

  t.check(
    'a short opens /shorts/<id>',
    feedItemUrl(item(VID_SHORT, { k: 'short' })) === `https://www.youtube.com/shorts/${VID_SHORT}`,
  );
  t.check(
    'a normal video opens /watch?v=<id>',
    feedItemUrl(item(VID_NEW)) === `https://www.youtube.com/watch?v=${VID_NEW}`,
  );
  t.check(
    'a live opens /watch?v=<id>',
    feedItemUrl(item(VID_NEW, { k: 'live' })) === `https://www.youtube.com/watch?v=${VID_NEW}`,
  );
  t.check(
    'a premiere opens /watch?v=<id>',
    feedItemUrl(item(VID_NEW, { k: 'premiere' })) === `https://www.youtube.com/watch?v=${VID_NEW}`,
  );
  t.check('missing id is empty', feedItemUrl({}) === '');

  t.section('audioWatchUrl');

  t.check(
    'a video opens /watch?v=<id>',
    audioWatchUrl(item(VID_NEW)) === `https://www.youtube.com/watch?v=${VID_NEW}`,
  );
  t.check(
    'a short still opens /watch?v=<id>',
    audioWatchUrl(item(VID_SHORT, { k: 'short' })) === `https://www.youtube.com/watch?v=${VID_SHORT}`,
  );
  t.check(
    'a live opens /watch?v=<id>',
    audioWatchUrl(item(VID_NEW, { k: 'live' })) === `https://www.youtube.com/watch?v=${VID_NEW}`,
  );
  t.check('audioWatchUrl missing id is empty', audioWatchUrl({}) === '');

  t.section('rowOpenModes');

  t.check(
    'setting off: row normal, button audio',
    same(rowOpenModes({ audio: { openFeedInAudioMode: false } }), { row: 'normal', button: 'audio' }),
  );
  t.check(
    'setting on: row audio, button normal',
    same(rowOpenModes({ audio: { openFeedInAudioMode: true } }), { row: 'audio', button: 'normal' }),
  );
  t.check(
    'missing settings: row normal, button audio',
    same(rowOpenModes(undefined), { row: 'normal', button: 'audio' }),
  );

  t.section('visibleFeedItems');

  const { feed } = sample();
  const snapshot = JSON.parse(JSON.stringify(feed));
  t.check(
    'shorts hidden by default',
    vids(visibleFeedItems(feed, false)) === `${VID_NEW},${VID_OTH},${VID_MID},${VID_OLD}`,
    vids(visibleFeedItems(feed, false)),
  );
  t.check(
    'shorts shown when the flag is on',
    vids(visibleFeedItems(feed, true)) === `${VID_NEW},${VID_SHORT},${VID_OTH},${VID_MID},${VID_OLD}`,
    vids(visibleFeedItems(feed, true)),
  );
  t.check('newest first', vids(visibleFeedItems(feed, false)) === `${VID_NEW},${VID_OTH},${VID_MID},${VID_OLD}`);
  t.check('does not mutate the input feed', same(feed, snapshot));
  t.check(
    'drops rows with no video id',
    visibleFeedItems([item(VID_NEW), { t: 'no id', at: 999 }, null], false).length === 1,
  );

  t.section('shorts and favourites');

  const base = sample();
  const hidden = feedsView({ ...base, settings: settings(), query: '' });
  t.check(
    'feedsView hides shorts when the setting is off',
    vids(hidden.shown) === `${VID_NEW},${VID_OTH},${VID_MID},${VID_OLD}` && !hidden.forced,
    vids(hidden.shown),
  );
  t.check('showing count total matches the filtered list', hidden.total === 4, String(hidden.total));

  const withShorts = feedsView({
    ...base,
    settings: settings({ showShorts: true }),
    query: '',
  });
  t.check(
    'feedsView keeps shorts when the setting is on',
    vids(withShorts.shown) === `${VID_NEW},${VID_SHORT},${VID_OTH},${VID_MID},${VID_OLD}`,
    vids(withShorts.shown),
  );

  const favOnly = feedsView({
    ...base,
    settings: settings({ favoritesOnly: true }),
    query: '',
  });
  t.check(
    'favourites-only drops a non-favourite channel',
    vids(favOnly.shown) === `${VID_NEW},${VID_MID},${VID_OLD}` && favOnly.favOnly,
    vids(favOnly.shown),
  );
  t.check(
    'favourites-only does nothing when off',
    vids(hidden.shown) === `${VID_NEW},${VID_OTH},${VID_MID},${VID_OLD}`,
  );

  const favShorts = feedsView({
    ...base,
    settings: settings({ showShorts: true, favoritesOnly: true }),
    query: '',
  });
  t.check(
    'favourites-only plus shorts keeps a favourite short',
    vids(favShorts.shown) === `${VID_NEW},${VID_SHORT},${VID_MID},${VID_OLD}`,
    vids(favShorts.shown),
  );

  t.section('text filter');

  const titled = feedsView({ ...base, settings: settings(), query: 'New favourite' });
  t.check('matches a video title', vids(titled.shown) === VID_NEW, vids(titled.shown));

  const chTitle = feedsView({ ...base, settings: settings(), query: 'Other Channel' });
  t.check('matches a channel title', vids(chTitle.shown) === VID_OTH, vids(chTitle.shown));

  const withAt = feedsView({ ...base, settings: settings(), query: '@favchannel' });
  t.check(
    'matches a handle with a leading @',
    vids(withAt.shown) === `${VID_NEW},${VID_MID},${VID_OLD}`,
    vids(withAt.shown),
  );

  const noAt = feedsView({ ...base, settings: settings(), query: 'favchannel' });
  t.check(
    'matches a handle without a leading @',
    vids(noAt.shown) === `${VID_NEW},${VID_MID},${VID_OLD}`,
    vids(noAt.shown),
  );

  const byChId = feedsView({ ...base, settings: settings(), query: FAV });
  t.check(
    'matches a channel id',
    vids(byChId.shown) === `${VID_NEW},${VID_MID},${VID_OLD}`,
    vids(byChId.shown),
  );

  const byVid = feedsView({ ...base, settings: settings(), query: VID_NEW });
  t.check('matches a video id', vids(byVid.shown) === VID_NEW, vids(byVid.shown));

  const cased = feedsView({ ...base, settings: settings(), query: 'NEW FAVOURITE' });
  t.check('folds case', vids(cased.shown) === VID_NEW, vids(cased.shown));

  const unicodeFeed = {
    channels: [
      channel(FAV, { title: 'Film Review', handle: '@mkbhd', favorite: true }),
    ],
    feed: [item(VID_NEW, { t: 'MKBHD look', at: 1 })],
  };
  const fullwidth = feedsView({
    ...unicodeFeed,
    settings: settings(),
    query: '\uFF2D\uFF2B\uFF22\uFF28\uFF24',
  });
  t.check(
    'folds Unicode fullwidth into the handle',
    vids(fullwidth.shown) === VID_NEW,
    vids(fullwidth.shown),
  );
  const ligature = feedsView({
    ...unicodeFeed,
    settings: settings(),
    query: '\uFB01lm',
  });
  t.check(
    'folds a Unicode ligature into the channel title',
    vids(ligature.shown) === VID_NEW,
    vids(ligature.shown),
  );

  t.check(
    'matchesWatchlist matches a title',
    matchesWatchlist(base.channels[0], 'favourite'),
  );
  t.check(
    'matchesWatchlist matches @handle',
    matchesWatchlist(base.channels[0], '@favchannel'),
  );
  t.check(
    'matchesWatchlist matches a bare handle',
    matchesWatchlist(base.channels[0], 'favchannel'),
  );
  t.check(
    'matchesWatchlist matches a channel id',
    matchesWatchlist(base.channels[0], FAV),
  );
  t.check(
    'matchesWatchlist folds case',
    matchesWatchlist(base.channels[0], 'FAVOURITE CHANNEL'),
  );
  t.check(
    'matchesWatchlist folds Unicode',
    matchesWatchlist(unicodeFeed.channels[0], '\uFF2D\uFF2B\uFF22\uFF28\uFF24'),
  );

  t.check(
    'matchesFeedFilter matches item.ct when the channel is missing',
    matchesFeedFilter(item(VID_NEW, { t: 'x', ct: 'Fallback Name' }), null, 'fallback'),
  );

  t.section('exact video URL force-show');

  const droppedOther = feedsView({
    ...base,
    settings: settings({ favoritesOnly: true }),
    query: `https://www.youtube.com/watch?v=${VID_OTH}`,
  });
  t.check(
    'a watch URL surfaces a non-favourite row under favourites-only',
    droppedOther.forced && vids(droppedOther.shown) === VID_OTH,
    `${droppedOther.forced} ${vids(droppedOther.shown)}`,
  );
  t.check(
    'force-show replaces the list with that one row',
    droppedOther.shown.length === 1,
    String(droppedOther.shown.length),
  );

  const droppedShort = feedsView({
    ...base,
    settings: settings(),
    query: `https://www.youtube.com/shorts/${VID_SHORT}`,
  });
  t.check(
    'a shorts URL surfaces a hidden short',
    droppedShort.forced && vids(droppedShort.shown) === VID_SHORT,
    `${droppedShort.forced} ${vids(droppedShort.shown)}`,
  );

  const droppedBare = feedsView({
    ...base,
    settings: settings(),
    query: VID_SHORT,
  });
  t.check(
    'a bare video id surfaces a hidden short',
    droppedBare.forced && vids(droppedBare.shown) === VID_SHORT,
    `${droppedBare.forced} ${vids(droppedBare.shown)}`,
  );

  const alreadyShown = feedsView({
    ...base,
    settings: settings(),
    query: `https://www.youtube.com/watch?v=${VID_NEW}`,
  });
  t.check(
    'an exact URL of a visible row is not forced',
    !alreadyShown.forced && vids(alreadyShown.shown) === VID_NEW,
    `${alreadyShown.forced} ${vids(alreadyShown.shown)}`,
  );

  const titleMiss = feedsView({
    ...base,
    settings: settings({ favoritesOnly: true }),
    query: 'Other upload',
  });
  t.check(
    'a title fragment does not surface a dropped row',
    !titleMiss.forced && titleMiss.shown.length === 0 && titleMiss.showEmptyFilter,
    `${titleMiss.forced} ${vids(titleMiss.shown)}`,
  );

  t.section('Add enabled');

  const emptyBox = feedsView({ ...base, settings: settings(), query: '' });
  t.check('empty Feeds box keeps Add enabled', emptyBox.addable && !emptyBox.onList);

  const chUrl = feedsView({
    ...base,
    settings: settings(),
    query: 'https://www.youtube.com/@newone',
  });
  t.check('a channel URL not on the list enables Add', chUrl.addable && !chUrl.onList && isChannelRef(chUrl.query));

  const atHandle = feedsView({ ...base, settings: settings(), query: '@newone' });
  t.check('an @handle not on the list enables Add', atHandle.addable && !atHandle.onList);

  const bareHandle = feedsView({ ...base, settings: settings(), query: 'newone' });
  t.check('a bare handle not on the list enables Add', bareHandle.addable && !bareHandle.onList);

  const listedAt = feedsView({ ...base, settings: settings(), query: '@favchannel' });
  t.check(
    'Add disables when the query is an @handle already on the list',
    listedAt.onList && !listedAt.addable,
    `${listedAt.onList} ${listedAt.addable}`,
  );

  const listedBare = feedsView({ ...base, settings: settings(), query: 'favchannel' });
  t.check(
    'Add disables when the query is a bare handle already on the list',
    listedBare.onList && !listedBare.addable,
  );

  const listedUrl = feedsView({
    ...base,
    settings: settings(),
    query: 'https://www.youtube.com/@favchannel',
  });
  t.check(
    'Add disables when the query is a channel URL already on the list',
    listedUrl.onList && !listedUrl.addable,
  );

  const listedId = feedsView({ ...base, settings: settings(), query: FAV });
  t.check(
    'Add disables when the query is a channel id already on the list',
    listedId.onList && !listedId.addable,
  );

  const watchOnList = feedsView({
    ...base,
    settings: settings(),
    query: `https://www.youtube.com/watch?v=${VID_NEW}`,
  });
  t.check(
    'a watch URL of a listed channel disables Add',
    watchOnList.onList && !watchOnList.addable,
    `${watchOnList.onList} ${watchOnList.addable}`,
  );

  const nameFrag = feedsView({ ...base, settings: settings(), query: 'favourite ch' });
  t.check(
    'a title fragment is not a channel ref so Add stays off',
    !nameFrag.addable && !isChannelRef(nameFrag.query),
  );

  t.section('bare 11-character split');

  t.check('a bare 11-character token is a channel ref (handle) on Add', isChannelRef(VID_NEW));
  t.check(
    'listedVideo treats a bare 11-character token as a video id',
    listedVideo(VID_NEW, base.feed)?.v === VID_NEW,
  );
  t.check(
    'listedMatch treats a bare 11-character token as a handle, not the video\'s channel',
    listedMatch(VID_NEW, base.channels, base.feed) === null,
  );

  const bareVid = feedsView({ ...base, settings: settings(), query: VID_NEW });
  t.check(
    'typing a listed video\'s id still enables Add (it is a handle, not an on-list channel)',
    bareVid.addable && !bareVid.onList && vids(bareVid.shown) === VID_NEW,
    `${bareVid.addable} ${bareVid.onList} ${vids(bareVid.shown)}`,
  );

  const bareHidden = feedsView({ ...base, settings: settings(), query: VID_SHORT });
  t.check(
    'the same token force-shows a hidden short and still enables Add',
    bareHidden.forced && bareHidden.addable && !bareHidden.onList,
    `${bareHidden.forced} ${bareHidden.addable} ${bareHidden.onList}`,
  );

  t.section('feeds empty states');

  const none = feedsView({ feed: [], channels: [], settings: settings(), query: '' });
  t.check('no channels and no feed shows the no-channels empty state', none.showEmptyNone);
  t.check('no-channels hides the other empty states', !none.showEmptyWait && !none.showEmptyFav && !none.showEmptyFilter);

  const waiting = feedsView({ ...base, feed: [], settings: settings(), query: '' });
  t.check(
    'channels with an empty feed show the waiting empty state',
    waiting.showEmptyWait && !waiting.showEmptyNone && !waiting.showEmptyFav,
  );

  const noFav = feedsView({
    channels: [channel(OTH, { title: 'Other Channel', handle: '@otherchannel', favorite: false })],
    feed: [item(VID_OTH, { c: OTH, t: 'Other upload', at: 300 })],
    settings: settings({ favoritesOnly: true }),
    query: '',
  });
  t.check('favourites-only with nothing to show uses the favourites empty state', noFav.showEmptyFav && !noFav.showEmptyWait);

  const miss = feedsView({ ...base, settings: settings(), query: 'zzzz-no-match' });
  t.check('a miss uses the filter empty state', miss.showEmptyFilter && miss.shown.length === 0);
  t.check('a miss of a handle still enables Add', miss.addable && isChannelRef('zzzz-no-match'));

  t.section('watchlistView');

  const wlEmpty = watchlistView({ channels: base.channels, feed: base.feed, query: '' });
  t.check('empty Watchlist box keeps Add enabled', wlEmpty.addable && !wlEmpty.onList && !wlEmpty.noMatch);
  t.check('empty query shows every channel', wlEmpty.shown.length === 2 && wlEmpty.total === 2);
  t.check(
    'watchlistView keeps the caller\'s channel order',
    ids(watchlistView({
      channels: [base.channels[1], base.channels[0]],
      feed: base.feed,
      query: '',
    }).shown) === `${OTH},${FAV}`,
  );

  const wlFilter = watchlistView({ channels: base.channels, feed: base.feed, query: 'other' });
  t.check('Watchlist text filter matches a title', ids(wlFilter.shown) === OTH, ids(wlFilter.shown));
  t.check('Watchlist count total is the unfiltered length', wlFilter.total === 2, String(wlFilter.total));

  const wlAt = watchlistView({ channels: base.channels, feed: base.feed, query: '@favchannel' });
  t.check('Watchlist matches an @handle', ids(wlAt.shown) === FAV && wlAt.onList && !wlAt.addable);

  const wlBare = watchlistView({ channels: base.channels, feed: base.feed, query: 'favchannel' });
  t.check('Watchlist matches a bare handle', ids(wlBare.shown) === FAV && wlBare.onList && !wlBare.addable);

  const wlNew = watchlistView({ channels: base.channels, feed: base.feed, query: '@newone' });
  t.check(
    'a handle not on the list enables Add and shows the no-match line',
    wlNew.addable && !wlNew.onList && wlNew.noMatch,
  );

  const wlName = watchlistView({ channels: base.channels, feed: base.feed, query: 'nobody here' });
  t.check(
    'a name with spaces disables Add and shows the no-match line',
    !wlName.addable && wlName.noMatch && !isChannelRef('nobody here'),
  );

  const wlUrl = watchlistView({
    channels: base.channels,
    feed: base.feed,
    query: `https://www.youtube.com/watch?v=${VID_OTH}`,
  });
  t.check(
    'a watch URL of a listed channel marks Watchlist on-list',
    wlUrl.onList && !wlUrl.addable,
  );

  const wlUnicode = watchlistView({
    channels: unicodeFeed.channels,
    feed: unicodeFeed.feed,
    query: '\uFB01lm',
  });
  t.check('Watchlist folds a Unicode ligature', ids(wlUnicode.shown) === FAV, ids(wlUnicode.shown));

  t.check('isChannelRef accepts a channel URL', isChannelRef('https://www.youtube.com/@mkbhd'));
  t.check('isChannelRef accepts an @handle', isChannelRef('@mkbhd'));
  t.check('isChannelRef accepts a bare handle', isChannelRef('mkbhd'));
  t.check('isChannelRef rejects an empty box', !isChannelRef(''));
  t.check('isChannelRef rejects a name with spaces', !isChannelRef('marques brownlee'));

  t.section('audio tab target');

  const coreSrc = fs.readFileSync(path.join(ROOT, 'src/content/core.js'), 'utf8');
  const coreBox = { URL };
  vm.createContext(coreBox);
  vm.runInContext(coreSrc, coreBox, { filename: 'src/content/core.js' });
  const core = coreBox.AudioModeCore;

  function watchTab(over) {
    return Object.assign({
      id: 1,
      url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
      title: 'A lecture - YouTube',
      audible: false,
      mutedInfo: { muted: false },
      lastAccessed: 100,
      windowId: 1,
      index: 0,
    }, over);
  }

  const noTabs = audioTabView({ tabs: [], core });
  t.check('no tabs: notice, no picker, no target', noTabs.showNotice && !noTabs.showPicker && noTabs.target === null);

  const one = audioTabView({
    tabs: [watchTab({ id: 4 })],
    core,
  });
  t.check('one watch tab: no picker, has a target', !one.showPicker && !one.showNotice && one.targetId === 4, JSON.stringify(one));

  const two = audioTabView({
    tabs: [watchTab({ id: 1, lastAccessed: 1 }), watchTab({ id: 2, lastAccessed: 2 })],
    activeTabId: 1,
    core,
  });
  t.check(
    'two watch tabs: picker shown and the active tab is the target',
    two.showPicker && two.tabs.length === 2 && two.targetId === 1 && !two.showNotice,
    JSON.stringify({ showPicker: two.showPicker, targetId: two.targetId, n: two.tabs.length }),
  );

  const lastWins = audioTabView({
    tabs: [watchTab({ id: 1 }), watchTab({ id: 2 })],
    activeTabId: 99,
    lastSelectedId: 2,
    core,
  });
  t.check(
    'lastSelectedId wins when the active tab is not a watch URL',
    lastWins.targetId === 2 && lastWins.showPicker,
    String(lastWins.targetId),
  );

  const unreachable = audioTabView({
    tabs: [watchTab({ id: 1 }), watchTab({ id: 2 })],
    unreachableIds: [1, 2],
    core,
  });
  t.check(
    'unreachable tabs fall through to the notice',
    unreachable.showNotice && !unreachable.showPicker && unreachable.target === null,
  );

  const oneReachable = audioTabView({
    tabs: [watchTab({ id: 1 }), watchTab({ id: 2 })],
    unreachableIds: [1],
    core,
  });
  t.check(
    'one reachable of two: no picker, remaining tab is the target',
    !oneReachable.showPicker && oneReachable.targetId === 2 && !oneReachable.showNotice,
    JSON.stringify({ showPicker: oneReachable.showPicker, targetId: oneReachable.targetId }),
  );

  const mini = audioTabView({
    tabs: [{ id: 7, url: 'https://www.youtube.com/' }],
    playerTabIds: [7],
    core,
  });
  t.check(
    'a listed miniplayer tab is controllable',
    mini.targetId === 7 && !mini.showNotice && !mini.showPicker,
    String(mini.targetId),
  );

  t.section('channel problem');

  const problemKey = (lastError) => channelProblem(lastError)?.key ?? null;
  t.check('no error, no problem', channelProblem(null) === null && channelProblem(undefined) === null);
  t.check('a 404 says the channel cannot be found', problemKey({ at: 1, message: 'feed failed (404)', kind: 'http', status: 404 }) === 'channelProblemGone');
  const http500 = channelProblem({ at: 1, message: 'feed failed (500)', kind: 'http', status: 500 });
  t.check('another status names its code', http500?.key === 'channelProblemHttp' && http500.subs[0] === '500', JSON.stringify(http500));
  t.check('network', problemKey({ at: 1, message: 'feed network error', kind: 'network' }) === 'channelProblemNetwork');
  t.check('parse', problemKey({ at: 1, message: 'feed parse error', kind: 'parse' }) === 'channelProblemUnreadable');
  t.check('an error from outside yt.js still gets a sentence', problemKey({ at: 1, message: 'boom' }) === 'channelProblemOther');
  // Stored before the worker kept kind and status.
  const oldHttp = channelProblem({ at: 1, message: 'feed failed (503)' });
  t.check('an older record is read from its message', oldHttp?.key === 'channelProblemHttp' && oldHttp.subs[0] === '503', JSON.stringify(oldHttp));
  t.check('an older 404 record', problemKey({ at: 1, message: 'feed failed (404)' }) === 'channelProblemGone');
  t.check('an older network record', problemKey({ at: 1, message: 'feed network error' }) === 'channelProblemNetwork');
  t.check('an older parse record', problemKey({ at: 1, message: 'feed parse error' }) === 'channelProblemUnreadable');

  t.section('follow card');

  const MK = 'UCBJycsmduvYEL83R_U4JriQ';
  const VERITASIUM = 'UCHnyfMqiRRG1u-2MsSQLbXA';
  const STARTALK = 'UCqoAEDirJPjEUFcF2FklnBA';
  const followed = [{ id: MK, title: 'Marques Brownlee', handle: '@mkbhd' }];
  const storedFeed = [{ v: 'Od6M0AXpcxQ', c: MK, t: 'Stored video', at: 1, k: 'video' }];
  const follow = (tab, page = null, channels = followed) => followView({
    tab, page, channels, feed: storedFeed, core,
  });
  const onlyRow = (card) => (card.rows.length === 1 ? card.rows[0] : {});

  const newChannel = follow({ url: 'https://www.youtube.com/@veritasium/videos', title: 'Veritasium - YouTube' });
  t.check(
    'a channel page not on the list shows the card with its name',
    newChannel.show && newChannel.kind === 'channel' && onlyRow(newChannel).name === 'Veritasium'
      && onlyRow(newChannel).input === 'https://www.youtube.com/@veritasium/videos'
      && onlyRow(newChannel).followed === false,
    JSON.stringify(newChannel),
  );
  t.check(
    'the unread count in the title is not part of the name',
    onlyRow(follow({ url: 'https://www.youtube.com/@veritasium', title: '(3) Veritasium - YouTube' })).name === 'Veritasium',
  );
  t.check(
    'a channel page still loading has no name yet',
    onlyRow(follow({ url: 'https://www.youtube.com/@veritasium', title: 'YouTube' })).name === '',
  );
  t.check('a followed handle hides the card', !follow({ url: 'https://www.youtube.com/@MKBHD', title: 'Marques Brownlee - YouTube' }).show);
  t.check('a followed channel id hides the card', !follow({ url: `https://www.youtube.com/channel/${MK}`, title: 'x - YouTube' }).show);
  t.check('a stored video of a followed channel hides the card', !follow({ url: 'https://www.youtube.com/watch?v=Od6M0AXpcxQ', title: 'Stored video - YouTube' }).show);
  const unknownVideo = follow(
    { url: 'https://www.youtube.com/watch?v=zzzzzzzzzzz', title: 'Some video - YouTube' },
    { channel: 'Veritasium', channels: [{ handle: '@veritasium', name: 'Veritasium' }] },
  );
  t.check(
    'a video by someone else shows the card with the page\'s channel name',
    unknownVideo.show && unknownVideo.kind === 'video' && onlyRow(unknownVideo).name === 'Veritasium'
      && onlyRow(unknownVideo).input === 'https://www.youtube.com/watch?v=zzzzzzzzzzz',
    JSON.stringify(unknownVideo),
  );
  t.check(
    'a video never takes its name from the tab title, which is the video\'s',
    onlyRow(follow({ url: 'https://www.youtube.com/watch?v=zzzzzzzzzzz', title: 'Some video - YouTube' })).name === '',
  );
  t.check(
    'an older video of a followed channel is hidden by the handle the page links to',
    !follow({ url: 'https://www.youtube.com/watch?v=yyyyyyyyyyy', title: 'Old - YouTube' }, { channel: 'MKBHD', channels: [{ handle: '@MKBHD', name: 'MKBHD' }] }).show,
  );
  t.check(
    'or by the name alone when the page gave no link',
    !follow({ url: 'https://www.youtube.com/watch?v=yyyyyyyyyyy', title: 'Old - YouTube' }, { channel: 'marques brownlee', channels: [] }).show,
  );
  t.check('a short counts as a video', follow({ url: 'https://www.youtube.com/shorts/zzzzzzzzzzz', title: 'x - YouTube' }).kind === 'video');
  t.check('the home page shows nothing', !follow({ url: 'https://www.youtube.com/', title: 'YouTube' }).show);
  t.check('search results show nothing', !follow({ url: 'https://www.youtube.com/results?search_query=x', title: 'x - YouTube' }).show);
  t.check('a non-YouTube tab shows nothing', !follow({ url: 'https://example.com/@veritasium', title: 'x' }).show);
  t.check('no tab shows nothing', !follow(null).show);

  t.section('follow card: collab videos');

  const collabTab = { url: 'https://www.youtube.com/watch?v=PHpsdIHpLUE', title: 'Aliens - YouTube' };
  const collabPage = (ids) => ({
    channel: 'Marques Brownlee and StarTalk',
    collab: true,
    channels: ids.map((id) => ({ id, handle: '', name: id === MK ? 'Marques Brownlee' : id === STARTALK ? 'StarTalk' : 'Veritasium' })),
  });
  const mixed = follow(collabTab, collabPage([MK, STARTALK]));
  t.check(
    'every channel gets a row, the followed one checked',
    mixed.show && mixed.kind === 'collab' && mixed.rows.length === 2
      && mixed.rows[0].followed === true && mixed.rows[0].name === 'Marques Brownlee'
      && mixed.rows[1].followed === false && mixed.rows[1].input === STARTALK,
    JSON.stringify(mixed),
  );
  const noneFollowed = follow(collabTab, collabPage([VERITASIUM, STARTALK]));
  t.check(
    'each row adds its own channel by id',
    noneFollowed.rows.map((row) => row.input).join() === `${VERITASIUM},${STARTALK}`
      && noneFollowed.rows.every((row) => !row.followed),
    JSON.stringify(noneFollowed),
  );
  t.check(
    'the card goes once every channel is followed',
    !follow(collabTab, collabPage([MK, STARTALK]), followed.concat({ id: STARTALK, title: 'StarTalk', handle: '' })).show,
  );
  t.check(
    'a stored video does not hide a collab card',
    follow({ url: 'https://www.youtube.com/watch?v=Od6M0AXpcxQ', title: 'x - YouTube' }, collabPage([MK, STARTALK])).show,
  );
  t.check(
    'an id is matched by id only, not by a channel with the same title',
    !follow(collabTab, collabPage([VERITASIUM, STARTALK]), [{ id: MK, title: 'StarTalk', handle: '' }]).rows[1].followed,
  );
  const listless = follow(collabTab, { channel: 'Marques Brownlee and StarTalk', collab: true, channels: [] });
  t.check(
    'a collab line with no list behind it shows no name, not the joined line',
    listless.show && listless.kind === 'video' && onlyRow(listless).name === '',
    JSON.stringify(listless),
  );

  t.section('follow button pending');

  const followRows = [
    { input: VERITASIUM, followed: false, name: 'Veritasium' },
    { input: STARTALK, followed: false, name: 'StarTalk' },
    { input: MK, followed: true, name: 'Marques Brownlee' },
  ];
  const idleFollow = followActionState(followRows, []);
  t.check(
    'nothing pending, unfollowed buttons stay enabled',
    idleFollow[0].disabled === false && idleFollow[1].disabled === false
      && idleFollow[0].pending === false && idleFollow[1].pending === false,
    JSON.stringify(idleFollow),
  );
  const onePending = followActionState(followRows, [VERITASIUM]);
  t.check(
    'only the pending row is disabled',
    onePending[0].disabled === true && onePending[0].pending === true
      && onePending[1].disabled === false && onePending[1].pending === false,
    JSON.stringify(onePending),
  );
  t.check(
    'a followed row has no pending button',
    onePending[2].followed === true && onePending[2].pending === false && onePending[2].disabled === false,
    JSON.stringify(onePending[2]),
  );
  const twoPending = followActionState(followRows, [VERITASIUM, STARTALK]);
  t.check(
    'two pending rows can wait at once',
    twoPending[0].pending && twoPending[1].pending && !twoPending[2].pending,
    JSON.stringify(twoPending),
  );
  t.check(
    'an empty pending list does not disable anyone',
    followActionState(followRows, null).every((row) => !row.disabled),
  );

  t.section('backup import error');

  t.check(
    'merge past the cap maps to settingsImportTooMany',
    same(backupImportMessage(`Merging that backup would go past ${MAX_BACKUP_CHANNELS} channels.`, MAX_BACKUP_CHANNELS), {
      key: 'settingsImportTooMany',
      subs: [String(MAX_BACKUP_CHANNELS)],
    }),
  );
  t.check(
    'any other backup error stays as the worker text',
    same(backupImportMessage('That file is not valid JSON.', MAX_BACKUP_CHANNELS), {
      key: '',
      text: 'That file is not valid JSON.',
    }),
  );
  t.check(
    'an empty error is empty text, not the cap key',
    same(backupImportMessage('', MAX_BACKUP_CHANNELS), { key: '', text: '' }),
  );

  t.section('credited channels');

  const credited = pageChannelsView({
    page: collabPage([MK, STARTALK]), videoId: 'PHpsdIHpLUE', channels: followed, feed: storedFeed,
  });
  t.check(
    'a collab video marks each channel',
    credited.map((row) => `${row.name}:${row.followed}`).join() === 'Marques Brownlee:true,StarTalk:false',
    JSON.stringify(credited),
  );
  t.check(
    'a normal video is followed by its handle',
    pageChannelsView({ page: { channel: 'MKBHD', channels: [{ handle: '@mkbhd', name: 'MKBHD' }] }, channels: followed, feed: [] })[0]?.followed === true,
  );
  t.check(
    'a stored copy of the video counts for a name that changed',
    pageChannelsView({ page: { channel: 'MKBHD (new name)', channels: [] }, videoId: 'Od6M0AXpcxQ', channels: followed, feed: storedFeed })[0]?.followed === true,
  );
  t.check(
    'a video with no channel read yet has no rows',
    pageChannelsView({ page: { channel: '', channels: [] }, videoId: 'zzzzzzzzzzz', channels: followed, feed: [] }).length === 0,
  );
  t.check(
    'no page, no rows',
    pageChannelsView({ page: null, videoId: '', channels: followed, feed: [] }).length === 0,
  );

  t.section('sleep timer');

  t.check('no timer, no minutes', sleepMinutesLeft(0, 1000) === 0 && sleepMinutesLeft(undefined, 1000) === 0);
  t.check('minutes round up', sleepMinutesLeft(1000 + 61_000, 1000) === 2);
  t.check('a full minute left is one', sleepMinutesLeft(1000 + 60_000, 1000) === 1);
  t.check('a timer in the past is none', sleepMinutesLeft(500, 1000) === 0);

  t.section('⋯ menu keyboard');

  t.check('ArrowDown steps forward', menuNavIndex('ArrowDown', 0, 3) === 1);
  t.check('ArrowDown wraps', menuNavIndex('ArrowDown', 2, 3) === 0);
  t.check('ArrowUp steps back', menuNavIndex('ArrowUp', 1, 3) === 0);
  t.check('ArrowUp wraps', menuNavIndex('ArrowUp', 0, 3) === 2);
  t.check('Home is the first item', menuNavIndex('Home', 2, 3) === 0);
  t.check('End is the last item', menuNavIndex('End', 0, 3) === 2);
  t.check('other keys stay put', menuNavIndex('Enter', 1, 3) === 1);
  t.check('one item stays on 0', menuNavIndex('ArrowDown', 0, 1) === 0);
  t.check('no items is 0', menuNavIndex('ArrowDown', 0, 0) === 0);

  t.section('audio player control sync');

  t.check('seek bar syncs when not dragging', shouldSyncAudioSeek(false) === true);
  t.check('seek bar holds while dragging', shouldSyncAudioSeek(true) === false);
  t.check('select syncs when not pending', shouldSyncAudioSelect(false) === true);
  t.check('select holds while its write is in flight', shouldSyncAudioSelect(true) === false);
  t.check(
    'muted maps the volume select to Mute',
    audioVolumeSelectValue({ muted: true, volume: 75 }) === 0,
  );
  t.check(
    'a missing volume leaves the select alone',
    audioVolumeSelectValue({ muted: false, volume: null }) === null,
  );
  t.check(
    'an unmuted volume is used',
    audioVolumeSelectValue({ muted: false, volume: 25 }) === 25,
  );
  t.check(
    'no player leaves the volume select alone',
    audioVolumeSelectValue(null) === null,
  );

  t.section('audio stats view');

  const now = new Date(2026, 8, 13).getTime();
  const month = audioStatsView({
    listened: { '2026-09-01': 60, '2026-08-31': 999 },
    active: { '2026-09-01': 80, '2026-08-31': 999 },
    totals: { listened: 5000, active: 6000 },
  }, 'month', now, core);
  t.check('This Month sums the day maps, not totals', month.listened === 60 && month.active === 80, JSON.stringify(month));

  const all = audioStatsView({
    listened: { '2026-09-01': 60 },
    active: { '2026-09-01': 80 },
    totals: { listened: 5000, active: 6000 },
  }, 'all', now, core);
  t.check('All Time reads totals, not the day maps', all.listened === 5000 && all.active === 6000, JSON.stringify(all));

  const legacy = audioStatsView({
    listened: { '2026-09-01': 60, '2026-08-01': 40 },
    active: { '2026-09-01': 10 },
  }, 'all', now, core);
  t.check(
    'All Time without totals falls back to the day maps',
    legacy.listened === 100 && legacy.active === 10,
    JSON.stringify(legacy),
  );

  const hour = audioStatsView({
    totals: { listened: 3600, active: 4000 },
  }, 'all', now, core);
  t.check(
    'data saved is against 720p',
    Math.round(hour.usedMb) === 72 && Math.round(hour.savedMb) === 528,
    JSON.stringify(hour),
  );
}
