/**
 * Store accessors: empty-store defaults, channel CRUD, feed merge, videoMeta
 * eviction, and pollState notified-id tracking.
 */

import { installChromeMock } from './helpers/chrome-mock.js';
import {
  readChannels,
  writeChannels,
  addChannel,
  updateChannel,
  removeChannel,
  setFavorite,
  sortChannelsForDisplay,
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
} from '../src/lib/store.js';

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function item(v, extra = {}) {
  return {
    v,
    c: extra.c || 'UCx',
    t: extra.t || v,
    at: extra.at ?? 0,
    d: extra.d ?? 0,
    vw: extra.vw ?? 0,
    k: extra.k || 'video',
    st: extra.st ?? 0,
  };
}

export default async function run(t) {
  const previous = globalThis.chrome;
  const mock = installChromeMock();

  try {
    t.section('empty store');

    t.check('readChannels is []', same(await readChannels(), []));
    t.check('readFeed is []', same(await readFeed(), []));
    t.check('readVideoMeta is {}', same(await readVideoMeta(), {}));
    const poll = await readPollState();
    t.check(
      'readPollState is the documented default',
      poll.running === false
        && poll.lastPollAt === 0
        && poll.lastFavPollAt === 0
        && poll.lastSeenAt === 0
        && same(poll.notified, []),
      JSON.stringify(poll),
    );

    await writeChannels(null);
    t.check('writeChannels(null) stores []', same(await readChannels(), []));
    await saveFeed(undefined);
    t.check('saveFeed(undefined) stores []', same(await readFeed(), []));
    await saveVideoMeta(null);
    t.check('saveVideoMeta(null) stores {}', same(await readVideoMeta(), {}));

    t.section('addChannel');

    const first = await addChannel({
      id: 'UCBJycsmduvYEL83R_U4JriQ',
      handle: '@mkbhd',
      title: 'Marques Brownlee',
      avatar: 'https://example/a.jpg',
    });
    t.check('addChannel reports added:true', first.added === true);
    t.check('addChannel appends the record', first.channels.length === 1);
    const rec = first.channels[0];
    t.check('fills favorite:false', rec.favorite === false);
    t.check('fills addedAt with Date.now()', typeof rec.addedAt === 'number' && rec.addedAt > 0);
    t.check('fills lastFetchAt:0', rec.lastFetchAt === 0);
    t.check('fills lastVideoAt:0', rec.lastVideoAt === 0);
    t.check('fills lastError:null', rec.lastError === null);
    t.check('fills seeded:false', rec.seeded === false);

    const dup = await addChannel({
      id: 'UCBJycsmduvYEL83R_U4JriQ',
      title: 'Someone Else',
    });
    t.check('duplicate id reports added:false', dup.added === false);
    t.check('duplicate id does not append', dup.channels.length === 1);
    t.check('duplicate id leaves the original title',
      dup.channels[0].title === 'Marques Brownlee');

    t.section('updateChannel / setFavorite');

    await updateChannel('UCBJycsmduvYEL83R_U4JriQ', { lastVideoAt: 99, lastError: { at: 1, message: 'x' } });
    const updated = (await readChannels())[0];
    t.check('updateChannel shallow-merges',
      updated.lastVideoAt === 99 && updated.lastError?.message === 'x' && updated.title === 'Marques Brownlee');
    const missing = await updateChannel('UCnope', { title: 'no' });
    t.check('updateChannel is a no-op when absent',
      missing.length === 1 && missing[0].title === 'Marques Brownlee');
    await setFavorite('UCBJycsmduvYEL83R_U4JriQ', true);
    t.check('setFavorite turns it on', (await readChannels())[0].favorite === true);
    await setFavorite('UCBJycsmduvYEL83R_U4JriQ', false);
    t.check('setFavorite turns it off', (await readChannels())[0].favorite === false);

    t.section('removeChannel');

    await addChannel({ id: 'UCother', title: 'Other' });
    await saveFeed([
      item('keep', { c: 'UCother', at: 2 }),
      item('drop-a', { c: 'UCBJycsmduvYEL83R_U4JriQ', at: 3 }),
      item('drop-b', { c: 'UCBJycsmduvYEL83R_U4JriQ', at: 1 }),
    ]);
    const removed = await removeChannel('UCBJycsmduvYEL83R_U4JriQ');
    t.check('removeChannel drops that channel',
      removed.channels.length === 1 && removed.channels[0].id === 'UCother');
    t.check('removeChannel drops that channel\'s feed items',
      removed.feed.length === 1 && removed.feed[0].v === 'keep',
      JSON.stringify(removed.feed));
    t.check('other channels\' feed items remain', removed.feed[0].c === 'UCother');

    t.section('mergeFeedItems');

    const incoming = [
      item('b', { at: 20, vw: 5 }),
      item('a', { at: 10, vw: 1 }),
      item('c', { at: 30, vw: 9 }),
    ];
    const firstMerge = mergeFeedItems([], incoming, 50);
    t.check('new items are counted in added', firstMerge.added.length === 3);
    t.check('sort is by at descending',
      firstMerge.feed.map((x) => x.v).join(',') === 'c,b,a',
      firstMerge.feed.map((x) => x.v).join(','));

    const updatedMerge = mergeFeedItems(
      firstMerge.feed,
      [item('b', { at: 20, vw: 99, k: 'video' })],
      50,
    );
    t.check('an existing v updates in place and is NOT counted as added',
      updatedMerge.added.length === 0 && updatedMerge.feed.find((x) => x.v === 'b')?.vw === 99);
    t.check('update does not duplicate the row',
      updatedMerge.feed.filter((x) => x.v === 'b').length === 1);

    const tied = mergeFeedItems(
      [],
      [item('zz', { at: 5 }), item('aa', { at: 5 })],
      50,
    );
    t.check('equal timestamps sort by v for a stable order',
      tied.feed.map((x) => x.v).join(',') === 'aa,zz',
      tied.feed.map((x) => x.v).join(','));

    const burst = [
      item('n1', { at: 1 }),
      item('n2', { at: 3 }),
      item('n3', { at: 2 }),
      item('n4', { at: 4 }),
    ];
    const capped = mergeFeedItems([], burst, 2);
    t.check('the cap truncates the stored feed', capped.feed.length === 2);
    t.check('truncated feed keeps the newest',
      capped.feed.map((x) => x.v).join(',') === 'n4,n2',
      capped.feed.map((x) => x.v).join(','));
    t.check('added reports pre-truncation',
      capped.added.length === 4, String(capped.added.length));

    const applied = await applyFeedMerge([item('live1', { at: 50, k: 'live', vw: 1 })], 10);
    t.check('applyFeedMerge persists',
      applied.added.length === 1 && (await readFeed())[0].v === 'live1');
    const settled = await applyFeedMerge([item('live1', { at: 50, k: 'video', d: 12, vw: 8 })], 10);
    t.check('applyFeedMerge updates a live item in place',
      settled.added.length === 0
        && (await readFeed())[0].k === 'video'
        && (await readFeed())[0].vw === 8);

    t.section('newSinceCount');

    const sinceFeed = [
      item('v1', { at: 100, k: 'video' }),
      item('s1', { at: 90, k: 'short' }),
      item('v2', { at: 80, k: 'video' }),
      item('v3', { at: 10, k: 'video' }),
    ];
    t.check('excludes shorts when showShorts is false',
      newSinceCount(sinceFeed, 50, false) === 2, String(newSinceCount(sinceFeed, 50, false)));
    t.check('includes shorts when showShorts is true',
      newSinceCount(sinceFeed, 50, true) === 3, String(newSinceCount(sinceFeed, 50, true)));
    t.check('items at lastSeenAt are not new',
      newSinceCount(sinceFeed, 100, true) === 0);

    const mixedFeed = [
      item('fav1', { at: 100, k: 'video', c: 'UCfav' }),
      item('oth1', { at: 90, k: 'video', c: 'UCoth' }),
      item('favs', { at: 80, k: 'short', c: 'UCfav' }),
      item('old1', { at: 10, k: 'video', c: 'UCfav' }),
    ];
    t.check('restricts to the given channel ids',
      newSinceCount(mixedFeed, 50, true, new Set(['UCfav'])) === 2,
      String(newSinceCount(mixedFeed, 50, true, new Set(['UCfav']))));
    t.check('restrict plus hide shorts',
      newSinceCount(mixedFeed, 50, false, new Set(['UCfav'])) === 1,
      String(newSinceCount(mixedFeed, 50, false, new Set(['UCfav']))));
    t.check('null channel set counts every channel',
      newSinceCount(mixedFeed, 50, true, null) === 3,
      String(newSinceCount(mixedFeed, 50, true, null)));
    t.check('omitted channel set keeps the showShorts positional arg',
      newSinceCount(mixedFeed, 50, true) === 3,
      String(newSinceCount(mixedFeed, 50, true)));
    t.check('empty channel set counts none',
      newSinceCount(mixedFeed, 50, true, new Set()) === 0);

    t.section('putVideoMeta');

    const seeded = {};
    for (let i = 0; i < 2999; i++) seeded['v' + i] = { k: 'video', d: 1, st: 0, at: i + 1 };
    const over = putVideoMeta(seeded, {
      noat: { k: 'video', d: 1, st: 0 },
      newest: { k: 'video', d: 1, st: 0, at: 10000 },
    });
    t.check('evicts to 3000', Object.keys(over).length === 3000, String(Object.keys(over).length));
    t.check('a record with no at goes first', over.noat === undefined);
    t.check('newest is kept', over.newest?.at === 10000);
    t.check('oldest finite at is kept when a no-at record is the extra',
      over.v0?.at === 1);

    const full = {};
    for (let i = 0; i < 3000; i++) full['k' + i] = { k: 'video', at: i + 10 };
    const evicted = putVideoMeta(full, { extra: { k: 'video', at: 99999 } });
    t.check('oldest finite at is dropped when the map is already full',
      evicted['k0'] === undefined && evicted.extra?.at === 99999 && Object.keys(evicted).length === 3000);

    await saveVideoMeta({ a: { k: 'live', at: 1 } });
    t.check('saveVideoMeta / readVideoMeta round-trip',
      (await readVideoMeta()).a.k === 'live');

    t.section('pendingLiveIds');

    const ids = pendingLiveIds({
      a: { k: 'live' },
      b: { k: 'video' },
      c: { k: 'premiere' },
      d: { k: 'short' },
      e: { k: 'live' },
    });
    t.check('returns only live and premiere',
      ids.length === 3 && ids.includes('a') && ids.includes('c') && ids.includes('e')
        && !ids.includes('b') && !ids.includes('d'),
      JSON.stringify(ids));

    const NOW = Date.parse('2026-09-14T12:00:00Z');
    const HOUR = 3_600_000;
    const due = pendingLiveIds({
      live: { k: 'live', st: NOW - HOUR, ck: NOW },
      nostart: { k: 'premiere', ck: NOW },
      soon: { k: 'premiere', st: NOW + 30 * 60_000, ck: NOW },
      late: { k: 'premiere', st: NOW - 10 * 60_000, ck: NOW },
      far: { k: 'premiere', st: NOW + 3 * 24 * HOUR, ck: NOW - HOUR },
      farstale: { k: 'premiere', st: NOW + 3 * 24 * HOUR, ck: NOW - 6 * HOUR },
      farnever: { k: 'premiere', st: NOW + 3 * 24 * HOUR },
    }, NOW).sort();
    t.check('a live stream is always due', due.includes('live'));
    t.check('a premiere with no start time is due', due.includes('nostart'));
    t.check('a premiere within the hour is due', due.includes('soon'));
    t.check('a premiere past its start is due', due.includes('late'));
    t.check('a premiere days away, checked an hour ago, is not due', !due.includes('far'), JSON.stringify(due));
    t.check('a premiere days away is due again after six hours', due.includes('farstale'));
    t.check('a premiere never checked is due', due.includes('farnever'));

    t.section('pollState');

    const written = await writePollState({ lastPollAt: 5, lastSeenAt: 7 });
    t.check('writePollState shallow-merges',
      written.running === false && written.lastPollAt === 5 && written.lastSeenAt === 7
        && written.lastFavPollAt === 0);
    t.check('writePollState persists', (await readPollState()).lastPollAt === 5);

    const deduped = markNotified({ notified: ['a'] }, ['a', 'b', 'a']);
    t.check('markNotified dedupes', same(deduped.notified, ['a', 'b']));
    t.check('hasNotified is true for a recorded id', hasNotified(deduped, 'a') === true);
    t.check('hasNotified is false otherwise', hasNotified(deduped, 'c') === false);

    const many = Array.from({ length: 510 }, (_, i) => 'id' + i);
    const cappedNotified = markNotified({ notified: [] }, many);
    t.check('markNotified caps at 500', cappedNotified.notified.length === 500);
    t.check('markNotified drops the oldest',
      cappedNotified.notified[0] === 'id10' && cappedNotified.notified[499] === 'id509',
      `${cappedNotified.notified[0]}..${cappedNotified.notified[499]}`);
    t.check('markNotified does not mutate the input',
      Array.isArray((await readPollState()).notified));

    t.section('sortChannelsForDisplay');

    const channels = [
      { id: '1', title: 'zeta', favorite: false, lastVideoAt: 300 },
      { id: '2', title: 'Gamma', favorite: false, lastVideoAt: 100 },
      { id: '3', title: 'beta', favorite: true, lastVideoAt: 50 },
      { id: '4', title: 'Alpha', favorite: false, lastVideoAt: 100 },
    ];
    const sorted = sortChannelsForDisplay(channels, []);
    t.check('favourites first', sorted[0].id === '3', sorted.map((c) => c.id).join(','));
    t.check('then newest video', sorted[1].id === '1', sorted.map((c) => c.id).join(','));
    t.check('then title case-insensitively',
      sorted[2].id === '4' && sorted[3].id === '2',
      sorted.map((c) => c.id + ':' + c.title).join(','));
    t.check('does not mutate the input', channels[0].id === '1');
  } finally {
    mock.restore();
  }

  t.check('restore puts chrome back', globalThis.chrome === previous);
}
