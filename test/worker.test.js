/**
 * Background worker: alarms, sweep, silent seed, notifications, badge,
 * and the message API. Fake chrome and fake fetch — no network.
 */

import fs from 'node:fs';
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
      if (spec.failFeeds && spec.failFeeds[id] === '429') {
        return textRes('Too Many Requests', { status: 429 });
      }
      if (spec.failFeeds && spec.failFeeds[id] === 'sorry') {
        return {
          ...textRes('<html>unusual traffic</html>'),
          redirected: true,
          url: 'https://www.google.com/sorry/index?continue=https://www.youtube.com/feeds/videos.xml',
        };
      }
      const xml = spec.feeds && spec.feeds[id];
      return textRes(xml || rssXml(id, 'Empty', []));
    }
    if (u.includes('/youtubei/v1/player')) {
      const videoId = bodyOf(opts).videoId;
      if (spec.playerStatus) return jsonRes({}, { status: spec.playerStatus });
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
    if (u.includes('/youtubei/v1/browse')) {
      return jsonRes(spec.browse || headerJson(MKBHD, 'Marques Brownlee', '@mkbhd', 'https://yt3.ggpht.com/mkbhd'));
    }
    // The worker reads its own message files for alerts in the chosen
    // language. Without them every alert quietly falls back to English.
    const locale = u.match(/^chrome-extension:\/\/[^/]+\/(_locales\/(?:en|ar)\/messages\.json)$/);
    if (locale) {
      return jsonRes(JSON.parse(fs.readFileSync(new URL(`../${locale[1]}`, import.meta.url), 'utf8')));
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
    onNotificationClicked,
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
    // Removing `settings` kicks the worker's onSettingsChanged listener,
    // which calls syncAlarms without the test awaiting it.
    await wait(20);
    mock.resetCalls();
    mock.notifications.length = 0;
    mock.badgeText = '';
    mock.tabsCreated.length = 0;
  }

  try {
    t.section('youtube origin rewrite');

    const originRule = mock.dnrRules.find((r) => r.id === 1);
    t.check('installs a DNR origin rule on boot', !!originRule, JSON.stringify(mock.dnrRules));
    const originHeader = originRule?.action?.requestHeaders?.find(
      (h) => String(h.header).toLowerCase() === 'origin',
    );
    t.check(
      'rewrites Origin to https://www.youtube.com',
      originHeader?.operation === 'set' && originHeader?.value === 'https://www.youtube.com',
      JSON.stringify(originHeader),
    );
    t.check(
      'rule is scoped to this extension',
      Array.isArray(originRule?.condition?.initiatorDomains)
        && originRule.condition.initiatorDomains.includes('youtube-companion-test'),
      JSON.stringify(originRule?.condition),
    );
    t.check(
      'rule targets www.youtube.com',
      Array.isArray(originRule?.condition?.requestDomains)
        && originRule.condition.requestDomains.includes('www.youtube.com'),
      JSON.stringify(originRule?.condition?.requestDomains),
    );

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

    const keptScheduled = mock.alarms['poll-all'].scheduledTime;
    const createdBeforeKeep = mock.alarmsCreated.length;
    await syncAlarms();
    t.check(
      'an existing poll-all with the same period keeps scheduledTime',
      mock.alarms['poll-all'].scheduledTime === keptScheduled,
      String(mock.alarms['poll-all']?.scheduledTime),
    );
    t.check(
      'same period does not recreate poll-all',
      mock.alarmsCreated.length === createdBeforeKeep,
      String(mock.alarmsCreated.length),
    );

    await writeSettings({ ui: { locale: 'ar' } });
    await syncAlarms();
    t.check(
      'a settings write keeps poll-all scheduledTime',
      mock.alarms['poll-all'].scheduledTime === keptScheduled,
      String(mock.alarms['poll-all']?.scheduledTime),
    );

    const lastPollForHour = Date.now() - 10 * 60_000;
    await writePollState({ lastPollAt: lastPollForHour });
    await writeSettings({ poll: { intervalMinutes: 60 } });
    await wait(20);
    await syncAlarms();
    t.check(
      'changing intervalMinutes recreates poll-all with period 60',
      mock.alarms['poll-all']?.periodInMinutes === 60,
      JSON.stringify(mock.alarms['poll-all']),
    );
    t.check(
      'changed poll-all is due at lastPollAt + 60 min',
      mock.alarms['poll-all'].scheduledTime === lastPollForHour + 60 * 60_000,
      String(mock.alarms['poll-all']?.scheduledTime),
    );

    await writePollState({ lastPollAt: Date.now() - 2 * 60 * 60_000 });
    await wait(20);
    await globalThis.chrome.alarms.clear('poll-all');
    await globalThis.chrome.alarms.clear('poll-fav');
    const overdueStart = Date.now();
    await syncAlarms();
    const overdueEnd = Date.now();
    const overdueWhen = mock.alarms['poll-all']?.scheduledTime;
    t.check(
      'an overdue lastPollAt is due about now + 60s',
      overdueWhen >= overdueStart + 60_000 && overdueWhen <= overdueEnd + 60_000,
      String(overdueWhen),
    );

    await globalThis.chrome.alarms.clear('poll-all');
    await globalThis.chrome.alarms.clear('poll-fav');
    await writePollState({ lastPollAt: 0, lastFavPollAt: 0 });
    const zeroStart = Date.now();
    await syncAlarms();
    const zeroEnd = Date.now();
    const zeroWhen = mock.alarms['poll-all']?.scheduledTime;
    t.check(
      'a lastPollAt of 0 is due about now + 60s',
      zeroWhen >= zeroStart + 60_000 && zeroWhen <= zeroEnd + 60_000,
      String(zeroWhen),
    );

    await globalThis.chrome.alarms.clear('poll-all');
    await globalThis.chrome.alarms.clear('poll-fav');
    const laterPollAt = Date.now() - 5 * 60_000;
    const olderFavAt = Date.now() - 40 * 60_000;
    await writePollState({ lastPollAt: laterPollAt, lastFavPollAt: olderFavAt });
    await syncAlarms();
    t.check(
      'poll-fav uses lastPollAt when it is later than lastFavPollAt',
      mock.alarms['poll-fav']?.scheduledTime === laterPollAt + 10 * 60_000,
      String(mock.alarms['poll-fav']?.scheduledTime),
    );

    await globalThis.chrome.alarms.clear('poll-fav');
    const olderPollAt = Date.now() - 25 * 60_000;
    const laterFavAt = Date.now() - 3 * 60_000;
    await writePollState({ lastPollAt: olderPollAt, lastFavPollAt: laterFavAt });
    await syncAlarms();
    t.check(
      'poll-fav uses lastFavPollAt when it is later than lastPollAt',
      mock.alarms['poll-fav']?.scheduledTime === laterFavAt + 10 * 60_000,
      String(mock.alarms['poll-fav']?.scheduledTime),
    );

    await writeSettings({ poll: { intervalMinutes: 30, favoriteIntervalMinutes: 0 } });
    await wait(20);
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

    t.section('stranded running on a fresh worker load');

    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true });
    await writePollState({ running: true, lastPollAt: 9 });
    installFetch({
      feeds: {
        [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', [
          { v: 'afterkill01', t: 'After kill', at: AT.newest },
        ]),
      },
    });
    const listenerCounts = {
      alarm: mock.alarmListeners.length,
      notify: mock.notificationClickListeners.length,
      installed: mock.runtimeListeners.onInstalled.length,
      startup: mock.runtimeListeners.onStartup.length,
      message: mock.runtimeListeners.onMessage.length,
      command: mock.commandListeners.length,
      storage: mock.storageChangedListeners.length,
    };
    const workerHref = new URL('../src/background/service-worker.js', import.meta.url).href;
    const fresh = await import(`${workerHref}?boot=${Date.now()}`);
    t.check(
      'cache-busted import is a new worker instance',
      fresh.runSweep !== runSweep,
      String(fresh.runSweep === runSweep),
    );
    const alarmFn = mock.alarmListeners[mock.alarmListeners.length - 1];
    const fromAlarm = await alarmFn({ name: 'poll-all' });
    t.check(
      'an alarm in the same tick as a fresh load is not blocked by stored running: true',
      fromAlarm && fromAlarm.ok === true,
      JSON.stringify(fromAlarm),
    );
    t.check(
      'fresh-load alarm sweep stored the video',
      (await readFeed()).some((row) => row.v === 'afterkill01'),
    );
    t.check(
      'running is false after the fresh-load sweep',
      (await readPollState()).running === false,
    );
    mock.alarmListeners.length = listenerCounts.alarm;
    mock.notificationClickListeners.length = listenerCounts.notify;
    mock.runtimeListeners.onInstalled.length = listenerCounts.installed;
    mock.runtimeListeners.onStartup.length = listenerCounts.startup;
    mock.runtimeListeners.onMessage.length = listenerCounts.message;
    mock.commandListeners.length = listenerCounts.command;
    mock.storageChangedListeners.length = listenerCounts.storage;

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

    t.section('YouTube pushback stops the sweep and waits');

    const LINUS = 'UCXuqSBlHAE6Xw-yeJA0Tunw';
    const QUARTER_HOUR = 15 * 60_000;
    const feedCallsTo = (calls) => calls
      .filter((c) => c.url.includes('/feeds/videos.xml'))
      .map((c) => decodeURIComponent((c.url.match(/channel_id=([^&]+)/) || [])[1] || ''));

    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true });
    await putChannel({ id: BEAST, title: 'MrBeast', seeded: true });
    await putChannel({ id: LINUS, title: 'Linus Tech Tips', seeded: true });
    let pushFetch = installFetch({
      failFeeds: { [BEAST]: '429' },
      feeds: { [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', [{ v: 'beforeblock', t: 'Before', at: AT.newest }]) },
    });
    const pushStart = Date.now();
    const pushed = await runSweep({ scope: 'all' });
    const pushEnd = Date.now();
    t.check('a 429 makes the sweep report slow down', pushed.ok === false && pushed.error === 'slow down', JSON.stringify(pushed));
    t.check(
      'no channel after the 429 is fetched',
      JSON.stringify(feedCallsTo(pushFetch.calls)) === JSON.stringify([MKBHD, BEAST]),
      JSON.stringify(feedCallsTo(pushFetch.calls)),
    );
    const pushedChannels = await readChannels();
    t.check(
      'the refused channel is not marked broken',
      pushedChannels.find((c) => c.id === BEAST).lastError === null,
      JSON.stringify(pushedChannels.find((c) => c.id === BEAST).lastError),
    );
    t.check('the skipped channel is not marked broken', pushedChannels.find((c) => c.id === LINUS).lastError === null);
    // A new video still needs a player request to classify it, and that is
    // one more request into the block. It waits for the next clean sweep.
    t.check(
      'no video is classified after a pushback',
      !pushFetch.calls.some((c) => c.url.includes('/youtubei/v1/player')) && (await readFeed()).length === 0,
      JSON.stringify(await readFeed()),
    );
    let pushPoll = await readPollState();
    t.check('first pushback is level 1', pushPoll.backoffLevel === 1, String(pushPoll.backoffLevel));
    t.check(
      'first pushback waits 15 minutes',
      pushPoll.backoffUntil >= pushStart + QUARTER_HOUR && pushPoll.backoffUntil <= pushEnd + QUARTER_HOUR,
      String(pushPoll.backoffUntil - pushStart),
    );
    t.check('the sweep reports when it will try again', pushed.until === pushPoll.backoffUntil);
    t.check('a stopped sweep is not recorded as a check', pushPoll.lastPollAt === 0, String(pushPoll.lastPollAt));
    t.check('running is lowered after a pushback', pushPoll.running === false);

    const callsDuringBlock = pushFetch.calls.length;
    const again = await runSweep({ scope: 'all' });
    t.check('a sweep during the wait is refused', again.ok === false && again.error === 'slow down', JSON.stringify(again));
    t.check('and carries the same until', again.until === pushPoll.backoffUntil);
    const manual = await handleMessage({ type: 'sweep', scope: 'all' });
    t.check('a manual refresh during the wait is refused', manual.error === 'slow down', JSON.stringify(manual));
    await mock.fireAlarm('poll-all');
    await mock.fireAlarm('poll-fav');
    t.check('nothing is fetched during the wait', pushFetch.calls.length === callsDuringBlock, String(pushFetch.calls.length - callsDuringBlock));

    await writePollState({ backoffUntil: Date.now() - 1 });
    const second = await runSweep({ scope: 'all' });
    pushPoll = await readPollState();
    t.check('a second pushback in a row is level 2', second.error === 'slow down' && pushPoll.backoffLevel === 2, String(pushPoll.backoffLevel));
    t.check(
      'and waits 30 minutes',
      pushPoll.backoffUntil - Date.now() > 2 * QUARTER_HOUR - 5_000 && pushPoll.backoffUntil - Date.now() <= 2 * QUARTER_HOUR,
      String(pushPoll.backoffUntil - Date.now()),
    );

    await writePollState({ backoffUntil: Date.now() - 1 });
    installFetch({
      feeds: { [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', [{ v: 'beforeblock', t: 'Before', at: AT.newest }]) },
    });
    const clean = await runSweep({ scope: 'all' });
    pushPoll = await readPollState();
    t.check('a clean sweep after the wait is ok', clean.ok === true, JSON.stringify(clean));
    t.check('the held-back video lands on the clean sweep', (await readFeed()).some((row) => row.v === 'beforeblock'));
    t.check('a clean sweep resets the level', pushPoll.backoffLevel === 0 && pushPoll.backoffUntil === 0, JSON.stringify(pushPoll));
    t.check('a clean sweep is recorded as a check', pushPoll.lastPollAt > 0);

    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true });
    installFetch({ failFeeds: { [MKBHD]: 'sorry' } });
    const sorry = await runSweep({ scope: 'all' });
    t.check('a redirect to google.com/sorry counts as pushback', sorry.error === 'slow down', JSON.stringify(sorry));
    t.check(
      'and does not mark the channel broken',
      (await readChannels())[0].lastError === null,
      JSON.stringify((await readChannels())[0].lastError),
    );

    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: false });
    const seedEntries = [
      { v: 'blockseed01', t: 'Old one', at: AT.older },
      { v: 'blockseed02', t: 'Old two', at: AT.mid },
    ];
    pushFetch = installFetch({ feeds: { [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', seedEntries) }, playerStatus: 429 });
    const classifyPush = await runSweep({ scope: 'all' });
    t.check('a 429 while classifying is pushback too', classifyPush.error === 'slow down', JSON.stringify(classifyPush));
    t.check(
      'classification stops at the first 429',
      pushFetch.calls.filter((c) => c.url.includes('/youtubei/v1/player')).length === 1,
      String(pushFetch.calls.filter((c) => c.url.includes('/youtubei/v1/player')).length),
    );
    t.check('a new channel stays unseeded when its backfill was cut short', (await readChannels())[0].seeded === false);
    await writePollState({ backoffUntil: Date.now() - 1 });
    installFetch({ feeds: { [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', seedEntries) } });
    await runSweep({ scope: 'all' });
    t.check('the backfill finishes on the next sweep', (await readFeed()).length === 2, String((await readFeed()).length));
    t.check('and is still silent', mock.notifications.length === 0, JSON.stringify(mock.notifications));
    t.check('the channel is seeded afterwards', (await readChannels())[0].seeded === true);

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
    const feedAtClick = await readFeed();
    await saveFeed([
      { v: 'later000001', c: MKBHD, t: 'Later', at: AT.newest + 5000, d: 1, vw: 0, k: 'video', st: 0 },
      ...feedAtClick,
    ]);
    mock.fireNotificationClick(mock.notifications[0].id);
    for (let i = 0; i < 40 && mock.tabsCreated.length === 0; i++) await wait(5);
    t.check('opened one tab', mock.tabsCreated.length === 1, String(mock.tabsCreated.length));
    t.check(
      'click opens the newest of that channel\'s new items',
      mock.tabsCreated[0].url === 'https://www.youtube.com/watch?v=triple00002',
      mock.tabsCreated[0]?.url,
    );
    t.check('the tab is focused', mock.tabsCreated[0].active === true);

    mock.tabsCreated.length = 0;
    await onNotificationClicked(`yt:${MKBHD}`);
    t.check(
      'a second click after the Map entry is consumed opens the newest stored row',
      mock.tabsCreated[0]?.url === 'https://www.youtube.com/watch?v=later000001',
      mock.tabsCreated[0]?.url,
    );

    t.section('notification click rebuilds from storage');

    const CLICK_CH = 'UCclickempty000000000001';
    await wipe();
    await saveFeed([
      { v: 'oldvid00001', c: CLICK_CH, t: 'Old', at: 10, d: 1, vw: 0, k: 'video', st: 0 },
      { v: 'newvid00001', c: CLICK_CH, t: 'New', at: 100, d: 1, vw: 0, k: 'video', st: 0 },
      { v: 'other000001', c: MKBHD, t: 'Other', at: 200, d: 1, vw: 0, k: 'video', st: 0 },
    ]);
    mock.tabsCreated.length = 0;
    await onNotificationClicked(`yt:${CLICK_CH}`);
    t.check('empty Map click opened one tab', mock.tabsCreated.length === 1, String(mock.tabsCreated.length));
    t.check(
      'empty Map click opens the newest stored video for that channel',
      mock.tabsCreated[0].url === 'https://www.youtube.com/watch?v=newvid00001',
      mock.tabsCreated[0]?.url,
    );
    t.check('empty Map click focuses the tab', mock.tabsCreated[0].active === true);

    await saveFeed([
      { v: 'shortvid001', c: CLICK_CH, t: 'A short', at: 50, d: 1, vw: 0, k: 'short', st: 0 },
      { v: 'older000001', c: CLICK_CH, t: 'Older', at: 10, d: 1, vw: 0, k: 'video', st: 0 },
    ]);
    mock.tabsCreated.length = 0;
    await onNotificationClicked(`yt:${CLICK_CH}`);
    t.check(
      'empty Map click on a short opens /shorts/',
      mock.tabsCreated[0]?.url === 'https://www.youtube.com/shorts/shortvid001',
      mock.tabsCreated[0]?.url,
    );

    await saveFeed([
      { v: 'other000002', c: MKBHD, t: 'Unrelated', at: 300, d: 1, vw: 0, k: 'video', st: 0 },
    ]);
    mock.tabsCreated.length = 0;
    await onNotificationClicked(`yt:${CLICK_CH}`);
    t.check(
      'empty Map click with no rows for that channel opens the channel videos page',
      mock.tabsCreated[0]?.url === `https://www.youtube.com/channel/${CLICK_CH}/videos`,
      mock.tabsCreated[0]?.url,
    );

    mock.tabsCreated.length = 0;
    await onNotificationClicked('not-a-notification');
    t.check('invalid notification id opens nothing', mock.tabsCreated.length === 0);

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

    t.section('badge honours favoritesOnly');

    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', favorite: true, seeded: true });
    await putChannel({ id: BEAST, title: 'MrBeast', favorite: false, seeded: true });
    await saveFeed([
      { v: 'favvid00001', c: MKBHD, t: 'Fav', at: 100, d: 1, vw: 0, k: 'video', st: 0 },
      { v: 'othvid00001', c: BEAST, t: 'Other', at: 90, d: 1, vw: 0, k: 'video', st: 0 },
      { v: 'favshort001', c: MKBHD, t: 'Fav short', at: 80, d: 1, vw: 0, k: 'short', st: 0 },
      { v: 'oldfav00001', c: MKBHD, t: 'Old', at: 10, d: 1, vw: 0, k: 'video', st: 0 },
    ]);
    await writePollState({ lastSeenAt: 50 });
    await writeSettings({ feed: { showShorts: false, favoritesOnly: true } });
    await refreshBadge();
    t.check(
      'favoritesOnly badge ignores non-favourite channels and hidden shorts',
      mock.badgeText === '1',
      JSON.stringify(mock.badgeText),
    );

    await writeSettings({ feed: { showShorts: true, favoritesOnly: true } });
    await refreshBadge();
    t.check(
      'favoritesOnly badge includes favourite shorts when shown',
      mock.badgeText === '2',
      JSON.stringify(mock.badgeText),
    );

    await writeSettings({ feed: { showShorts: false, favoritesOnly: false } });
    await refreshBadge();
    t.check(
      'favoritesOnly off counts every channel, still hiding shorts',
      mock.badgeText === '2',
      JSON.stringify(mock.badgeText),
    );

    t.section('audio mode leaves the badge count alone');

    await wipe();
    await saveFeed([
      { v: 'v1', c: MKBHD, t: 'A', at: 100, d: 1, vw: 0, k: 'video', st: 0 },
      { v: 'v2', c: MKBHD, t: 'B', at: 80, d: 1, vw: 0, k: 'video', st: 0 },
    ]);
    await writePollState({ lastSeenAt: 50 });
    await refreshBadge();
    t.check('badge shows the feed count', mock.badgeText === '2', JSON.stringify(mock.badgeText));
    const badgeWrites = mock.badgeTexts.length;
    await handleMessage({ type: 'audioMode.boot' }, { tab: { id: 7 } });
    t.check(
      'a content-script boot does not touch the badge',
      mock.badgeTexts.length === badgeWrites && mock.badgeText === '2',
      JSON.stringify(mock.badgeTexts),
    );

    t.section('open in audio mode');

    const AUDIO_VID = 'audioOpen01';

    await wipe();
    const audioOpened = await handleMessage({ type: 'openInAudioMode', v: AUDIO_VID });
    t.check('openInAudioMode reports ok', audioOpened.ok === true, JSON.stringify(audioOpened));
    t.check('creates one tab', mock.tabsCreated.length === 1, String(mock.tabsCreated.length));
    t.check(
      'tab is the watch URL and focused',
      mock.tabsCreated[0]?.url === `https://www.youtube.com/watch?v=${AUDIO_VID}`
        && mock.tabsCreated[0]?.active === true,
      mock.tabsCreated[0]?.url,
    );
    const openedTabId = mock.tabsCreated[0]?.id;
    const storedFlag = await globalThis.chrome.storage.session.get(`audioOpen:${openedTabId}`);
    t.check(
      'stores audioOpen:<tabId>',
      storedFlag[`audioOpen:${openedTabId}`] === true,
      JSON.stringify(storedFlag),
    );

    const bootFromOpen = await handleMessage(
      { type: 'audioMode.boot' },
      { tab: { id: openedTabId } },
    );
    t.check(
      'boot from that tab is openInAudioMode true',
      bootFromOpen.ok === true && bootFromOpen.openInAudioMode === true,
      JSON.stringify(bootFromOpen),
    );
    const consumed = await globalThis.chrome.storage.session.get(`audioOpen:${openedTabId}`);
    t.check(
      'boot consumes the key',
      consumed[`audioOpen:${openedTabId}`] === undefined,
      JSON.stringify(consumed),
    );
    const bootAgain = await handleMessage(
      { type: 'audioMode.boot' },
      { tab: { id: openedTabId } },
    );
    t.check(
      'second boot from the same tab is false',
      bootAgain.ok === true && bootAgain.openInAudioMode === false,
      JSON.stringify(bootAgain),
    );

    mock.resetCalls();
    const invalid = await handleMessage({ type: 'openInAudioMode', v: 'nope' });
    t.check(
      'invalid v is not a video',
      invalid.ok === false && invalid.error === 'not a video',
      JSON.stringify(invalid),
    );
    t.check('invalid v creates no tab', mock.tabsCreated.length === 0, String(mock.tabsCreated.length));
    const emptySession = await globalThis.chrome.storage.session.get(null);
    t.check(
      'invalid v stores nothing',
      Object.keys(emptySession).length === 0,
      JSON.stringify(emptySession),
    );

    await wipe();
    await handleMessage({ type: 'openInAudioMode', v: AUDIO_VID });
    const flaggedId = mock.tabsCreated[0]?.id;
    const otherTab = await handleMessage(
      { type: 'audioMode.boot' },
      { tab: { id: flaggedId + 99 } },
    );
    t.check(
      'boot from a different tab is false',
      otherTab.ok === true && otherTab.openInAudioMode === false,
      JSON.stringify(otherTab),
    );

    const bootNoTab = await handleMessage({ type: 'audioMode.boot' }, {});
    t.check(
      'boot with no sender.tab is ok: false',
      bootNoTab.ok === false && bootNoTab.error === 'no tab',
      JSON.stringify(bootNoTab),
    );

    await wipe();
    let releaseSet;
    mock.sessionSetHold = new Promise((resolve) => { releaseSet = resolve; });
    const openInFlight = handleMessage({ type: 'openInAudioMode', v: AUDIO_VID });
    for (let i = 0; i < 40 && mock.tabsCreated.length === 0; i++) await Promise.resolve();
    t.check(
      'in-flight open created a tab',
      mock.tabsCreated.length === 1,
      String(mock.tabsCreated.length),
    );
    const inflightTabId = mock.tabsCreated[0]?.id;
    let bootSettled = false;
    const bootInFlight = handleMessage(
      { type: 'audioMode.boot' },
      { tab: { id: inflightTabId } },
    ).then((res) => {
      bootSettled = true;
      return res;
    });
    for (let i = 0; i < 30; i++) await Promise.resolve();
    t.check('boot waits for the in-flight write', bootSettled === false);
    releaseSet();
    const inflightBoot = await bootInFlight;
    t.check(
      'boot after an in-flight open is true',
      inflightBoot.ok === true && inflightBoot.openInAudioMode === true,
      JSON.stringify(inflightBoot),
    );
    await openInFlight;
    mock.sessionSetHold = null;

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

    const fromWatch = await handleMessage({
      type: 'addChannel',
      input: 'https://www.youtube.com/watch?v=Od6M0AXpcxQ',
    });
    t.check(
      'a watch URL of an already-listed uploader is already added',
      fromWatch.ok === false && fromWatch.error === 'already added' && fromWatch.id === MKBHD,
      JSON.stringify(fromWatch),
    );

    const VIA = 'UC0000000000000000000001';
    installFetch({
      players: {
        watchadd001: playerJson('watchadd001', { channelId: VIA, author: 'Via Watch' }),
      },
      browse: headerJson(VIA, 'Via Watch', '@viawatch', 'https://yt3.ggpht.com/via'),
      feeds: {
        [VIA]: rssXml(VIA, 'Via Watch', []),
      },
    });
    const viaWatch = await handleMessage({
      type: 'addChannel',
      input: 'https://www.youtube.com/watch?v=watchadd001',
    });
    t.check(
      'a watch URL adds the uploader',
      viaWatch.ok === true && viaWatch.channel?.id === VIA,
      JSON.stringify(viaWatch),
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

    const LTT = 'UCXuqSBlHAE6Xw-yeJA0Tunw';
    installFetch({
      resolveId: LTT,
      browse: headerJson(LTT, 'Linus Tech Tips', '@LinusTechTips', 'https://yt3.ggpht.com/ltt'),
      feeds: {
        [LTT]: rssXml(LTT, 'Linus Tech Tips', [
          { v: 'lttseed00001', t: 'LTT seed', at: AT.newest },
        ]),
      },
    });
    const badgeFn = globalThis.chrome.action.setBadgeText;
    globalThis.chrome.action.setBadgeText = async () => {
      throw new Error('badge failed');
    };
    const addedDespiteSweep = await handleMessage({ type: 'addChannel', input: '@LinusTechTips' });
    globalThis.chrome.action.setBadgeText = badgeFn;
    t.check(
      'addChannel still ok when the seed sweep throws',
      addedDespiteSweep.ok === true && addedDespiteSweep.channel?.id === LTT,
      JSON.stringify(addedDespiteSweep),
    );
    t.check(
      'channel stayed stored after a failed seed',
      (await readChannels()).some((c) => c.id === LTT),
    );

    await syncAlarms();
    const favScheduled = mock.alarms['poll-all']?.scheduledTime;
    const beforeFav = mock.alarmsCreated.length;
    const fav = await handleMessage({ type: 'setFavorite', id: BEAST, on: true });
    t.check('setFavorite reports ok', fav.ok === true, JSON.stringify(fav));
    t.check('setFavorite persisted', (await readChannels()).find((c) => c.id === BEAST)?.favorite === true);
    t.check(
      'setFavorite does not restart poll-all',
      mock.alarms['poll-all']?.scheduledTime === favScheduled
        && mock.alarmsCreated.length === beforeFav,
      JSON.stringify({
        scheduledTime: mock.alarms['poll-all']?.scheduledTime,
        favScheduled,
        created: mock.alarmsCreated.length,
        beforeFav,
      }),
    );

    const onlyFetch = installFetch({
      feeds: {
        [MKBHD]: rssXml(MKBHD, 'MKBHD', [
          { v: 'onlyid000001', t: 'only this', at: AT.newest },
        ]),
        [BEAST]: rssXml(BEAST, 'MrBeast', [
          { v: 'beastonly01', t: 'should not fetch', at: AT.newest },
        ]),
      },
    });
    const only = await handleMessage({ type: 'sweep', scope: 'all', onlyId: MKBHD });
    t.check('sweep onlyId reports ok', only.ok === true, JSON.stringify(only));
    const feedCalls = onlyFetch.calls.filter((c) => String(c.url).includes('/feeds/videos.xml'));
    t.check(
      'sweep onlyId fetches one feed',
      feedCalls.length === 1 && String(feedCalls[0].url).includes(MKBHD),
      JSON.stringify(feedCalls.map((c) => c.url)),
    );
    t.check(
      'sweep onlyId did not fetch the other channel',
      !feedCalls.some((c) => String(c.url).includes(BEAST)),
    );

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
    const POPUP_SENDER = {
      id: 'youtube-companion-test',
      url: 'chrome-extension://youtube-companion/src/popup/popup.html',
      origin: 'chrome-extension://youtube-companion',
    };
    const PAGE_SENDER = {
      id: 'youtube-companion-test',
      url: 'https://www.youtube.com/watch?v=Od6M0AXpcxQ',
      origin: 'https://www.youtube.com',
      tab: { id: 42 },
    };
    function viaListenerAs(message, sender) {
      let ret;
      const reply = new Promise((resolve) => {
        ret = listener(message, sender, resolve);
      });
      return reply.then((res) => ({ ret, res }));
    }

    const fromPopup = await viaListenerAs({ type: 'getState' }, POPUP_SENDER);
    t.check('onMessage listener returns true', fromPopup.ret === true, String(fromPopup.ret));
    t.check('listener delivers getState', fromPopup.res.channels?.[0]?.id === MKBHD);

    t.section('who may send which message');

    const channelsBefore = JSON.stringify(await readChannels());
    const pageImport = await viaListenerAs({
      type: 'importBackup',
      mode: 'replace',
      data: JSON.stringify({ app: 'youtube-companion', version: 1, settings: {}, channels: [] }),
    }, PAGE_SENDER);
    t.check(
      'a YouTube page cannot replace the channel list',
      pageImport.res.ok === false && pageImport.res.error === 'not allowed',
      JSON.stringify(pageImport.res),
    );
    t.check('and the listener answers synchronously', pageImport.ret === false, String(pageImport.ret));
    t.check('the channel list is untouched', JSON.stringify(await readChannels()) === channelsBefore);

    for (const type of ['getState', 'popupOpened', 'sweep', 'addChannel', 'removeChannel',
      'setFavorite', 'updateSettings', 'openInAudioMode', 'importBackup']) {
      const res = await viaListenerAs({ type }, PAGE_SENDER);
      t.check(`a YouTube page cannot send ${type}`, res.res.error === 'not allowed', JSON.stringify(res.res));
    }

    const pageShortcut = await viaListenerAs({ type: 'audioMode.shortcut' }, PAGE_SENDER);
    t.check('a YouTube page may read the audio shortcut', pageShortcut.res.ok === true, JSON.stringify(pageShortcut.res));
    const pageBoot = await viaListenerAs({ type: 'audioMode.boot' }, PAGE_SENDER);
    t.check('a YouTube page may ask whether to boot in audio mode', pageBoot.res.ok === true, JSON.stringify(pageBoot.res));

    const otherExtension = await viaListenerAs({ type: 'getState' }, { ...POPUP_SENDER, id: 'someone-else' });
    t.check('another extension id is refused', otherExtension.res.error === 'not allowed');
    const lookAlike = await viaListenerAs(
      { type: 'getState' },
      { ...POPUP_SENDER, url: 'chrome-extension://youtube-companion-evil/src/popup/popup.html' },
    );
    t.check('a look-alike extension URL is refused', lookAlike.res.error === 'not allowed');
    const noUrl = await viaListenerAs({ type: 'getState' }, { id: 'youtube-companion-test' });
    t.check('a sender with no URL is refused', noUrl.res.error === 'not allowed');
    const noSender = await viaListenerAs({ type: 'audioMode.shortcut' }, undefined);
    t.check('no sender at all is refused', noSender.res.error === 'not allowed');

    t.check('badge colour was set once', mock.badgeColor === '#5b3fd6', String(mock.badgeColor));

    t.section('the alert follows the chosen language, not the browser');

    // After the wipe: it removes `settings`, which would put the language
    // back on 'auto' and leave the result to the machine's own locale.
    await wipe();
    await writeSettings({ ui: { locale: 'ar' } });
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
