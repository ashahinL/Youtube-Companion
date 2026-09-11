/**
 * Background worker: alarms, sweep, silent seed, notifications, badge,
 * and the message API. Fake chrome and fake fetch — no network.
 */

import { installChromeMock } from './helpers/chrome-mock.js';
import { writeSettings } from '../src/lib/settings.js';
import {
  addChannel,
  readChannels,
  readFeed,
  saveFeed,
  readVideoMeta,
  saveVideoMeta,
  readPollState,
  writePollState,
} from '../src/lib/store.js';

const MKBHD = 'UCBJycsmduvYEL83R_U4JriQ';
const BEAST = 'UCX6OQ3DkcsbYNE6H8uQQuVA';

const AT = {
  newest: Date.parse('2026-09-12T12:00:00Z'),
  mid: Date.parse('2026-09-12T11:00:00Z'),
  older: Date.parse('2026-09-12T10:00:00Z'),
};

function jsonRes(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    redirected: false,
    url: '',
  };
}

function textRes(text, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
    redirected: false,
    url: '',
  };
}

function headRes({ status = 200, redirected = false, url = '' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected,
    url,
    json: async () => ({}),
    text: async () => '',
  };
}

function rssXml(channelId, title, entries) {
  const blocks = entries.map((e) => {
    const published = e.published || new Date(e.at).toISOString();
    return `<entry>
      <yt:videoId>${e.v}</yt:videoId>
      <yt:channelId>${channelId}</yt:channelId>
      <title>${e.t || e.v}</title>
      <published>${published}</published>
      <media:group>
        <media:statistics views="${e.views ?? 0}"/>
      </media:group>
    </entry>`;
  }).join('');
  return `<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">
    <link rel="self" href="http://www.youtube.com/feeds/videos.xml?channel_id=${channelId}"/>
    <title>${title}</title>
    ${blocks}
  </feed>`;
}

function playerJson(videoId, extra = {}) {
  const details = {
    videoId,
    title: extra.title || videoId,
    lengthSeconds: String(extra.lengthSeconds ?? 600),
    channelId: extra.channelId || MKBHD,
    author: extra.author || 'Marques Brownlee',
    viewCount: String(extra.viewCount ?? 1),
  };
  if (extra.isLive) details.isLive = true;
  if (extra.isUpcoming) details.isUpcoming = true;
  const micro = {
    playerMicroformatRenderer: {
      publishDate: extra.publishDate || '2026-01-01T00:00:00+00:00',
      ownerChannelName: extra.author || 'Marques Brownlee',
    },
  };
  if (extra.startTimestamp) {
    micro.playerMicroformatRenderer.liveBroadcastDetails = {
      isLiveNow: !!extra.isLive,
      startTimestamp: extra.startTimestamp,
    };
  }
  return { videoDetails: details, microformat: micro };
}

function headerJson(id, title, handle, avatar) {
  return {
    metadata: {
      channelMetadataRenderer: {
        externalId: id,
        title,
        vanityChannelUrl: handle ? `https://www.youtube.com/${handle}` : '',
        avatar: { thumbnails: [{ url: avatar || 'https://yt3.ggpht.com/a', width: 88 }] },
      },
    },
    header: {
      pageHeaderRenderer: {
        pageTitle: title,
        content: { pageHeaderViewModel: {} },
      },
    },
  };
}

function searchJson(hits) {
  return {
    contents: {
      twoColumnSearchResultsRenderer: {
        primaryContents: {
          sectionListRenderer: {
            contents: [{
              itemSectionRenderer: {
                contents: hits.map((h) => ({
                  channelRenderer: {
                    channelId: h.id,
                    title: { simpleText: h.title },
                    navigationEndpoint: {
                      browseEndpoint: {
                        browseId: h.id,
                        canonicalBaseUrl: h.handle ? `/${h.handle}` : '',
                      },
                    },
                    thumbnail: { thumbnails: [{ url: h.avatar || 'https://yt3.ggpht.com/x' }] },
                    subscriberCountText: { simpleText: h.handle || '' },
                    videoCountText: { simpleText: '1M subscribers' },
                  },
                })),
              },
            }],
          },
        },
      },
    },
  };
}

function videosJson(items) {
  const contents = items.map((it) => ({
    richItemRenderer: {
      content: {
        lockupViewModel: {
          contentId: it.v,
          metadata: {
            lockupMetadataViewModel: {
              title: { content: it.title || it.v },
              metadata: {
                contentMetadataViewModel: {
                  metadataRows: [{
                    metadataParts: [
                      { text: { content: '1K views' } },
                      { text: { content: '1 day ago' } },
                    ],
                  }],
                },
              },
            },
          },
          contentImage: {
            thumbnailViewModel: {
              overlays: [{
                thumbnailBottomOverlayViewModel: {
                  badges: [{ thumbnailBadgeViewModel: { text: it.duration || '10:00' } }],
                },
              }],
            },
          },
        },
      },
    },
  }));
  contents.push({
    continuationItemRenderer: {
      continuationEndpoint: { continuationCommand: { token: 'NEXT_TOKEN' } },
    },
  });
  return {
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs: [
          {},
          {
            tabRenderer: {
              content: { richGridRenderer: { contents } },
            },
          },
        ],
      },
    },
  };
}

function bodyOf(opts) {
  try {
    return JSON.parse(opts.body);
  } catch {
    return {};
  }
}

function installFetch(spec = {}) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, opts });
    if (spec.hook) {
      const hooked = await spec.hook(u, opts, calls);
      if (hooked !== undefined) return hooked;
    }
    if (u.includes('/feeds/videos.xml')) {
      const id = decodeURIComponent((u.match(/channel_id=([^&]+)/) || [])[1] || '');
      if (spec.failFeeds && spec.failFeeds[id] === 'http') {
        return textRes('nope', { status: 500 });
      }
      if (spec.failFeeds && spec.failFeeds[id] === 'network') {
        throw new Error('offline');
      }
      const xml = spec.feeds && spec.feeds[id];
      return textRes(xml || rssXml(id, 'Empty', []));
    }
    if (u.includes('/youtubei/v1/player')) {
      const videoId = bodyOf(opts).videoId;
      if (spec.players && spec.players[videoId]) return jsonRes(spec.players[videoId]);
      return jsonRes(playerJson(videoId));
    }
    if (u.includes('/shorts/')) {
      const id = (u.match(/\/shorts\/([^/?#]+)/) || [])[1];
      const kind = spec.shorts && spec.shorts[id];
      if (kind === 'short') {
        return headRes({ status: 200, redirected: false, url: u });
      }
      return headRes({
        status: 200,
        redirected: true,
        url: `https://www.youtube.com/watch?v=${id}`,
      });
    }
    if (u.includes('/youtubei/v1/navigation/resolve_url')) {
      const id = spec.resolveId || MKBHD;
      return jsonRes({ endpoint: { browseEndpoint: { browseId: id } } });
    }
    if (u.includes('/youtubei/v1/search')) {
      return jsonRes(spec.search || searchJson([]));
    }
    if (u.includes('/youtubei/v1/browse')) {
      return jsonRes(spec.browse || headerJson(MKBHD, 'Marques Brownlee', '@mkbhd', 'https://yt3.ggpht.com/mkbhd'));
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  fetch.calls = calls;
  globalThis.fetch = fetch;
  return fetch;
}

async function putChannel(entry) {
  await addChannel({
    id: entry.id,
    title: entry.title || 'Channel',
    handle: entry.handle || '',
    avatar: entry.avatar || 'https://yt3.ggpht.com/a',
    favorite: !!entry.favorite,
    seeded: !!entry.seeded,
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default async function run(t) {
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  const mock = installChromeMock();

  const worker = await import('../src/background/service-worker.js');
  const {
    ready,
    runSweep,
    handleMessage,
    syncAlarms,
    reconcileRunning,
    refreshBadge,
    addChannelByInput,
  } = worker;
  await ready;

  async function wipe() {
    await globalThis.chrome.storage.local.remove([
      'channels',
      'feed',
      'videoMeta',
      'pollState',
      'settings',
    ]);
    mock.resetCalls();
    mock.notifications.length = 0;
    mock.badgeText = '';
    mock.tabsCreated.length = 0;
  }

  try {
    t.section('syncAlarms');

    await wipe();
    await syncAlarms();
    t.check(
      'poll-all period is 30',
      mock.alarms['poll-all']?.periodInMinutes === 30,
      JSON.stringify(mock.alarms['poll-all']),
    );
    t.check(
      'poll-fav period is 10',
      mock.alarms['poll-fav']?.periodInMinutes === 10,
      JSON.stringify(mock.alarms['poll-fav']),
    );

    await writeSettings({ poll: { favoriteIntervalMinutes: 0 } });
    await syncAlarms();
    t.check('a 0 favourite interval clears poll-fav', mock.alarms['poll-fav'] === undefined);
    t.check(
      'poll-all remains when favourite interval is 0',
      mock.alarms['poll-all']?.periodInMinutes === 30,
      JSON.stringify(mock.alarms['poll-all']),
    );

    await writeSettings({ poll: { enabled: false, favoriteIntervalMinutes: 10 } });
    await syncAlarms();
    t.check('poll.enabled false clears poll-all', mock.alarms['poll-all'] === undefined);
    t.check('poll.enabled false clears poll-fav', mock.alarms['poll-fav'] === undefined);

    t.section('reconcileRunning');

    await wipe();
    await writePollState({ running: true, lastPollAt: 9 });
    await reconcileRunning();
    const afterReconcile = await readPollState();
    t.check('clears a stranded running: true', afterReconcile.running === false);
    t.check('leaves other pollState fields', afterReconcile.lastPollAt === 9, String(afterReconcile.lastPollAt));

    t.section('sweep refuses while running');

    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true });
    let releaseHang;
    const hang = new Promise((resolve) => { releaseHang = resolve; });
    let inFeed = false;
    installFetch({
      async hook(u) {
        if (u.includes('/feeds/videos.xml')) {
          inFeed = true;
          await hang;
          return textRes(rssXml(MKBHD, 'Marques Brownlee', []));
        }
        return undefined;
      },
    });
    const first = runSweep({ scope: 'all' });
    for (let i = 0; i < 80 && !inFeed; i++) await wait(5);
    t.check('first sweep reached the feed request', inFeed === true);
    t.check('running is true during the sweep', (await readPollState()).running === true);
    const refused = await runSweep({ scope: 'all' });
    t.check('refuses with ok: false', refused.ok === false);
    t.check(
      'error is already running',
      refused.error === 'already running',
      JSON.stringify(refused),
    );
    releaseHang();
    const firstResult = await first;
    t.check('first sweep completes ok', firstResult.ok === true);
    t.check('running is false after the sweep', (await readPollState()).running === false);

    t.section('sweep throw still lowers running');

    await wipe();
    const originalBadge = globalThis.chrome.action.setBadgeText;
    globalThis.chrome.action.setBadgeText = async () => {
      throw new Error('badge failed');
    };
    let threwMessage = '';
    try {
      await runSweep({ scope: 'all' });
    } catch (err) {
      threwMessage = err.message;
    }
    globalThis.chrome.action.setBadgeText = originalBadge;
    t.check('sweep threw badge failed', threwMessage === 'badge failed', threwMessage);
    t.check(
      'running is false after the throw',
      (await readPollState()).running === false,
    );

    t.section('one channel failing does not abort the sweep');

    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true });
    await putChannel({ id: BEAST, title: 'MrBeast', seeded: true });
    installFetch({
      failFeeds: { [MKBHD]: 'http' },
      feeds: {
        [BEAST]: rssXml(BEAST, 'MrBeast', [
          { v: 'beastvid001', t: 'Beast video', at: AT.newest, views: 9 },
        ]),
      },
    });
    const failSweep = await runSweep({ scope: 'all' });
    t.check('sweep still reports ok', failSweep.ok === true);
    const afterFail = await readChannels();
    const mk = afterFail.find((c) => c.id === MKBHD);
    const mb = afterFail.find((c) => c.id === BEAST);
    t.check('failed channel has lastError.at', typeof mk.lastError?.at === 'number' && mk.lastError.at > 0);
    t.check(
      'failed channel lastError.message is the http error',
      mk.lastError?.message === 'feed failed (500)',
      String(mk.lastError?.message),
    );
    t.check('successful channel lastError is null', mb.lastError === null);
    t.check('successful channel lastFetchAt is set', mb.lastFetchAt > 0, String(mb.lastFetchAt));
    const failFeed = await readFeed();
    t.check(
      'successful channel still landed in the feed',
      failFeed.length === 1 && failFeed[0].v === 'beastvid001' && failFeed[0].t === 'Beast video',
      JSON.stringify(failFeed),
    );

    t.section('silent seed');

    await wipe();
    await putChannel({
      id: MKBHD,
      title: 'Marques Brownlee',
      handle: '@mkbhd',
      avatar: 'https://yt3.ggpht.com/mkbhd',
      seeded: false,
    });
    installFetch({
      feeds: {
        [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', [
          { v: 'seedvid0001', t: 'Seed one', at: AT.newest, views: 10 },
          { v: 'seedvid0002', t: 'Seed two', at: AT.mid, views: 4 },
        ]),
      },
    });
    await runSweep({ scope: 'all' });
    const seededCh = (await readChannels())[0];
    t.check('seeded flips to true', seededCh.seeded === true);
    const seedFeed = await readFeed();
    t.check('seed items land in the feed', seedFeed.length === 2, String(seedFeed.length));
    t.check('newest seed item is first', seedFeed[0].v === 'seedvid0001', seedFeed[0]?.v);
    t.check(
      'ZERO notifications on the seed',
      mock.notifications.length === 0,
      JSON.stringify(mock.notifications),
    );
    const seedPoll = await readPollState();
    t.check(
      'seed ids were written to notified',
      seedPoll.notified.includes('seedvid0001') && seedPoll.notified.includes('seedvid0002'),
      JSON.stringify(seedPoll.notified),
    );

    t.section('second sweep notifies once');

    installFetch({
      feeds: {
        [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', [
          { v: 'newvid00001', t: 'Fresh upload', at: AT.newest + 1000, views: 3 },
          { v: 'seedvid0001', t: 'Seed one', at: AT.newest, views: 10 },
          { v: 'seedvid0002', t: 'Seed two', at: AT.mid, views: 4 },
        ]),
      },
    });
    await runSweep({ scope: 'all' });
    t.check('one notification for the new video', mock.notifications.length === 1, String(mock.notifications.length));
    t.check(
      'notification title is the channel name',
      mock.notifications[0].title === 'Marques Brownlee',
      mock.notifications[0]?.title,
    );
    t.check(
      'notification message is the video title',
      mock.notifications[0].message === 'Fresh upload',
      mock.notifications[0]?.message,
    );
    t.check(
      'icon is the channel avatar',
      mock.notifications[0].iconUrl === 'https://yt3.ggpht.com/mkbhd',
      mock.notifications[0]?.iconUrl,
    );

    const notifiedOnce = mock.notifications.length;
    await runSweep({ scope: 'all' });
    t.check(
      'the same video never notifies twice',
      mock.notifications.length === notifiedOnce,
      String(mock.notifications.length),
    );

    t.section('favourite vs notifyNormal');

    await wipe();
    await writeSettings({ alerts: { notifyNormal: false } });
    await putChannel({
      id: MKBHD,
      title: 'Marques Brownlee',
      favorite: true,
      seeded: true,
      avatar: 'https://yt3.ggpht.com/mkbhd',
    });
    await putChannel({
      id: BEAST,
      title: 'MrBeast',
      favorite: false,
      seeded: true,
      avatar: 'https://yt3.ggpht.com/beast',
    });
    installFetch({
      feeds: {
        [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', [
          { v: 'favnew00001', t: 'Fav video', at: AT.newest },
        ]),
        [BEAST]: rssXml(BEAST, 'MrBeast', [
          { v: 'normnew0001', t: 'Normal video', at: AT.mid },
        ]),
      },
    });
    await runSweep({ scope: 'all' });
    t.check('exactly one notification', mock.notifications.length === 1, String(mock.notifications.length));
    t.check(
      'the favourite notified',
      mock.notifications[0].title === 'Marques Brownlee'
        && mock.notifications[0].message === 'Fav video',
      JSON.stringify(mock.notifications[0]),
    );

    t.section('alerts.enabled false');

    await wipe();
    await writeSettings({ alerts: { enabled: false } });
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true, favorite: true });
    installFetch({
      feeds: {
        [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', [
          { v: 'silent00001', t: 'Should not alert', at: AT.newest },
        ]),
      },
    });
    await runSweep({ scope: 'all' });
    t.check(
      'nothing notifies while alerts.enabled is false',
      mock.notifications.length === 0,
      JSON.stringify(mock.notifications),
    );
    t.check('the video still lands in the feed', (await readFeed())[0]?.v === 'silent00001');

    t.section('short hidden from notifications');

    await wipe();
    await writeSettings({ feed: { showShorts: false } });
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true });
    installFetch({
      feeds: {
        [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', [
          { v: 'shortishxxx', t: 'A short', at: AT.newest },
        ]),
      },
      players: {
        shortishxxx: playerJson('shortishxxx', { lengthSeconds: 40, title: 'A short' }),
      },
      shorts: { shortishxxx: 'short' },
    });
    await runSweep({ scope: 'all' });
    t.check(
      'a short does not notify while showShorts is false',
      mock.notifications.length === 0,
      JSON.stringify(mock.notifications),
    );
    t.check('the short still lands in the feed', (await readFeed())[0]?.k === 'short', JSON.stringify(await readFeed()));

    t.section('three new items collapse to one notification');

    await wipe();
    await putChannel({
      id: MKBHD,
      title: 'Marques Brownlee',
      seeded: true,
      avatar: 'https://yt3.ggpht.com/mkbhd',
    });
    installFetch({
      feeds: {
        [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', [
          { v: 'triple00001', t: 'Oldest of three', at: AT.older },
          { v: 'triple00002', t: 'Newest of three', at: AT.newest },
          { v: 'triple00003', t: 'Middle of three', at: AT.mid },
        ]),
      },
    });
    // Pin the language: the collapsed text follows the user's choice, so
    // leaving it on 'auto' would make this assertion depend on the machine
    // the suite happens to run on.
    await writeSettings({ ui: { locale: 'en' } });
    await runSweep({ scope: 'all' });
    t.check('three new items produce ONE notification', mock.notifications.length === 1, String(mock.notifications.length));
    t.check(
      'collapsed title is the channel name',
      mock.notifications[0].title === 'Marques Brownlee',
      mock.notifications[0]?.title,
    );
    t.check(
      'collapsed message is 3 new videos',
      mock.notifications[0].message === '3 new videos',
      mock.notifications[0]?.message,
    );

    t.section('clicking a notification opens the newest');

    t.check('notification id is yt:<channelId>', mock.notifications[0].id === `yt:${MKBHD}`, mock.notifications[0]?.id);
    mock.fireNotificationClick(mock.notifications[0].id);
    for (let i = 0; i < 40 && mock.tabsCreated.length === 0; i++) await wait(5);
    t.check('opened one tab', mock.tabsCreated.length === 1, String(mock.tabsCreated.length));
    t.check(
      'click opens the newest of that channel\'s new items',
      mock.tabsCreated[0].url === 'https://www.youtube.com/watch?v=triple00002',
      mock.tabsCreated[0]?.url,
    );
    t.check('the tab is focused', mock.tabsCreated[0].active === true);

    t.section('badge math');

    await wipe();
    await saveFeed([
      { v: 'v1', c: MKBHD, t: 'A', at: 100, d: 1, vw: 0, k: 'video', st: 0 },
      { v: 's1', c: MKBHD, t: 'S', at: 90, d: 1, vw: 0, k: 'short', st: 0 },
      { v: 'v2', c: MKBHD, t: 'B', at: 80, d: 1, vw: 0, k: 'video', st: 0 },
      { v: 'v3', c: MKBHD, t: 'C', at: 10, d: 1, vw: 0, k: 'video', st: 0 },
    ]);
    await writePollState({ lastSeenAt: 50 });
    await writeSettings({ feed: { showShorts: false } });
    await refreshBadge();
    t.check('badge counts items newer than lastSeenAt, excluding shorts', mock.badgeText === '2', JSON.stringify(mock.badgeText));

    await writeSettings({ feed: { showShorts: true } });
    await refreshBadge();
    t.check('badge includes shorts when shown', mock.badgeText === '3', JSON.stringify(mock.badgeText));

    await writePollState({ lastSeenAt: 1000 });
    await refreshBadge();
    t.check('badge is empty string at zero', mock.badgeText === '', JSON.stringify(mock.badgeText));
    t.check('badge is never the string 0', mock.badgeText !== '0');

    await writePollState({ lastSeenAt: 0 });
    await refreshBadge();
    t.check('badge is 4 when lastSeenAt is 0 and shorts shown', mock.badgeText === '4', JSON.stringify(mock.badgeText));
    const beforeOpen = Date.now();
    const opened = await handleMessage({ type: 'popupOpened' });
    t.check('popupOpened clears the badge', mock.badgeText === '', JSON.stringify(mock.badgeText));
    t.check(
      'popupOpened sets lastSeenAt to now',
      opened.pollState.lastSeenAt >= beforeOpen,
      String(opened.pollState.lastSeenAt),
    );

    t.section('live item re-classified');

    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true });
    await saveFeed([{
      v: 'livevideo11',
      c: MKBHD,
      t: 'Live now',
      at: AT.older,
      d: 0,
      vw: 4,
      k: 'live',
      st: AT.older,
    }]);
    await saveVideoMeta({
      livevideo11: { k: 'live', d: 0, st: AT.older, at: AT.older },
    });
    installFetch({
      feeds: {
        [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', [
          { v: 'livevideo11', t: 'Live now', at: AT.older, views: 40 },
        ]),
      },
      players: {
        livevideo11: playerJson('livevideo11', { lengthSeconds: 400, title: 'Live now' }),
      },
    });
    await runSweep({ scope: 'all' });
    const settled = (await readFeed()).find((row) => row.v === 'livevideo11');
    t.check('settled kind is video', settled?.k === 'video', JSON.stringify(settled));
    t.check('settled duration is 400', settled?.d === 400, String(settled?.d));
    t.check('views refreshed from RSS', settled?.vw === 40, String(settled?.vw));
    t.check(
      'videoMeta settled too',
      (await readVideoMeta()).livevideo11?.k === 'video',
      JSON.stringify((await readVideoMeta()).livevideo11),
    );
    t.check('settling does not notify', mock.notifications.length === 0, JSON.stringify(mock.notifications));

    t.section('message API');

    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', handle: '@mkbhd', seeded: true });
    const state = await handleMessage({ type: 'getState' });
    t.check('getState has settings', state.settings?.poll?.intervalMinutes === 30, JSON.stringify(state.settings?.poll));
    t.check('getState has channels', state.channels?.[0]?.id === MKBHD, JSON.stringify(state.channels?.[0]?.id));
    t.check('getState has feed', Array.isArray(state.feed), String(typeof state.feed));
    t.check('getState has pollState', state.pollState?.running === false, JSON.stringify(state.pollState));

    installFetch({
      feeds: {
        [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', [
          { v: 'viaSweep001', t: 'Via sweep', at: AT.newest },
        ]),
      },
    });
    const sweepMsg = await handleMessage({ type: 'sweep', scope: 'all' });
    t.check('sweep message returns ok', sweepMsg.ok === true, JSON.stringify(sweepMsg));
    t.check('sweep message added the item', (await readFeed())[0]?.v === 'viaSweep001');

    installFetch({
      search: searchJson([
        { id: MKBHD, title: 'Marques Brownlee', handle: '@mkbhd' },
        { id: BEAST, title: 'MrBeast', handle: '@MrBeast' },
      ]),
    });
    const search = await handleMessage({ type: 'searchChannels', query: 'marques' });
    t.check('searchChannels returns an array', Array.isArray(search), String(typeof search));
    const mkHit = search.find((r) => r.id === MKBHD);
    const beastHit = search.find((r) => r.id === BEAST);
    t.check('in-list result is marked inList: true', mkHit?.inList === true, JSON.stringify(mkHit));
    t.check('new result is marked inList: false', beastHit?.inList === false, JSON.stringify(beastHit));

    const notChannel = await handleMessage({ type: 'addChannel', input: 'https://example.com/nope' });
    t.check(
      'addChannel rejects a non-channel',
      notChannel.ok === false && notChannel.error === 'not a channel',
      JSON.stringify(notChannel),
    );

    const already = await handleMessage({ type: 'addChannel', input: MKBHD });
    t.check(
      'addChannel rejects a duplicate',
      already.ok === false && already.error === 'already added' && already.id === MKBHD,
      JSON.stringify(already),
    );

    installFetch({
      resolveId: BEAST,
      browse: headerJson(BEAST, 'MrBeast', '@MrBeast', 'https://yt3.ggpht.com/beast'),
      feeds: {
        [BEAST]: rssXml(BEAST, 'MrBeast', [
          { v: 'beastseed01', t: 'Beast seed', at: AT.newest },
        ]),
      },
    });
    mock.notifications.length = 0;
    const added = await handleMessage({ type: 'addChannel', input: '@MrBeast' });
    t.check('addChannel reports ok', added.ok === true, JSON.stringify(added));
    t.check('returned channel id', added.channel?.id === BEAST, added.channel?.id);
    t.check('returned channel title', added.channel?.title === 'MrBeast', added.channel?.title);
    t.check('addChannel seeds silently', added.channel?.seeded === true);
    t.check(
      'addChannel seed created ZERO notifications',
      mock.notifications.length === 0,
      JSON.stringify(mock.notifications),
    );
    t.check(
      'addChannel seed landed the item',
      (await readFeed()).some((row) => row.v === 'beastseed01'),
    );

    const beforeFav = mock.alarmsCreated.length;
    const fav = await handleMessage({ type: 'setFavorite', id: BEAST, on: true });
    t.check('setFavorite reports ok', fav.ok === true, JSON.stringify(fav));
    t.check('setFavorite persisted', (await readChannels()).find((c) => c.id === BEAST)?.favorite === true);
    t.check('setFavorite calls syncAlarms', mock.alarmsCreated.length > beforeFav, String(mock.alarmsCreated.length));

    await writePollState({ lastSeenAt: 0 });
    await refreshBadge();
    t.check('badge is non-empty before remove', mock.badgeText !== '', JSON.stringify(mock.badgeText));
    const removed = await handleMessage({ type: 'removeChannel', id: BEAST });
    t.check('removeChannel reports ok', removed.ok === true);
    t.check('removeChannel dropped the channel', !(await readChannels()).some((c) => c.id === BEAST));
    t.check(
      'removeChannel dropped that channel\'s feed items',
      !(await readFeed()).some((row) => row.c === BEAST),
    );

    installFetch({
      browse: videosJson([{ v: 'gTKS8SAwUzE', title: 'A video', duration: '23:28' }]),
    });
    const videos = await handleMessage({ type: 'getChannelVideos', id: BEAST });
    t.check('getChannelVideos returns items', videos.items?.[0]?.v === 'gTKS8SAwUzE', JSON.stringify(videos.items?.[0]));
    t.check('getChannelVideos duration 23:28 is 1408s', videos.items?.[0]?.d === 1408, String(videos.items?.[0]?.d));
    t.check('getChannelVideos continuation', videos.continuation === 'NEXT_TOKEN', String(videos.continuation));

    const unknown = await handleMessage({ type: 'nonesuch' });
    t.check(
      'unknown type is ok: false',
      unknown.ok === false && unknown.error === 'unknown message',
      JSON.stringify(unknown),
    );
    const empty = await handleMessage({});
    t.check('missing type is unknown message', empty.error === 'unknown message', JSON.stringify(empty));

    const listener = mock.runtimeListeners.onMessage[0];
    t.check('onMessage listener is registered', typeof listener === 'function');
    let listenerRet;
    const viaListener = await new Promise((resolve) => {
      listenerRet = listener({ type: 'getState' }, {}, resolve);
    });
    t.check('onMessage listener returns true', listenerRet === true, String(listenerRet));
    t.check('listener delivers getState', viaListener.channels?.[0]?.id === MKBHD);

    t.check('badge colour was set once', mock.badgeColor === '#cc0000', String(mock.badgeColor));

    t.section('the alert follows the chosen language, not the browser');

    await writeSettings({ ui: { locale: 'ar' } });
    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true });
    installFetch({
      feeds: {
        [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', [
          { v: 'arabic000001', t: 'One', at: AT.older },
          { v: 'arabic000002', t: 'Two', at: AT.newest },
        ]),
      },
    });
    await runSweep({ scope: 'all' });
    const arabicNote = mock.notifications[mock.notifications.length - 1];
    t.check(
      'an Arabic collapsed alert is not the English string',
      mock.notifications.length === 1 && arabicNote.message !== '2 new videos',
      arabicNote?.message,
    );
    t.check(
      'and it carries Arabic script',
      /[\u0600-\u06FF]/.test(arabicNote?.message || ''),
      arabicNote?.message,
    );
    await writeSettings({ ui: { locale: 'en' } });
  } finally {
    mock.restore();
    if (previousFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previousFetch;
  }

  t.check('restore puts chrome back', globalThis.chrome === previousChrome);
}
