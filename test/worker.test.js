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
  readQueue,
  addToQueue,
  QUEUE_CAP,
  readWhatsNewSeen,
} from '../src/lib/store.js';
import { WHATS_NEW_VERSION } from '../src/lib/view.js';
import { parseBackup, MAX_BACKUP_BYTES } from '../src/lib/backup.js';

const MKBHD = 'UCBJycsmduvYEL83R_U4JriQ';
const BEAST = 'UCX6OQ3DkcsbYNE6H8uQQuVA';

const AT = {
  newest: Date.parse('2026-09-12T12:00:00Z'),
  mid: Date.parse('2026-09-12T11:00:00Z'),
  older: Date.parse('2026-09-12T10:00:00Z'),
};

function backupJson(channels) {
  return JSON.stringify({
    app: 'youtube-companion',
    version: 1,
    settings: {},
    channels,
  });
}

function hoursAgo(n) {
  return Date.now() - n * 60 * 60_000;
}

function daysAgo(n) {
  return Date.now() - n * 24 * 60 * 60_000;
}

function feedIdsOf(calls) {
  return calls
    .filter((c) => String(c.url).includes('/feeds/videos.xml'))
    .map((c) => decodeURIComponent((c.url.match(/channel_id=([^&]+)/) || [])[1] || ''));
}

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
    const published = e.omitPublished
      ? ''
      : `<published>${e.published || new Date(e.at).toISOString()}</published>`;
    return `<entry>
      <yt:videoId>${e.v}</yt:videoId>
      <yt:channelId>${channelId}</yt:channelId>
      <title>${e.t || e.v}</title>
      ${published}
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

function videosTabJson(channelId, rows) {
  const lockups = rows.map((r) => ({
    richItemRenderer: {
      content: {
        lockupViewModel: {
          contentId: r.v,
          contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
          metadata: {
            lockupMetadataViewModel: {
              title: { content: r.t || r.v },
              metadata: {
                contentMetadataViewModel: {
                  metadataRows: [{
                    metadataParts: [
                      { text: { content: `${r.views ?? 0} views` } },
                      { text: { content: '1 day ago' } },
                    ],
                  }],
                },
              },
            },
          },
        },
      },
    },
  }));
  return {
    metadata: { channelMetadataRenderer: { externalId: channelId, title: 'Channel' } },
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs: [{ tabRenderer: { selected: true, content: { richGridRenderer: { contents: lockups } } } }],
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
      if (spec.failFeeds && spec.failFeeds[id] === '404') {
        return textRes('Not Found', { status: 404 });
      }
      if (spec.failFeeds && spec.failFeeds[id] === 'network') {
        throw new Error('offline');
      }
      if (spec.failFeeds && spec.failFeeds[id] === '429') {
        return textRes('Too Many Requests', { status: 429 });
      }
      if (spec.failFeeds && spec.failFeeds[id] === '403') {
        return textRes('Forbidden', { status: 403 });
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
      const browseId = bodyOf(opts).browseId;
      const failure = spec.failBrowse && spec.failBrowse[browseId];
      // A channel that does not exist answers 200 with an alert and no metadata.
      if (failure === 'gone') return jsonRes({ alerts: [] });
      if (failure) return jsonRes({}, { status: Number(failure) });
      if (spec.videosTabs && spec.videosTabs[browseId]) return jsonRes(spec.videosTabs[browseId]);
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
    lastVideoAt: entry.lastVideoAt,
    groups: entry.groups,
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(pred, tries = 150) {
  for (let i = 0; i < tries; i++) {
    if (await pred()) return true;
    await wait(10);
  }
  return false;
}

async function waitForIdle() {
  await wait(20);
  await waitUntil(async () => !(await readPollState()).running);
  await wait(10);
}

function keyNames(keys) {
  if (keys == null) return [];
  if (typeof keys === 'string') return [keys];
  if (Array.isArray(keys)) return keys;
  if (typeof keys === 'object') return Object.keys(keys);
  return [];
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
    CONTENT_SCRIPT_MESSAGES,
    syncAlarms,
    reconcileRunning,
    refreshBadge,
    addChannelByInput,
    onNotificationClicked,
    onInstalled,
    syncUninstallUrl,
    addImportedChannels,
    planImportedReplace,
  } = worker;
  await ready;

  async function wipe() {
    await globalThis.chrome.storage.local.remove([
      'channels',
      'feed',
      'videoMeta',
      'pollState',
      'settings',
      'queue',
      'queueOpen',
      'whatsNewSeen',
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
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true });
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

    t.section('syncAlarms with an empty list');

    await wipe();
    await syncAlarms();
    t.check('an empty list clears poll-all', mock.alarms['poll-all'] === undefined);
    t.check('an empty list clears poll-fav', mock.alarms['poll-fav'] === undefined);

    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true });
    await syncAlarms();
    t.check(
      'one channel brings poll-all back',
      mock.alarms['poll-all']?.periodInMinutes === 30,
      JSON.stringify(mock.alarms['poll-all']),
    );
    t.check(
      'one channel brings poll-fav back',
      mock.alarms['poll-fav']?.periodInMinutes === 10,
      JSON.stringify(mock.alarms['poll-fav']),
    );

    await wipe();
    await syncAlarms();
    installFetch({
      resolveId: BEAST,
      browse: headerJson(BEAST, 'MrBeast', '@MrBeast', 'https://yt3.ggpht.com/beast'),
      feeds: {
        [BEAST]: rssXml(BEAST, 'MrBeast', [{ v: 'alarmseed01', at: AT.newest }]),
      },
    });
    const firstAdd = await handleMessage({ type: 'addChannel', input: '@MrBeast' });
    t.check('Add on an empty list reports ok', firstAdd.ok === true, JSON.stringify(firstAdd));
    t.check(
      'Add brings poll-all back',
      mock.alarms['poll-all']?.periodInMinutes === 30,
      JSON.stringify(mock.alarms['poll-all']),
    );
    t.check(
      'Add brings poll-fav back',
      mock.alarms['poll-fav']?.periodInMinutes === 10,
      JSON.stringify(mock.alarms['poll-fav']),
    );
    await waitForIdle();

    await wipe();
    await syncAlarms();
    const takeoutFirst = await handleMessage({
      type: 'importTakeout',
      data: `Channel Id,Channel Url,Channel Title\n${BEAST},http://www.youtube.com/channel/${BEAST},MrBeast`,
    });
    t.check(
      'Takeout import on an empty list reports ok',
      takeoutFirst.ok === true && takeoutFirst.added === 1,
      JSON.stringify(takeoutFirst),
    );
    t.check(
      'Takeout import brings poll-all back',
      mock.alarms['poll-all']?.periodInMinutes === 30,
      JSON.stringify(mock.alarms['poll-all']),
    );
    t.check(
      'Takeout import brings poll-fav back',
      mock.alarms['poll-fav']?.periodInMinutes === 10,
      JSON.stringify(mock.alarms['poll-fav']),
    );

    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true });
    await syncAlarms();
    const lastRemove = await handleMessage({ type: 'removeChannel', id: MKBHD });
    t.check('removing the last channel reports ok', lastRemove.ok === true);
    t.check('removing the last channel clears poll-all', mock.alarms['poll-all'] === undefined);
    t.check('removing the last channel clears poll-fav', mock.alarms['poll-fav'] === undefined);
    const undoneFirst = await handleMessage({ type: 'undoRemove', id: MKBHD });
    t.check('undo of the last removal reports ok', undoneFirst.ok === true, JSON.stringify(undoneFirst));
    t.check(
      'undo brings poll-all back',
      mock.alarms['poll-all']?.periodInMinutes === 30,
      JSON.stringify(mock.alarms['poll-all']),
    );
    t.check(
      'undo brings poll-fav back',
      mock.alarms['poll-fav']?.periodInMinutes === 10,
      JSON.stringify(mock.alarms['poll-fav']),
    );

    for (const mode of ['merge', 'replace']) {
      await wipe();
      await syncAlarms();
      installFetch({
        feeds: { [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', []) },
      });
      const restored = await handleMessage({
        type: 'importBackup',
        mode,
        data: backupJson([{ id: MKBHD, title: 'Marques Brownlee' }]),
      });
      t.check(
        `${mode} backup on an empty list reports ok`,
        restored.ok === true,
        JSON.stringify(restored),
      );
      t.check(
        `${mode} backup brings poll-all back`,
        mock.alarms['poll-all']?.periodInMinutes === 30,
        JSON.stringify(mock.alarms['poll-all']),
      );
      t.check(
        `${mode} backup brings poll-fav back`,
        mock.alarms['poll-fav']?.periodInMinutes === 10,
        JSON.stringify(mock.alarms['poll-fav']),
      );
      await waitForIdle();
    }

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

    t.section('a failed first reconcile does not freeze polling');

    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true });
    await writePollState({ running: true, lastPollAt: 9 });
    installFetch({
      feeds: {
        [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', [
          { v: 'afterfail01', t: 'After failed reconcile', at: AT.newest },
        ]),
      },
    });
    let pollWrites = 0;
    const origPollSet = globalThis.chrome.storage.local.set.bind(globalThis.chrome.storage.local);
    globalThis.chrome.storage.local.set = async (items) => {
      if (items && Object.prototype.hasOwnProperty.call(items, 'pollState')) {
        pollWrites++;
        if (pollWrites === 1) throw new Error('reconcile write failed');
      }
      return origPollSet(items);
    };
    const failListenerCounts = {
      alarm: mock.alarmListeners.length,
      notify: mock.notificationClickListeners.length,
      installed: mock.runtimeListeners.onInstalled.length,
      startup: mock.runtimeListeners.onStartup.length,
      message: mock.runtimeListeners.onMessage.length,
      command: mock.commandListeners.length,
      storage: mock.storageChangedListeners.length,
    };
    let afterFailReconcile;
    try {
      const freshFail = await import(`${workerHref}?boot=${Date.now()}-fail`);
      afterFailReconcile = await freshFail.runSweep({ scope: 'all' });
    } finally {
      globalThis.chrome.storage.local.set = origPollSet;
    }
    t.check(
      'sweep still runs after a failed first reconcile',
      afterFailReconcile && afterFailReconcile.ok === true,
      JSON.stringify(afterFailReconcile),
    );
    t.check(
      'and stored the video',
      (await readFeed()).some((row) => row.v === 'afterfail01'),
    );
    t.check('running is false after that sweep', (await readPollState()).running === false);
    mock.alarmListeners.length = failListenerCounts.alarm;
    mock.notificationClickListeners.length = failListenerCounts.notify;
    mock.runtimeListeners.onInstalled.length = failListenerCounts.installed;
    mock.runtimeListeners.onStartup.length = failListenerCounts.startup;
    mock.runtimeListeners.onMessage.length = failListenerCounts.message;
    mock.commandListeners.length = failListenerCounts.command;
    mock.storageChangedListeners.length = failListenerCounts.storage;

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

    t.section('a skipped poll-all runs after the current sweep');

    await waitForIdle();
    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true, favorite: true });
    await putChannel({ id: BEAST, title: 'MrBeast', seeded: true });
    let releaseOverlap;
    const overlapHang = new Promise((resolve) => { releaseOverlap = resolve; });
    let overlapInFeed = false;
    const overlapFetch = installFetch({
      async hook(u) {
        if (u.includes('/feeds/videos.xml')) {
          const id = decodeURIComponent((u.match(/channel_id=([^&]+)/) || [])[1] || '');
          if (id === MKBHD && !overlapInFeed) {
            overlapInFeed = true;
            await overlapHang;
          }
        }
        return undefined;
      },
      feeds: {
        [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', [{ v: 'ovlfav00001', t: 'Fav', at: AT.newest }]),
        [BEAST]: rssXml(BEAST, 'MrBeast', [{ v: 'ovlall00001', t: 'All', at: AT.mid }]),
      },
    });
    const favSweep = runSweep({ scope: 'favorites' });
    for (let i = 0; i < 80 && !overlapInFeed; i++) await wait(5);
    t.check('the favourite check reached the feed', overlapInFeed === true);
    const skippedAll = await mock.fireAlarm('poll-all');
    t.check(
      'poll-all during a favourite check is already running',
      [].concat(skippedAll).some((r) => r && r.error === 'already running'),
      JSON.stringify(skippedAll),
    );
    t.check(
      'poll-all did not fetch the non-favourite while the favourite check ran',
      !feedIdsOf(overlapFetch.calls).includes(BEAST),
      JSON.stringify(feedIdsOf(overlapFetch.calls)),
    );
    releaseOverlap();
    await favSweep;
    t.check(
      'the favourite check replied before the skipped all-check',
      !feedIdsOf(overlapFetch.calls).includes(BEAST),
      JSON.stringify(feedIdsOf(overlapFetch.calls)),
    );
    t.check(
      'the skipped all-check fetched the non-favourite',
      await waitUntil(() => feedIdsOf(overlapFetch.calls).includes(BEAST)),
      JSON.stringify(feedIdsOf(overlapFetch.calls)),
    );
    t.check(
      'and stored its video',
      await waitUntil(async () => (await readFeed()).some((row) => row.v === 'ovlall00001')),
    );
    await waitForIdle();

    t.section('an all-check already covers a skipped favourite alarm');

    await waitForIdle();
    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true, favorite: true });
    await putChannel({ id: BEAST, title: 'MrBeast', seeded: true });
    let releaseAllHang;
    const allHang = new Promise((resolve) => { releaseAllHang = resolve; });
    let allInFeed = false;
    const allCoverFetch = installFetch({
      async hook(u) {
        if (u.includes('/feeds/videos.xml')) {
          const id = decodeURIComponent((u.match(/channel_id=([^&]+)/) || [])[1] || '');
          if (id === MKBHD && !allInFeed) {
            allInFeed = true;
            await allHang;
          }
        }
        return undefined;
      },
      feeds: {
        [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', [{ v: 'coverall001', t: 'A', at: AT.newest }]),
        [BEAST]: rssXml(BEAST, 'MrBeast', [{ v: 'coverall002', t: 'B', at: AT.mid }]),
      },
    });
    const coveringAll = runSweep({ scope: 'all' });
    for (let i = 0; i < 80 && !allInFeed; i++) await wait(5);
    t.check('the all-check reached the feed', allInFeed === true);
    await mock.fireAlarm('poll-fav');
    releaseAllHang();
    await coveringAll;
    await waitForIdle();
    const mkbhdCovered = feedIdsOf(allCoverFetch.calls).filter((id) => id === MKBHD).length;
    t.check(
      'the favourite alarm did not start a second check',
      mkbhdCovered === 1,
      String(mkbhdCovered),
    );

    t.section('a skipped all-check covers a skipped favourite check');

    await waitForIdle();
    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true, favorite: true });
    await putChannel({ id: BEAST, title: 'MrBeast', seeded: true });
    let releasePartial;
    const partialHang = new Promise((resolve) => { releasePartial = resolve; });
    let partialInFeed = false;
    const partialFetch = installFetch({
      async hook(u) {
        if (u.includes('/feeds/videos.xml')) {
          const id = decodeURIComponent((u.match(/channel_id=([^&]+)/) || [])[1] || '');
          if (id === MKBHD && !partialInFeed) {
            partialInFeed = true;
            await partialHang;
          }
        }
        return undefined;
      },
      feeds: {
        [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', [{ v: 'partseed01', t: 'A', at: AT.newest }]),
        [BEAST]: rssXml(BEAST, 'MrBeast', [{ v: 'partseed02', t: 'B', at: AT.mid }]),
      },
    });
    const partialSweep = runSweep({ scope: 'all', onlyIds: [MKBHD] });
    for (let i = 0; i < 80 && !partialInFeed; i++) await wait(5);
    t.check('the partial check reached the feed', partialInFeed === true);
    await mock.fireAlarm('poll-all');
    await mock.fireAlarm('poll-all');
    await mock.fireAlarm('poll-fav');
    releasePartial();
    await partialSweep;
    t.check(
      'the skipped all-check fetched the other channel',
      await waitUntil(() => feedIdsOf(partialFetch.calls).includes(BEAST)),
      JSON.stringify(feedIdsOf(partialFetch.calls)),
    );
    await waitForIdle();
    const partialIds = feedIdsOf(partialFetch.calls);
    t.check(
      'one follow-up all-check fetched the other channel once',
      partialIds.filter((id) => id === BEAST).length === 1,
      JSON.stringify(partialIds),
    );
    t.check(
      'the favourite alarm was folded into the all-check',
      partialIds.filter((id) => id === MKBHD).length === 2,
      JSON.stringify(partialIds),
    );
    t.check(
      'and stored the non-favourite video',
      (await readFeed()).some((row) => row.v === 'partseed02'),
    );

    t.section('a manual refresh during a check is not queued');

    await waitForIdle();
    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true, favorite: true });
    await putChannel({ id: BEAST, title: 'MrBeast', seeded: true });
    let releaseManual;
    const manualHang = new Promise((resolve) => { releaseManual = resolve; });
    let manualInFeed = false;
    const manualFetch = installFetch({
      async hook(u) {
        if (u.includes('/feeds/videos.xml')) {
          const id = decodeURIComponent((u.match(/channel_id=([^&]+)/) || [])[1] || '');
          if (id === MKBHD && !manualInFeed) {
            manualInFeed = true;
            await manualHang;
          }
        }
        return undefined;
      },
      feeds: {
        [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', [{ v: 'manfav00001', t: 'Fav', at: AT.newest }]),
        [BEAST]: rssXml(BEAST, 'MrBeast', [{ v: 'manall00001', t: 'All', at: AT.mid }]),
      },
    });
    const hungFav = runSweep({ scope: 'favorites' });
    for (let i = 0; i < 80 && !manualInFeed; i++) await wait(5);
    t.check('the favourite check reached the feed', manualInFeed === true);
    const manualRefresh = await handleMessage({ type: 'sweep', scope: 'all' });
    t.check(
      'manual refresh is already running',
      manualRefresh.ok === false && manualRefresh.error === 'already running',
      JSON.stringify(manualRefresh),
    );
    releaseManual();
    await hungFav;
    await waitForIdle();
    t.check(
      'the manual refresh did not run after',
      !feedIdsOf(manualFetch.calls).includes(BEAST),
      JSON.stringify(feedIdsOf(manualFetch.calls)),
    );

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
      failBrowse: { [MKBHD]: 'gone' },
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
    t.check(
      'failed channel keeps the error kind and status for the popup',
      mk.lastError?.kind === 'http' && mk.lastError?.status === 500,
      JSON.stringify(mk.lastError),
    );
    t.check('successful channel lastError is null', mb.lastError === null);
    t.check('successful channel lastFetchAt is set', mb.lastFetchAt > 0, String(mb.lastFetchAt));
    const failFeed = await readFeed();
    t.check(
      'successful channel still landed in the feed',
      failFeed.length === 1 && failFeed[0].v === 'beastvid001' && failFeed[0].t === 'Beast video',
      JSON.stringify(failFeed),
    );

    t.section('the Videos tab stands in for a failing feed');

    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true, lastVideoAt: AT.mid });
    await saveFeed([{ v: 'feedknown01', c: MKBHD, t: 'Known', at: AT.mid, d: 600, vw: 1, k: 'video', st: 0 }]);
    await saveVideoMeta({ feedknown01: { k: 'video', d: 600, st: 0, at: AT.mid } });
    let tabFetch = installFetch({
      failFeeds: { [MKBHD]: '404' },
      videosTabs: {
        [MKBHD]: videosTabJson(MKBHD, [
          { v: 'tabnewvid01', t: 'Brand new', views: 12 },
          { v: 'feedknown01', t: 'Known' },
          { v: 'taboldvid01', t: 'Old long video' },
        ]),
      },
      players: {
        tabnewvid01: playerJson('tabnewvid01', { title: 'Brand new', publishDate: '2026-09-12T12:00:00+00:00' }),
        taboldvid01: playerJson('taboldvid01', { title: 'Old long video', publishDate: '2026-09-01T12:00:00+00:00' }),
      },
    });
    const tabSweep = await runSweep({ scope: 'all' });
    t.check('a sweep through the Videos tab is ok', tabSweep.ok === true, JSON.stringify(tabSweep));
    const tabBrowse = tabFetch.calls.filter((c) => c.url.includes('/youtubei/v1/browse'));
    t.check(
      'the feed 404 is answered with one Videos-tab browse',
      tabBrowse.length === 1 && bodyOf(tabBrowse[0].opts).browseId === MKBHD
        && bodyOf(tabBrowse[0].opts).params === 'EgZ2aWRlb3PyBgQKAjoA',
      JSON.stringify(tabBrowse.map((c) => c.opts.body)),
    );
    t.check('the channel is not marked broken', (await readChannels())[0].lastError === null);
    const tabFeed = await readFeed();
    const tabNew = tabFeed.find((row) => row.v === 'tabnewvid01');
    t.check(
      'a new row takes its upload time from the player',
      tabNew?.at === AT.newest && tabNew?.t === 'Brand new' && tabNew?.vw === 12,
      JSON.stringify(tabNew),
    );
    t.check(
      'a row already stored keeps its time',
      tabFeed.find((row) => row.v === 'feedknown01')?.at === AT.mid,
    );
    t.check(
      'only the video newer than the channel alerts',
      mock.notifications.length === 1 && mock.notifications[0].message === 'Brand new',
      JSON.stringify(mock.notifications),
    );
    t.check(
      'the older video is marked alerted silently',
      (await readPollState()).notified.includes('taboldvid01'),
    );

    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true });
    tabFetch = installFetch({ failFeeds: { [MKBHD]: 'network' } });
    await runSweep({ scope: 'all' });
    t.check(
      'a network error does not try the Videos tab',
      !tabFetch.calls.some((c) => c.url.includes('/youtubei/v1/browse')),
    );
    t.check('and is recorded as a network error', (await readChannels())[0].lastError?.kind === 'network');

    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true });
    installFetch({ failFeeds: { [MKBHD]: '404' }, failBrowse: { [MKBHD]: '429' } });
    const tabBlocked = await runSweep({ scope: 'all' });
    t.check('a 429 on the Videos tab is pushback', tabBlocked.error === 'slow down', JSON.stringify(tabBlocked));
    t.check('and does not mark the channel broken', (await readChannels())[0].lastError === null);
    await writePollState({ backoffUntil: 0, backoffLevel: 0 });

    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true });
    installFetch({ failFeeds: { [MKBHD]: '404' }, failBrowse: { [MKBHD]: 'gone' } });
    await runSweep({ scope: 'all' });
    const goneError = (await readChannels())[0].lastError;
    t.check(
      'a channel gone from both keeps the feed 404',
      goneError?.kind === 'http' && goneError?.status === 404,
      JSON.stringify(goneError),
    );

    t.section('channel records are written once per sweep');

    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: false });
    await putChannel({ id: BEAST, title: 'MrBeast', seeded: true });
    await putChannel({ id: 'UCXuqSBlHAE6Xw-yeJA0Tunw', title: 'Linus Tech Tips', seeded: true });
    installFetch({
      failFeeds: { [BEAST]: 'http' },
      failBrowse: { [BEAST]: 'gone' },
      feeds: { [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', [{ v: 'onewrite001', at: AT.newest }]) },
    });
    let channelWrites = 0;
    let countWrites = true;
    globalThis.chrome.storage.onChanged.addListener((changes, area) => {
      if (countWrites && area === 'local' && changes.channels) channelWrites++;
    });
    await runSweep({ scope: 'all' });
    countWrites = false;
    const oneWrite = await readChannels();
    t.check('three channels, one write', channelWrites === 1, String(channelWrites));
    t.check(
      'and it carries every change',
      oneWrite[0].seeded === true && oneWrite[0].lastVideoAt === AT.newest
        && oneWrite[1].lastError?.status === 500 && oneWrite[2].lastFetchAt > 0,
      JSON.stringify(oneWrite),
    );

    t.section('feeds are fetched three at a time');

    await wipe();
    const laneIds = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((ch) => `UC${ch.repeat(22)}`);
    for (const id of laneIds) await putChannel({ id, title: id, seeded: true });
    let inFlight = 0;
    let most = 0;
    const laneFetch = installFetch({
      async hook(u) {
        if (!u.includes('/feeds/videos.xml')) return undefined;
        inFlight++;
        most = Math.max(most, inFlight);
        await wait(30);
        inFlight--;
        return undefined;
      },
    });
    const laneStart = Date.now();
    await runSweep({ scope: 'all' });
    const laneMs = Date.now() - laneStart;
    t.check('never more than three at once', most === 3, String(most));
    t.check(
      'every channel is fetched',
      laneFetch.calls.filter((c) => c.url.includes('/feeds/videos.xml')).length === laneIds.length,
    );
    // Seven one after another, 250 ms apart, took over 1.5 s.
    t.check('the lanes run side by side', laneMs < 1200, `${laneMs} ms`);

    t.section('far-off premieres are not rechecked every sweep');

    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true });
    const soon = Date.now();
    await saveVideoMeta({
      premfar0001: { k: 'premiere', d: 0, st: soon + 3 * 86_400_000, ck: soon, at: AT.older },
      premnear001: { k: 'premiere', d: 0, st: soon + 20 * 60_000, ck: soon, at: AT.older },
      premstale01: { k: 'premiere', d: 0, st: soon + 3 * 86_400_000, ck: soon - 7 * 3_600_000, at: AT.older },
    });
    await saveFeed([
      { v: 'premfar0001', c: MKBHD, t: 'Far', at: AT.older, d: 0, vw: 0, k: 'premiere', st: soon + 3 * 86_400_000 },
      { v: 'premnear001', c: MKBHD, t: 'Near', at: AT.older, d: 0, vw: 0, k: 'premiere', st: soon + 20 * 60_000 },
      { v: 'premstale01', c: MKBHD, t: 'Stale', at: AT.older, d: 0, vw: 0, k: 'premiere', st: soon + 3 * 86_400_000 },
    ]);
    const premFetch = installFetch({
      players: {
        premnear001: playerJson('premnear001', { isUpcoming: true, startTimestamp: new Date(soon + 20 * 60_000).toISOString() }),
        premstale01: playerJson('premstale01', { isUpcoming: true, startTimestamp: new Date(soon + 3 * 86_400_000).toISOString() }),
      },
    });
    await runSweep({ scope: 'all' });
    const premAsked = premFetch.calls
      .filter((c) => c.url.includes('/youtubei/v1/player'))
      .map((c) => bodyOf(c.opts).videoId)
      .sort();
    t.check(
      'a premiere days away, checked recently, is skipped',
      JSON.stringify(premAsked) === JSON.stringify(['premnear001', 'premstale01']),
      JSON.stringify(premAsked),
    );
    const premMeta = await readVideoMeta();
    t.check(
      'a rechecked premiere records when it was checked',
      premMeta.premstale01?.ck >= soon && premMeta.premfar0001?.ck === soon,
      JSON.stringify(premMeta),
    );

    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true });
    await saveVideoMeta({
      leftoverlive: { k: 'live', d: 0, st: Date.now(), at: AT.older },
      stilllive001: { k: 'live', d: 0, st: Date.now(), at: AT.older },
    });
    await saveFeed([
      { v: 'stilllive001', c: MKBHD, t: 'Still live', at: AT.older, d: 0, vw: 0, k: 'live', st: Date.now() },
    ]);
    const leftFetch = installFetch({
      feeds: { [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', []) },
      players: {
        stilllive001: playerJson('stilllive001', { isLive: true, lengthSeconds: 0 }),
        leftoverlive: playerJson('leftoverlive', { isLive: true, lengthSeconds: 0 }),
      },
    });
    await runSweep({ scope: 'all' });
    const liveAsked = leftFetch.calls
      .filter((c) => c.url.includes('/youtubei/v1/player'))
      .map((c) => bodyOf(c.opts).videoId)
      .sort();
    t.check(
      'a live still in the feed is rechecked',
      liveAsked.includes('stilllive001'),
      JSON.stringify(liveAsked),
    );
    t.check(
      'a live that left the feed is not asked about',
      !liveAsked.includes('leftoverlive'),
      JSON.stringify(liveAsked),
    );

    t.section('YouTube pushback stops the sweep and waits');

    const LINUS = 'UCXuqSBlHAE6Xw-yeJA0Tunw';
    const FOURTH = `UC${'d'.repeat(22)}`;
    const FIFTH = `UC${'e'.repeat(22)}`;
    const QUARTER_HOUR = 15 * 60_000;
    const feedCallsTo = (calls) => calls
      .filter((c) => c.url.includes('/feeds/videos.xml'))
      .map((c) => decodeURIComponent((c.url.match(/channel_id=([^&]+)/) || [])[1] || ''));

    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true });
    await putChannel({ id: BEAST, title: 'MrBeast', seeded: true });
    await putChannel({ id: LINUS, title: 'Linus Tech Tips', seeded: true });
    await putChannel({ id: FOURTH, title: 'Fourth', seeded: true });
    await putChannel({ id: FIFTH, title: 'Fifth', seeded: true });
    let pushFetch = installFetch({
      failFeeds: { [BEAST]: '429' },
      feeds: { [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', [{ v: 'beforeblock', t: 'Before', at: AT.newest }]) },
    });
    const pushStart = Date.now();
    const pushed = await runSweep({ scope: 'all' });
    const pushEnd = Date.now();
    t.check('a 429 makes the sweep report slow down', pushed.ok === false && pushed.error === 'slow down', JSON.stringify(pushed));
    // Three lanes start together, so the third channel was already on its
    // way when the 429 came back. Nothing starts after it.
    t.check(
      'no channel starts after the 429',
      JSON.stringify(feedCallsTo(pushFetch.calls)) === JSON.stringify([MKBHD, BEAST, LINUS]),
      JSON.stringify(feedCallsTo(pushFetch.calls)),
    );
    t.check(
      'a 429 is not answered with the Videos tab',
      !pushFetch.calls.some((c) => c.url.includes('/youtubei/v1/browse')),
    );
    const pushedChannels = await readChannels();
    t.check(
      'the refused channel is not marked broken',
      pushedChannels.find((c) => c.id === BEAST).lastError === null,
      JSON.stringify(pushedChannels.find((c) => c.id === BEAST).lastError),
    );
    t.check('the skipped channel is not marked broken', pushedChannels.find((c) => c.id === FOURTH).lastError === null);
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
    const seedEntries = ['01', '02', '03', '04', '05'].map((n, i) => (
      { v: `blockseed${n}`, t: `Old ${n}`, at: AT.older + i * 60_000 }
    ));
    pushFetch = installFetch({ feeds: { [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', seedEntries) }, playerStatus: 429 });
    const classifyPush = await runSweep({ scope: 'all' });
    t.check('a 429 while classifying is pushback too', classifyPush.error === 'slow down', JSON.stringify(classifyPush));
    t.check(
      'classification starts nothing after the first 429',
      pushFetch.calls.filter((c) => c.url.includes('/youtubei/v1/player')).length === 3,
      String(pushFetch.calls.filter((c) => c.url.includes('/youtubei/v1/player')).length),
    );
    t.check('a new channel stays unseeded when its backfill was cut short', (await readChannels())[0].seeded === false);
    await writePollState({ backoffUntil: Date.now() - 1 });
    installFetch({ feeds: { [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', seedEntries) } });
    await runSweep({ scope: 'all' });
    t.check('the backfill finishes on the next sweep', (await readFeed()).length === 5, String((await readFeed()).length));
    t.check('and is still silent', mock.notifications.length === 0, JSON.stringify(mock.notifications));
    t.check('the channel is seeded afterwards', (await readChannels())[0].seeded === true);

    t.section('Innertube 403');

    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true, lastVideoAt: AT.older });
    const one403 = installFetch({
      feeds: { [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', [{ v: 'forb0010001', t: 'One 403', at: AT.newest }]) },
      playerStatus: 403,
    });
    const dnrAtOne = mock.dnrUpdates.length;
    const oneForbidden = await runSweep({ scope: 'all' });
    t.check('a single player 403 is not pushback', oneForbidden.ok === true, JSON.stringify(oneForbidden));
    t.check('the Origin rule is not reinstalled for one 403', mock.dnrUpdates.length === dnrAtOne, String(mock.dnrUpdates.length));
    t.check('the 403 video is left out of the feed', (await readFeed()).length === 0, JSON.stringify(await readFeed()));
    t.check(
      'one 403 is one player call',
      one403.calls.filter((c) => c.url.includes('/youtubei/v1/player')).length === 1,
    );

    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true, lastVideoAt: AT.older });
    const threeEntries = ['a', 'b', 'c'].map((n, i) => (
      { v: `forb003000${n}`, t: `Three ${n}`, at: AT.newest + i }
    ));
    installFetch({
      feeds: { [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', threeEntries) },
      playerStatus: 403,
    });
    const dnrAtThree = mock.dnrUpdates.length;
    const threeForbidden = await runSweep({ scope: 'all' });
    t.check('three player 403s still finish the sweep', threeForbidden.ok === true, JSON.stringify(threeForbidden));
    t.check(
      'three 403s reinstall the Origin rule once',
      mock.dnrUpdates.length === dnrAtThree + 1,
      String(mock.dnrUpdates.length - dnrAtThree),
    );
    t.check('three 403s do not set a wait', (await readPollState()).backoffUntil === 0);

    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true, lastVideoAt: AT.older });
    const fourEntries = ['a', 'b', 'c', 'd'].map((n, i) => (
      { v: `forb004000${n}`, t: `Four ${n}`, at: AT.newest + i }
    ));
    const four403 = installFetch({
      feeds: { [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', fourEntries) },
      playerStatus: 403,
    });
    const fourStart = Date.now();
    const fourForbidden = await runSweep({ scope: 'all' });
    t.check('a fourth player 403 is pushback', fourForbidden.ok === false && fourForbidden.error === 'slow down', JSON.stringify(fourForbidden));
    t.check(
      'the wait is set after stacked 403s',
      (await readPollState()).backoffUntil >= fourStart + QUARTER_HOUR,
      String((await readPollState()).backoffUntil),
    );
    t.check(
      'classification stops after the fourth 403',
      four403.calls.filter((c) => c.url.includes('/youtubei/v1/player')).length === 4,
      String(four403.calls.filter((c) => c.url.includes('/youtubei/v1/player')).length),
    );

    await wipe();
    await writePollState({ backoffUntil: 0, backoffLevel: 0 });
    const rss403Ids = ['a', 'b', 'c', 'd'].map((ch) => `UC${ch.repeat(22)}`);
    for (const id of rss403Ids) await putChannel({ id, title: id, seeded: true });
    const rss403 = Object.fromEntries(rss403Ids.map((id) => [id, '403']));
    const browseFail = Object.fromEntries(rss403Ids.map((id) => [id, 500]));
    installFetch({ failFeeds: rss403, failBrowse: browseFail });
    const dnrAtRss = mock.dnrUpdates.length;
    const rssForbidden = await runSweep({ scope: 'all' });
    t.check('RSS 403s are per-channel errors, not pushback', rssForbidden.ok === true, JSON.stringify(rssForbidden));
    t.check('RSS 403s do not reinstall the Origin rule', mock.dnrUpdates.length === dnrAtRss);
    t.check(
      'each RSS 403 is stored on the channel',
      (await readChannels()).every((ch) => ch.lastError?.status === 403),
    );
    t.check('RSS 403s do not set a wait', (await readPollState()).backoffUntil === 0);

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

    t.section('a muted channel does not alert');

    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true, favorite: true });
    await putChannel({ id: BEAST, title: 'MrBeast', seeded: true, favorite: true });
    const muteRes = await handleMessage({ type: 'setMuted', id: MKBHD, on: true });
    t.check('setMuted reports ok', muteRes.ok === true, JSON.stringify(muteRes));
    installFetch({
      feeds: {
        [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', [{ v: 'mutednew001', t: 'Muted video', at: AT.newest }]),
        [BEAST]: rssXml(BEAST, 'MrBeast', [{ v: 'loudnew0001', t: 'Loud video', at: AT.mid }]),
      },
    });
    await runSweep({ scope: 'all' });
    t.check(
      'a muted favourite stays quiet while another favourite alerts',
      mock.notifications.length === 1 && mock.notifications[0].title === 'MrBeast',
      JSON.stringify(mock.notifications),
    );
    t.check('its video still reaches the feed', (await readFeed()).some((row) => row.v === 'mutednew001'));
    t.check('and it stays a favourite', (await readChannels()).find((c) => c.id === MKBHD)?.favorite === true);
    await handleMessage({ type: 'setMuted', id: MKBHD, on: false });
    const beforeUnmuted = mock.notifications.length;
    await runSweep({ scope: 'all' });
    t.check(
      'unmuting does not alert for the video that arrived while muted',
      mock.notifications.length === beforeUnmuted,
      JSON.stringify(mock.notifications),
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

    t.section('a clicked notification goes away and does not stack tabs');

    await saveFeed([
      { v: 'newvid00001', c: CLICK_CH, t: 'New', at: 100, d: 1, vw: 0, k: 'video', st: 0 },
    ]);
    mock.tabsCreated.length = 0;
    mock.tabsUpdated.length = 0;
    mock.windowsUpdated.length = 0;
    mock.notificationsCleared.length = 0;
    mock.urlTabs = [];
    await onNotificationClicked(`yt:${CLICK_CH}`);
    t.check(
      'the click clears that notification',
      mock.notificationsCleared.length === 1 && mock.notificationsCleared[0] === `yt:${CLICK_CH}`,
      JSON.stringify(mock.notificationsCleared),
    );
    t.check('with no tab on the video yet, one tab opens', mock.tabsCreated.length === 1, String(mock.tabsCreated.length));

    mock.tabsCreated.length = 0;
    mock.urlTabs = [{ id: 31, windowId: 7, url: 'https://www.youtube.com/watch?v=newvid00001&t=12s' }];
    await onNotificationClicked(`yt:${CLICK_CH}`);
    t.check('a later click opens no new tab', mock.tabsCreated.length === 0, String(mock.tabsCreated.length));
    t.check(
      'it brings the tab already on that video forward',
      mock.tabsUpdated.some((u) => u.tabId === 31 && u.active === true)
        && mock.windowsUpdated.some((w) => w.windowId === 7 && w.focused === true),
      JSON.stringify({ tabs: mock.tabsUpdated, windows: mock.windowsUpdated }),
    );
    mock.urlTabs = null;

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
    t.check(
      'popupOpened returns the previous lastSeenAt',
      opened.previousLastSeenAt === 0,
      String(opened.previousLastSeenAt),
    );

    await writePollState({ lastSeenAt: 50 });
    await refreshBadge();
    t.check(
      'badge still counts items newer than lastSeenAt before the next open',
      mock.badgeText === '3',
      JSON.stringify(mock.badgeText),
    );
    const openedAgain = await handleMessage({ type: 'popupOpened' });
    t.check(
      'popupOpened returns the last visit',
      openedAgain.previousLastSeenAt === 50,
      String(openedAgain.previousLastSeenAt),
    );
    t.check(
      'popupOpened still moves lastSeenAt forward',
      openedAgain.pollState.lastSeenAt > 50
        && openedAgain.pollState.lastSeenAt >= beforeOpen,
      String(openedAgain.pollState.lastSeenAt),
    );
    t.check('badge still clears on open', mock.badgeText === '', JSON.stringify(mock.badgeText));
    t.check(
      'getState does not carry previousLastSeenAt',
      !('previousLastSeenAt' in (await handleMessage({ type: 'getState' }))),
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

    t.section('badge honours feed.group');

    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', groups: ['Music'], seeded: true });
    await putChannel({ id: BEAST, title: 'MrBeast', groups: ['News'], seeded: true });
    await saveFeed([
      { v: 'musicnew01', c: MKBHD, t: 'Music new', at: 100, d: 1, vw: 0, k: 'video', st: 0 },
      { v: 'newsnew001', c: BEAST, t: 'News new', at: 90, d: 1, vw: 0, k: 'video', st: 0 },
      { v: 'musicold01', c: MKBHD, t: 'Music old', at: 10, d: 1, vw: 0, k: 'video', st: 0 },
    ]);
    await writePollState({ lastSeenAt: 50 });
    await writeSettings({ feed: { showShorts: true, favoritesOnly: false, group: 'Music' } });
    await refreshBadge();
    t.check(
      'a selected group counts only that group\'s new videos',
      mock.badgeText === '1',
      JSON.stringify(mock.badgeText),
    );

    await writeSettings({ feed: { group: 'Gone' } });
    await refreshBadge();
    t.check(
      'an unknown group counts every channel',
      mock.badgeText === '2',
      JSON.stringify(mock.badgeText),
    );

    await writeSettings({ feed: { group: 'News', favoritesOnly: true } });
    await refreshBadge();
    t.check(
      'group plus favourites-only with no favourite in that group is empty',
      mock.badgeText === '',
      JSON.stringify(mock.badgeText),
    );

    t.section('starring updates the favourites-only badge');

    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', favorite: false, seeded: true });
    await putChannel({ id: BEAST, title: 'MrBeast', favorite: true, seeded: true });
    await saveFeed([
      { v: 'newmkbhd01', c: MKBHD, t: 'New', at: 100, d: 1, vw: 0, k: 'video', st: 0 },
      { v: 'oldbeast01', c: BEAST, t: 'Old', at: 10, d: 1, vw: 0, k: 'video', st: 0 },
    ]);
    await writePollState({ lastSeenAt: 50 });
    await writeSettings({ feed: { showShorts: true, favoritesOnly: true } });
    await refreshBadge();
    t.check(
      'favourites-only badge ignores an unstarred channel with new videos',
      mock.badgeText === '',
      JSON.stringify(mock.badgeText),
    );
    const fetchCallsBeforeStar = (globalThis.fetch && globalThis.fetch.calls && globalThis.fetch.calls.length) || 0;
    const starred = await handleMessage({ type: 'setFavorite', id: MKBHD, on: true });
    t.check('setFavorite reports ok', starred.ok === true, JSON.stringify(starred));
    t.check(
      'starring updates the badge without a check',
      mock.badgeText === '1',
      JSON.stringify(mock.badgeText),
    );
    t.check(
      'starring does not fetch',
      !globalThis.fetch?.calls || globalThis.fetch.calls.length === fetchCallsBeforeStar,
      String(globalThis.fetch?.calls?.length),
    );
    const unstarred = await handleMessage({ type: 'setFavorite', id: MKBHD, on: false });
    t.check('unstarring reports ok', unstarred.ok === true, JSON.stringify(unstarred));
    t.check(
      'unstarring updates the badge without a check',
      mock.badgeText === '',
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

    t.section('audioMode.boot overlay strings');

    installFetch();
    await wipe();
    await writeSettings({ ui: { locale: 'en' } });
    const bootEn = await handleMessage({ type: 'audioMode.boot' }, { tab: { id: 21 } });
    t.check(
      'en boot overlay title',
      bootEn.ok === true && bootEn.locale === 'en' && bootEn.overlay?.overlayTitle === 'Audio-only playback',
      JSON.stringify(bootEn.overlay),
    );
    t.check(
      'en boot overlay exit',
      bootEn.overlay?.overlayExit === 'Exit audio mode',
      JSON.stringify(bootEn.overlay),
    );
    t.check(
      'en boot overlay shortcut template',
      bootEn.overlay?.overlayExitShortcut === 'Press $1 to exit',
      JSON.stringify(bootEn.overlay),
    );
    t.check(
      'en boot overlay has only the overlay keys',
      JSON.stringify(Object.keys(bootEn.overlay || {}).sort()) === JSON.stringify([
        'overlayExit',
        'overlayExitShortcut',
        'overlayTitle',
        'scanAccount',
        'scanAccountChannels',
        'scanAccountChannelsOne',
        'scanAccountHere',
        'scanAccountMore',
        'scanAccountNone',
        'scanAccountScan',
        'scanAccountUncounted',
        'scanAccounts',
        'scanAddNew',
        'scanAdded',
        'scanAddedOne',
        'scanAnother',
        'scanChoose',
        'scanDifferLine',
        'scanDifferTitle',
        'scanDone',
        'scanExpired',
        'scanExportFailed',
        'scanExportSaved',
        'scanFailed',
        'scanFound',
        'scanLoaded',
        'scanNothing',
        'scanRemoved',
        'scanRemovedOne',
        'scanReplaceCancel',
        'scanReplaceDelete',
        'scanReplaceEmpty',
        'scanReplaceExport',
        'scanReplaceList',
        'scanReplaceWarn',
        'scanReplaceWarnOne',
        'scanSignedOut',
        'scanSignedOutFile',
        'scanSkipped',
        'scanSkippedOne',
        'scanStay',
        'scanTitle',
        'subsGroupsAll',
        'subsGroupsLabel',
        'subsGroupsMatch',
        'subsGroupsMatchOne',
      ]),
      JSON.stringify(Object.keys(bootEn.overlay || {})),
    );
    t.check(
      'en boot carries the scan headline',
      bootEn.overlay?.scanTitle === 'Scanning your channels' && bootEn.overlay?.scanAdded === 'Added $1 channels',
      JSON.stringify(bootEn.overlay),
    );
    t.check(
      'en boot carries the differ choice',
      bootEn.overlay?.scanDifferTitle === 'Your watchlist and this account differ'
        && bootEn.overlay?.scanDifferLine === '$1 new on YouTube · $2 on your watchlist only'
        && bootEn.overlay?.scanAddNew === 'Add new'
        && bootEn.overlay?.scanReplaceList === 'Replace watchlist'
        && bootEn.overlay?.scanReplaceDelete === 'Delete and replace'
        && bootEn.overlay?.scanRemoved === 'Removed $1 channels'
        && bootEn.overlay?.scanRemovedOne === 'Removed $1 channel',
      JSON.stringify({
        title: bootEn.overlay?.scanDifferTitle,
        line: bootEn.overlay?.scanDifferLine,
      }),
    );
    t.check(
      'en boot also carries Arabic overlay copy',
      bootEn.overlays?.ar?.overlayTitle === 'تشغيل الصوت فقط',
      JSON.stringify(bootEn.overlays?.ar),
    );
    t.check(
      'en boot still reports openInAudioMode',
      bootEn.openInAudioMode === false,
      JSON.stringify(bootEn),
    );

    await writeSettings({ ui: { locale: 'ar' } });
    const bootAr = await handleMessage({ type: 'audioMode.boot' }, { tab: { id: 22 } });
    t.check(
      'ar boot overlay title',
      bootAr.ok === true && bootAr.locale === 'ar' && bootAr.overlay?.overlayTitle === 'تشغيل الصوت فقط',
      JSON.stringify(bootAr.overlay),
    );
    t.check(
      'ar boot overlay exit',
      bootAr.overlay?.overlayExit === 'خروج من وضع الصوت',
      JSON.stringify(bootAr.overlay),
    );
    t.check(
      'ar boot overlay shortcut template',
      bootAr.overlay?.overlayExitShortcut === 'اضغط $1 للخروج',
      JSON.stringify(bootAr.overlay),
    );
    t.check(
      'ar boot names the differ choice without inflecting',
      bootAr.overlay?.scanDifferLine === 'جديد على يوتيوب: $1 · في قائمتك فقط: $2'
        && bootAr.overlay?.scanRemoved === 'القنوات المحذوفة: $1'
        && bootAr.overlay?.scanRemoved === bootAr.overlay?.scanRemovedOne
        && bootAr.overlay?.scanDifferTitle !== bootEn.overlay?.scanDifferTitle,
      JSON.stringify(bootAr.overlay?.scanDifferLine),
    );
    t.check(
      'ar boot also carries English overlay copy',
      bootAr.overlays?.en?.overlayTitle === 'Audio-only playback',
      JSON.stringify(bootAr.overlays?.en),
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
    t.check('getState has queue', Array.isArray(state.queue) && state.queue.length === 0, JSON.stringify(state.queue));
    t.check('getState has queueOpen closed', state.queueOpen === false, String(state.queueOpen));

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
    t.check('addChannel replies unseeded', viaWatch.channel?.seeded === false, JSON.stringify(viaWatch.channel));
    t.check('addChannel reply carries state', Array.isArray(viaWatch.state?.channels), JSON.stringify(viaWatch.state?.channels?.map((c) => c.id)));
    t.check(
      'awaited the background seed',
      await waitUntil(async () => (await readChannels()).find((c) => c.id === VIA)?.seeded === true),
    );
    await waitForIdle();

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
    t.check('addChannel replies before the seed', added.channel?.seeded === false, JSON.stringify(added.channel));
    t.check(
      'the background seed finished',
      await waitUntil(async () => (await readChannels()).find((c) => c.id === BEAST)?.seeded === true),
    );
    await waitForIdle();
    t.check('addChannel seeds silently', (await readChannels()).find((c) => c.id === BEAST)?.seeded === true);
    t.check(
      'addChannel seed created ZERO notifications',
      mock.notifications.length === 0,
      JSON.stringify(mock.notifications),
    );
    t.check(
      'addChannel seed landed the item',
      (await readFeed()).some((row) => row.v === 'beastseed01'),
    );
    t.check(
      'a YouTube picture is kept',
      added.channel?.avatar === 'https://yt3.ggpht.com/beast',
      added.channel?.avatar,
    );

    const BADPIC = 'UC0000000000000000000002';
    installFetch({
      resolveId: BADPIC,
      browse: headerJson(BADPIC, 'Bad Pic', '@badpic', 'https://evil.example/avatar.png'),
      feeds: { [BADPIC]: rssXml(BADPIC, 'Bad Pic', []) },
    });
    const badPic = await addChannelByInput('@badpic');
    t.check(
      'a non-YouTube picture is stored empty',
      badPic.ok === true && badPic.channel?.id === BADPIC && badPic.channel?.avatar === '',
      JSON.stringify(badPic.channel),
    );
    await waitForIdle();

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
    t.check(
      'addChannel still ok when the seed sweep throws',
      addedDespiteSweep.ok === true && addedDespiteSweep.channel?.id === LTT,
      JSON.stringify(addedDespiteSweep),
    );
    t.check('replies before the throwing seed', addedDespiteSweep.channel?.seeded === false);
    await waitForIdle();
    globalThis.chrome.action.setBadgeText = badgeFn;
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

    await waitForIdle();
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
    const channelsBeforeRemove = await readChannels();
    const feedBeforeRemove = await readFeed();
    const beastRowsBefore = feedBeforeRemove.filter((row) => row.c === BEAST);
    const removed = await handleMessage({ type: 'removeChannel', id: BEAST });
    t.check('removeChannel reports ok', removed.ok === true);
    t.check('removeChannel dropped the channel', !(await readChannels()).some((c) => c.id === BEAST));
    t.check(
      'removeChannel dropped that channel\'s feed items',
      !(await readFeed()).some((row) => row.c === BEAST),
    );

    t.section('undo remove');

    t.check('the removed channel had videos to bring back', beastRowsBefore.length > 0, String(beastRowsBefore.length));
    t.check('the snapshot lives in session storage', mock.session.lastRemovedChannel?.channel?.id === BEAST);
    t.check('and not in local storage', !('lastRemovedChannel' in mock.storage));
    const wrongUndo = await handleMessage({ type: 'undoRemove', id: MKBHD });
    t.check('undo for a different channel is refused', wrongUndo.ok === false, JSON.stringify(wrongUndo));
    t.check('and keeps the snapshot', mock.session.lastRemovedChannel?.channel?.id === BEAST);
    const notifiedBeforeUndo = mock.notifications.length;
    const undone = await handleMessage({ type: 'undoRemove', id: BEAST });
    t.check('undoRemove reports ok', undone.ok === true, JSON.stringify(undone));
    t.check(
      'the channel list is exactly as before, in the same order',
      JSON.stringify(await readChannels()) === JSON.stringify(channelsBeforeRemove),
      JSON.stringify((await readChannels()).map((c) => c.id)),
    );
    t.check(
      'the feed is exactly as before',
      JSON.stringify(await readFeed()) === JSON.stringify(feedBeforeRemove),
    );
    t.check('bringing videos back alerts nothing', mock.notifications.length === notifiedBeforeUndo);
    t.check('the snapshot is used up', !('lastRemovedChannel' in mock.session));
    const twice = await handleMessage({ type: 'undoRemove', id: BEAST });
    t.check('a second undo has nothing to do', twice.ok === false && twice.error === 'nothing to undo', JSON.stringify(twice));

    await handleMessage({ type: 'removeChannel', id: BEAST });
    await addChannel({ id: BEAST, title: 'MrBeast again' });
    const afterReAdd = await handleMessage({ type: 'undoRemove', id: BEAST });
    t.check('undo after re-adding the channel does not duplicate it', afterReAdd.ok === false
      && (await readChannels()).filter((c) => c.id === BEAST).length === 1, JSON.stringify(afterReAdd));
    await handleMessage({ type: 'removeChannel', id: BEAST });

    t.section('Follow during a running check is queued and seeded after');

    await waitForIdle();
    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true });
    let releaseQueueHang;
    const queueHang = new Promise((resolve) => { releaseQueueHang = resolve; });
    let queueInFeed = false;
    const queuedA = 'UC000000000000000000000A';
    const queuedB = 'UC000000000000000000000B';
    const queueFetch = installFetch({
      async hook(u, opts) {
        if (u.includes('/feeds/videos.xml')) {
          const id = decodeURIComponent((u.match(/channel_id=([^&]+)/) || [])[1] || '');
          if (id === MKBHD) {
            queueInFeed = true;
            await queueHang;
            return textRes(rssXml(MKBHD, 'Marques Brownlee', []));
          }
        }
        if (u.includes('/youtubei/v1/browse')) {
          const id = bodyOf(opts).browseId;
          if (id === queuedA) return jsonRes(headerJson(queuedA, 'Queued A', '@a', 'https://yt3.ggpht.com/a'));
          if (id === queuedB) return jsonRes(headerJson(queuedB, 'Queued B', '@b', 'https://yt3.ggpht.com/b'));
        }
        return undefined;
      },
      feeds: {
        [queuedA]: rssXml(queuedA, 'Queued A', [{ v: 'queuedaaa01', t: 'A seed', at: AT.newest }]),
        [queuedB]: rssXml(queuedB, 'Queued B', [{ v: 'queuedbbb01', t: 'B seed', at: AT.newest }]),
      },
    });
    const hungSweep = runSweep({ scope: 'all' });
    for (let i = 0; i < 80 && !queueInFeed; i++) await wait(5);
    t.check('the running check reached the feed', queueInFeed === true);
    mock.notifications.length = 0;
    const followA = await handleMessage({ type: 'addChannel', input: queuedA });
    const followB = await handleMessage({ type: 'addChannel', input: queuedB });
    t.check(
      'both Follows reply before the running check ends',
      followA.ok && followA.channel?.seeded === false && followB.ok && followB.channel?.seeded === false,
      JSON.stringify({ a: followA, b: followB }),
    );
    const feedsDuringHang = queueFetch.calls.filter((c) => String(c.url).includes('/feeds/videos.xml')).length;
    t.check('neither Follow fetched a feed while the check ran', feedsDuringHang === 1, String(feedsDuringHang));
    releaseQueueHang();
    await hungSweep;
    t.check(
      'both queued ids seed after the check',
      await waitUntil(async () => {
        const list = await readChannels();
        return list.find((c) => c.id === queuedA)?.seeded === true
          && list.find((c) => c.id === queuedB)?.seeded === true;
      }),
    );
    t.check(
      'one follow-up sweep fetched both new feeds',
      queueFetch.calls.filter((c) => String(c.url).includes('/feeds/videos.xml')
        && (String(c.url).includes(queuedA) || String(c.url).includes(queuedB))).length === 2,
    );
    t.check(
      'queued seeds are silent',
      mock.notifications.length === 0
        && (await readFeed()).some((row) => row.v === 'queuedaaa01')
        && (await readFeed()).some((row) => row.v === 'queuedbbb01'),
      JSON.stringify(mock.notifications),
    );

    t.section('Add during backoff stays unseeded');

    await wipe();
    await writePollState({ backoffUntil: Date.now() + 60_000, backoffLevel: 1 });
    const backoffFetch = installFetch({
      browse: headerJson(VIA, 'Via Watch', '@viawatch', 'https://yt3.ggpht.com/via'),
      feeds: {
        [VIA]: rssXml(VIA, 'Via Watch', [{ v: 'backoffvid1', t: 'Should wait', at: AT.newest }]),
      },
    });
    const addedDuringBackoff = await handleMessage({ type: 'addChannel', input: VIA });
    t.check(
      'Add during backoff still stores the channel',
      addedDuringBackoff.ok === true && addedDuringBackoff.channel?.id === VIA,
      JSON.stringify(addedDuringBackoff),
    );
    await wait(40);
    t.check(
      'and does not seed-fetch',
      !backoffFetch.calls.some((c) => String(c.url).includes('/feeds/videos.xml')),
      JSON.stringify(backoffFetch.calls.map((c) => c.url)),
    );
    t.check(
      'the channel stays unseeded',
      (await readChannels()).find((c) => c.id === VIA)?.seeded === false,
    );

    t.section('an unseeded channel left by a killed worker seeds silently');

    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: false });
    installFetch({
      feeds: {
        [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', [
          { v: 'killedseed1', t: 'After kill', at: AT.newest },
        ]),
      },
    });
    mock.notifications.length = 0;
    await runSweep({ scope: 'all' });
    t.check('the next check seeds it', (await readChannels())[0]?.seeded === true);
    t.check(
      'and lands the videos with no alert',
      (await readFeed()).some((row) => row.v === 'killedseed1') && mock.notifications.length === 0,
      JSON.stringify(mock.notifications),
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

    t.section('importing a Takeout subscriptions file');

    const LINUS_ID = 'UCXuqSBlHAE6Xw-yeJA0Tunw';
    const takeoutCsv = (ids) => ['Channel Id,Channel Url,Channel Title',
      ...ids.map((id) => `${id},http://www.youtube.com/channel/${id},Name ${id.slice(-4)}`)].join('\n');
    const headerHook = (browsed) => async (u, opts) => {
      if (!u.includes('/youtubei/v1/browse')) return undefined;
      const id = bodyOf(opts).browseId;
      browsed.push(id);
      return jsonRes(headerJson(id, `Current ${id.slice(-4)}`, `@h${id.slice(-4)}`, `https://yt3.ggpht.com/${id}`));
    };

    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true, favorite: true });
    let takeoutWrites = 0;
    let countTakeoutWrites = true;
    globalThis.chrome.storage.onChanged.addListener((changes, area) => {
      if (countTakeoutWrites && area === 'local' && changes.channels) takeoutWrites++;
    });
    const imported = await handleMessage({ type: 'importTakeout', data: takeoutCsv([MKBHD, BEAST, LINUS_ID]) });
    countTakeoutWrites = false;
    t.check(
      'adds the channels not on the list and counts the rest',
      imported.ok === true && imported.added === 2 && imported.skipped === 1,
      JSON.stringify(imported),
    );
    t.check('in one write', takeoutWrites === 1, String(takeoutWrites));
    const afterImport = await readChannels();
    t.check(
      'after the channels already there, in file order',
      afterImport.map((ch) => ch.id).join() === [MKBHD, BEAST, LINUS_ID].join(),
      JSON.stringify(afterImport.map((ch) => ch.id)),
    );
    t.check('an existing channel keeps its star', afterImport[0].favorite === true);
    t.check(
      'a new one has the file title, no picture, and waits for a silent first check',
      afterImport[1].title === `Name ${BEAST.slice(-4)}` && afterImport[1].avatar === ''
        && afterImport[1].seeded === false && afterImport[1].lastError === null,
      JSON.stringify(afterImport[1]),
    );
    const importedAgain = await handleMessage({ type: 'importTakeout', data: takeoutCsv([BEAST, LINUS_ID]) });
    t.check('the same file twice adds nothing', importedAgain.ok && importedAgain.added === 0 && importedAgain.skipped === 2, JSON.stringify(importedAgain));
    const listBefore = await readChannels();
    const nearlyFull = Array.from({ length: 1998 }, (_, i) => ({ ...listBefore[1], id: `UC${String(i).padStart(22, '0')}` }));
    await globalThis.chrome.storage.local.set({ channels: nearlyFull });
    const overLimit = await handleMessage({ type: 'importTakeout', data: takeoutCsv([MKBHD, BEAST, LINUS_ID]) });
    t.check('an import that would take the list past 2,000 is refused', overLimit.ok === false && overLimit.error === 'count', JSON.stringify(overLimit));
    t.check('and adds none of it', (await readChannels()).length === 1998);

    const backupLive = Array.from({ length: 1990 }, (_, i) => ({
      ...listBefore[0],
      id: `UC${String(i).padStart(22, '0')}`,
    }));
    await globalThis.chrome.storage.local.set({ channels: backupLive });
    const mergeOver = await handleMessage({
      type: 'importBackup',
      mode: 'merge',
      data: JSON.stringify({
        app: 'youtube-companion',
        version: 1,
        settings: {},
        channels: Array.from({ length: 20 }, (_, i) => ({
          id: `UC${String(i + 3000).padStart(22, '0')}`,
        })),
      }),
    });
    t.check(
      'a merge backup that would pass 2,000 is refused',
      mergeOver.ok === false && typeof mergeOver.error === 'string' && mergeOver.error.includes('2000'),
      JSON.stringify(mergeOver),
    );
    t.check('and adds none of it', (await readChannels()).length === 1990);
    await globalThis.chrome.storage.local.set({ channels: listBefore });
    const notTakeout = await handleMessage({ type: 'importTakeout', data: '{"app":"youtube-companion"}' });
    t.check('a file with no channel rows is refused with its reason', notTakeout.ok === false && notTakeout.error === 'empty', JSON.stringify(notTakeout));
    t.check('and changes nothing', (await readChannels()).length === 3);

    t.section('an imported list fills in quietly');

    await wipe();
    await handleMessage({ type: 'importTakeout', data: takeoutCsv([BEAST, LINUS_ID]) });
    let browsed = [];
    installFetch({
      hook: headerHook(browsed),
      feeds: {
        [BEAST]: rssXml(BEAST, 'MrBeast', [{ v: 'importbst01', at: AT.newest }, { v: 'importbst02', at: AT.mid }]),
        [LINUS_ID]: rssXml(LINUS_ID, 'Linus', [{ v: 'importlts01', at: AT.older }]),
      },
    });
    await runSweep({ scope: 'all' });
    t.check('the first check brings their videos', (await readFeed()).length === 3, String((await readFeed()).length));
    t.check('with no alert', mock.notifications.length === 0, JSON.stringify(mock.notifications));
    const filled = await readChannels();
    t.check('each channel without a picture has its header read once', browsed.sort().join() === [BEAST, LINUS_ID].sort().join(), JSON.stringify(browsed));
    t.check(
      'which brings its picture, handle and current name',
      filled[0].avatar === `https://yt3.ggpht.com/${BEAST}` && filled[0].handle === `@h${BEAST.slice(-4)}`
        && filled[0].title === `Current ${BEAST.slice(-4)}` && filled[0].seeded === true,
      JSON.stringify(filled[0]),
    );
    browsed = [];
    installFetch({ hook: headerHook(browsed) });
    await runSweep({ scope: 'all' });
    t.check('a channel with a picture is not read again', browsed.length === 0, JSON.stringify(browsed));

    await wipe();
    await handleMessage({ type: 'importTakeout', data: takeoutCsv([BEAST]) });
    installFetch({ failBrowse: { [BEAST]: 'gone' } });
    await runSweep({ scope: 'all' });
    t.check('a header that fails is still stamped', (await readChannels())[0].headerAt > 0, JSON.stringify((await readChannels())[0]));
    browsed = [];
    installFetch({ hook: headerHook(browsed) });
    await runSweep({ scope: 'all' });
    t.check('and not asked again the same day', browsed.length === 0, JSON.stringify(browsed));

    await wipe();
    const manyImported = Array.from({ length: 11 }, (_, i) => `UC${String(i).padStart(2, '0').repeat(11)}`);
    await handleMessage({ type: 'importTakeout', data: takeoutCsv(manyImported) });
    browsed = [];
    installFetch({ hook: headerHook(browsed) });
    await runSweep({ scope: 'all' });
    t.check('at most 10 headers are read in one check', browsed.length === 10, String(browsed.length));
    browsed.length = 0;
    await runSweep({ scope: 'all' });
    t.check('the rest come with the next check', browsed.length === 1, String(browsed.length));

    await wipe();
    await handleMessage({ type: 'importTakeout', data: takeoutCsv([BEAST, LINUS_ID]) });
    installFetch({ failBrowse: { [BEAST]: '429', [LINUS_ID]: '429' } });
    const headerPush = await runSweep({ scope: 'all' });
    t.check('a 429 on a header read is pushback too', headerPush.error === 'slow down', JSON.stringify(headerPush));
    t.check('and the channels still count as filled in', (await readChannels()).every((ch) => ch.seeded === true));
    await writePollState({ backoffUntil: 0, backoffLevel: 0 });

    t.section('Takeout import during a running check seeds after');

    await waitForIdle();
    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true });
    let releaseTakeoutHang;
    const takeoutHang = new Promise((resolve) => { releaseTakeoutHang = resolve; });
    let takeoutInFeed = false;
    const takeoutQueueFetch = installFetch({
      async hook(u) {
        if (u.includes('/feeds/videos.xml')) {
          const id = decodeURIComponent((u.match(/channel_id=([^&]+)/) || [])[1] || '');
          if (id === MKBHD && !takeoutInFeed) {
            takeoutInFeed = true;
            await takeoutHang;
          }
        }
        return undefined;
      },
      feeds: {
        [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', []),
        [BEAST]: rssXml(BEAST, 'MrBeast', [{ v: 'tqbeast0001', t: 'Beast seed', at: AT.newest }]),
        [LINUS_ID]: rssXml(LINUS_ID, 'Linus', [{ v: 'tqlinus0001', t: 'Linus seed', at: AT.mid }]),
      },
    });
    const hungTakeoutSweep = runSweep({ scope: 'all' });
    for (let i = 0; i < 80 && !takeoutInFeed; i++) await wait(5);
    t.check('the running check reached the feed', takeoutInFeed === true);
    mock.notifications.length = 0;
    const takeoutWhileHung = await handleMessage({
      type: 'importTakeout',
      data: takeoutCsv([BEAST, LINUS_ID]),
    });
    t.check(
      'Takeout import stores the new channels while the check runs',
      takeoutWhileHung.ok === true && takeoutWhileHung.added === 2,
      JSON.stringify(takeoutWhileHung),
    );
    t.check(
      'and does not fetch them yet',
      !feedIdsOf(takeoutQueueFetch.calls).includes(BEAST)
        && !feedIdsOf(takeoutQueueFetch.calls).includes(LINUS_ID),
      JSON.stringify(feedIdsOf(takeoutQueueFetch.calls)),
    );
    const welcomeDuringHang = await handleMessage({ type: 'sweep', scope: 'all' });
    t.check(
      'the welcome sweep is already running',
      welcomeDuringHang.error === 'already running',
      JSON.stringify(welcomeDuringHang),
    );
    releaseTakeoutHang();
    await hungTakeoutSweep;
    t.check(
      'both imported ids seed after the check',
      await waitUntil(async () => {
        const list = await readChannels();
        return list.find((c) => c.id === BEAST)?.seeded === true
          && list.find((c) => c.id === LINUS_ID)?.seeded === true;
      }),
    );
    t.check(
      'one follow-up sweep fetched both new feeds',
      feedIdsOf(takeoutQueueFetch.calls).filter((id) => id === BEAST || id === LINUS_ID).length === 2,
      JSON.stringify(feedIdsOf(takeoutQueueFetch.calls)),
    );
    t.check(
      'queued Takeout seeds are silent',
      mock.notifications.length === 0
        && (await readFeed()).some((row) => row.v === 'tqbeast0001')
        && (await readFeed()).some((row) => row.v === 'tqlinus0001'),
      JSON.stringify(mock.notifications),
    );
    await waitForIdle();

    t.section('a welcome sweep after import is not followed by a second seed');

    await waitForIdle();
    await wipe();
    const welcomeFetch = installFetch({
      feeds: {
        [BEAST]: rssXml(BEAST, 'MrBeast', [{ v: 'welcomb0001', t: 'Beast', at: AT.newest }]),
        [LINUS_ID]: rssXml(LINUS_ID, 'Linus', [{ v: 'welcoml0001', t: 'Linus', at: AT.mid }]),
      },
    });
    await handleMessage({ type: 'importTakeout', data: takeoutCsv([BEAST, LINUS_ID]) });
    const welcomeSweep = await handleMessage({ type: 'sweep', scope: 'all' });
    t.check('the welcome sweep ran', welcomeSweep.ok === true, JSON.stringify(welcomeSweep));
    t.check(
      'both imported channels are seeded',
      (await readChannels()).every((ch) => ch.seeded === true),
    );
    await waitForIdle();
    t.check(
      'each imported channel is fetched once',
      feedIdsOf(welcomeFetch.calls).filter((id) => id === BEAST || id === LINUS_ID).length === 2,
      JSON.stringify(feedIdsOf(welcomeFetch.calls)),
    );

    t.section('adding channels read from a YouTube tab');

    await waitForIdle();
    await wipe();
    const shaped = await addImportedChannels([
      { id: BEAST, title: `  ${'B'.repeat(250)}  `, handle: 'not a handle' },
      { id: BEAST, title: 'Second', handle: '@MrBeast' },
      { id: 'nope', title: 'Ignored', handle: '@nope' },
    ]);
    t.check(
      'a new id is added once and a duplicate is skipped',
      shaped.ok === true && shaped.added === 1 && shaped.skipped === 1,
      JSON.stringify(shaped),
    );
    const shapedRow = (await readChannels())[0];
    t.check(
      'the title is trimmed and capped, a bad handle is blank, and it waits unseeded',
      shapedRow.title === 'B'.repeat(200)
        && shapedRow.handle === ''
        && shapedRow.avatar === ''
        && shapedRow.seeded === false
        && shapedRow.lastError === null
        && shapedRow.favorite === false,
      JSON.stringify(shapedRow),
    );
    const shapedAgain = await addImportedChannels([{ id: BEAST, title: 'New name', handle: '@MrBeast' }]);
    t.check(
      'an id already on the list is skipped and left as it was',
      shapedAgain.ok === true && shapedAgain.added === 0 && shapedAgain.skipped === 1
        && (await readChannels())[0].title === 'B'.repeat(200)
        && (await readChannels())[0].handle === '',
      JSON.stringify(shapedAgain),
    );

    const fullList = Array.from({ length: 2000 }, (_, i) => ({
      id: `UC${String(i).padStart(22, '0')}`,
      title: 'N',
      seeded: true,
    }));
    await globalThis.chrome.storage.local.set({ channels: fullList });
    const overCap = await addImportedChannels([{ id: BEAST, title: 'MrBeast', handle: '@MrBeast' }]);
    t.check(
      'a list that would pass 2,000 is refused',
      overCap.ok === false && overCap.error === 'count',
      JSON.stringify(overCap),
    );
    t.check('and adds none of it', (await readChannels()).length === 2000);
    await globalThis.chrome.storage.local.set({ channels: fullList.slice(0, 1999) });
    const atCap = await addImportedChannels([{ id: BEAST, title: 'MrBeast', handle: '@MrBeast' }]);
    t.check(
      '1,999 plus one is kept, handle and all',
      atCap.ok === true && atCap.added === 1 && (await readChannels()).length === 2000
        && (await readChannels()).find((ch) => ch.id === BEAST)?.handle === '@MrBeast'
        && (await readChannels()).find((ch) => ch.id === BEAST)?.seeded === false,
      JSON.stringify(atCap),
    );

    await waitForIdle();
    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', handle: '@mkbhd', seeded: true, favorite: true });
    installFetch({
      feeds: {
        [BEAST]: rssXml(BEAST, 'MrBeast', [{ v: 'scanbeast01', t: 'Beast', at: AT.newest }]),
      },
    });
    mock.urlTabs = [{ id: 8, windowId: 4, url: 'https://www.youtube.com/feed/channels' }];
    let accountAsks = 0;
    mock.onTabMessage = async (_tabId, message) => {
      if (message.type === 'subscriptions.accounts') {
        accountAsks += 1;
        if (accountAsks > 1) return { ok: false, error: 'done' };
        return { ok: true, index: 0, current: 0, avatar: '' };
      }
      if (message.type === 'subscriptions.scan') {
        return {
          ok: true,
          channels: [
            { id: MKBHD, title: 'Other', handle: '@other' },
            { id: BEAST, title: 'MrBeast', handle: '@MrBeast' },
            { id: 'nope', title: 'Ignored', handle: '@nope' },
          ],
        };
      }
      return { ok: true };
    };
    const createdBefore = mock.tabsCreated.length;
    const fromTab = await handleMessage({ type: 'importFromYouTube' });
    t.check(
      'the scan adds the new channel and counts the one already there',
      fromTab.ok === true && fromTab.added === 1 && fromTab.skipped === 1,
      JSON.stringify(fromTab),
    );
    t.check(
      'an open subscriptions tab is focused instead of another being opened',
      mock.tabsCreated.length === createdBefore
        && mock.tabsUpdated.some((row) => row.tabId === 8 && row.active === true)
        && mock.windowsUpdated.some((row) => row.windowId === 4 && row.focused === true),
      JSON.stringify({ created: mock.tabsCreated.length - createdBefore, updated: mock.tabsUpdated, windows: mock.windowsUpdated }),
    );
    const scannedBeast = (await readChannels()).find((ch) => ch.id === BEAST);
    const scannedMkbhd = (await readChannels()).find((ch) => ch.id === MKBHD);
    t.check(
      'the new channel keeps the handle from the page',
      scannedBeast?.handle === '@MrBeast' && scannedBeast?.title === 'MrBeast' && scannedBeast?.avatar === '',
      JSON.stringify(scannedBeast),
    );
    t.check(
      'the channel already on the list keeps its star and handle',
      scannedMkbhd?.favorite === true && scannedMkbhd?.handle === '@mkbhd',
      JSON.stringify(scannedMkbhd),
    );
    t.check(
      'the tab is told how many were added',
      mock.messagesSent.some((row) => row.tabId === 8
        && row.message?.type === 'subscriptions.result'
        && row.message.added === 1
        && row.message.skipped === 1
        && !row.message.error),
      JSON.stringify(mock.messagesSent.map((row) => row.message)),
    );
    t.check(
      'a check follows the import',
      await waitUntil(async () => (await readChannels()).find((ch) => ch.id === BEAST)?.seeded === true),
    );
    await waitForIdle();

    let otherAsks = 0;
    const updatesBefore = mock.tabsUpdated.length;
    mock.onTabMessage = async (_tabId, message) => {
      if (message.type === 'subscriptions.accounts') {
        otherAsks += 1;
        if (otherAsks > 1) return { ok: false, error: 'done' };
        return { ok: true, index: 1, current: 0, avatar: 'https://yt3.ggpht.com/pic' };
      }
      if (message.type === 'subscriptions.scan') return { ok: true, channels: [] };
      if (message.type === 'subscriptions.choose') return { ok: true, mode: 'merge' };
      return { ok: true };
    };
    const otherAccount = await handleMessage({ type: 'importFromYouTube' });
    t.check(
      'a different account is opened before the scan',
      otherAccount.ok === true
        && mock.tabsUpdated.slice(updatesBefore).some((row) => row.url === 'https://www.youtube.com/feed/channels?authuser=1'),
      JSON.stringify(mock.tabsUpdated.slice(updatesBefore)),
    );
    t.check(
      'the result names that account',
      mock.messagesSent.some((row) => row.message?.type === 'subscriptions.result'
        && row.message.account === 1
        && row.message.avatar === 'https://yt3.ggpht.com/pic'
        && !row.message.error),
      JSON.stringify(mock.messagesSent.map((row) => row.message)),
    );
    await waitForIdle();

    let sameAsks = 0;
    const sameBefore = mock.tabsUpdated.length;
    mock.onTabMessage = async (_tabId, message) => {
      if (message.type === 'subscriptions.accounts') {
        sameAsks += 1;
        if (sameAsks > 1) return { ok: false, error: 'done' };
        return { ok: true, index: 0, current: 0 };
      }
      if (message.type === 'subscriptions.scan') return { ok: true, channels: [] };
      if (message.type === 'subscriptions.choose') return { ok: true, mode: 'merge' };
      return { ok: true };
    };
    const sameAccount = await handleMessage({ type: 'importFromYouTube' });
    t.check(
      'the account already open is not navigated',
      sameAccount.ok === true
        && !mock.tabsUpdated.slice(sameBefore).some((row) => row.url && String(row.url).includes('authuser=')),
      JSON.stringify(mock.tabsUpdated.slice(sameBefore)),
    );
    await waitForIdle();

    mock.onTabMessage = async (_tabId, message) => {
      if (message.type === 'subscriptions.accounts') return { ok: true, index: 10, current: 0 };
      return { ok: true };
    };
    const badAccount = await handleMessage({ type: 'importFromYouTube' });
    t.check(
      'an account number past 9 is refused',
      badAccount.ok === false && badAccount.error === 'failed',
      JSON.stringify(badAccount),
    );

    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const pickTimers = [];
    globalThis.setTimeout = (fn, ms) => {
      if (ms === 4 * 60 * 1000) {
        pickTimers.push(fn);
        return { pick: pickTimers.length };
      }
      return realSetTimeout(fn, ms);
    };
    globalThis.clearTimeout = (id) => {
      if (id && id.pick) return;
      return realClearTimeout(id);
    };
    mock.onTabMessage = () => new Promise(() => {});
    const silentMessages = mock.messagesSent.length;
    const silentImport = handleMessage({ type: 'importFromYouTube' });
    try {
      for (let i = 0; i < 30 && pickTimers.length === 0; i++) await Promise.resolve();
      t.check('a silent tab schedules the account cap', pickTimers.length === 1, String(pickTimers.length));
      pickTimers[0]();
      const silent = await silentImport;
      t.check(
        'the account wait ends at the cap without telling the tab',
        silent.ok === false && silent.error === 'timeout'
          && !mock.messagesSent.slice(silentMessages).some((row) => row.message?.type === 'subscriptions.result'),
        JSON.stringify(silent),
      );
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }

    mock.onTabMessage = async () => ({ ok: false, error: 'signedOut' });
    const beforeFailedScan = (await readChannels()).length;
    const failedScan = await handleMessage({ type: 'importFromYouTube' });
    t.check(
      'a failed scan adds nothing and the overlay hears why',
      failedScan.ok === false && failedScan.error === 'signedOut'
        && (await readChannels()).length === beforeFailedScan
        && mock.messagesSent.some((row) => row.message?.type === 'subscriptions.result' && row.message.error === 'signedOut'),
      JSON.stringify(failedScan),
    );

    mock.urlTabs = [];
    let openAsks = 0;
    mock.onTabMessage = async (_tabId, message) => {
      if (message.type === 'subscriptions.accounts') {
        openAsks += 1;
        if (openAsks > 1) return { ok: false, error: 'done' };
        return { ok: true, index: 0, current: 0 };
      }
      if (message.type === 'subscriptions.choose') return { ok: true, mode: 'merge' };
      return { ok: true, channels: [] };
    };
    const openedScan = await handleMessage({ type: 'importFromYouTube' });
    const openedTab = mock.tabsCreated[mock.tabsCreated.length - 1];
    t.check(
      'with no subscriptions tab open, one is created in front',
      openedScan.ok === true && openedScan.added === 0
        && openedTab?.url === 'https://www.youtube.com/feed/channels'
        && openedTab?.active === true,
      JSON.stringify({ openedScan, openedTab }),
    );
    await waitForIdle();
    mock.urlTabs = null;
    mock.onTabMessage = null;

    t.section('import asks when the lists differ');

    const keptRecord = {
      id: MKBHD,
      title: 'Marques Brownlee',
      handle: '@mkbhd',
      avatar: 'https://yt3.ggpht.com/a',
      favorite: true,
      muted: true,
      groups: ['Tech'],
      addedAt: 50,
      lastFetchAt: 60,
      lastVideoAt: 70,
      lastError: null,
      seeded: true,
    };
    const extraRecord = {
      id: BEAST,
      title: 'MrBeast',
      handle: '@MrBeast',
      avatar: '',
      favorite: false,
      muted: false,
      addedAt: 11,
      lastFetchAt: 12,
      lastVideoAt: 13,
      lastError: null,
      seeded: true,
    };
    const keptRow = { v: 'keepvid0001', c: MKBHD, t: 'Keep', at: 10 };
    const extraRow = { v: 'dropvid0001', c: BEAST, t: 'Drop', at: 11 };
    const plan = planImportedReplace(
      [extraRecord, keptRecord],
      [extraRow, keptRow],
      [
        { id: LINUS, title: '  Linus  ', handle: '@Linus' },
        { id: MKBHD, title: 'Other name', handle: '@other' },
        { id: MKBHD, title: 'Again', handle: '@again' },
        { id: 'nope', title: 'Ignored' },
      ],
      1234,
    );
    const plannedKept = plan.channels.find((ch) => ch.id === MKBHD);
    const plannedFresh = plan.channels.find((ch) => ch.id === LINUS);
    t.check(
      'replace keeps a shared channel untouched, in its old place',
      plan.ok === true
        && plan.channels[0] === keptRecord
        && plannedKept.favorite === true
        && plannedKept.muted === true
        && plannedKept.groups === keptRecord.groups
        && plannedKept.seeded === true
        && plannedKept.title === 'Marques Brownlee'
        && plannedKept.handle === '@mkbhd'
        && plannedKept.addedAt === 50
        && plannedKept.lastVideoAt === 70,
      JSON.stringify(plannedKept),
    );
    t.check(
      'replace drops extras and their feed rows, and appends fresh unseeded',
      plan.removed === 1
        && plan.added === 1
        && !plan.channels.some((ch) => ch.id === BEAST)
        && plan.feed.length === 1
        && plan.feed[0] === keptRow
        && plannedFresh.seeded === false
        && plannedFresh.favorite === false
        && plannedFresh.muted === false
        && plannedFresh.handle === '@Linus'
        && plannedFresh.title === 'Linus'
        && plannedFresh.avatar === ''
        && plannedFresh.addedAt === 1234
        && plan.channels[plan.channels.length - 1] === plannedFresh,
      JSON.stringify({ added: plan.added, removed: plan.removed, fresh: plannedFresh, feed: plan.feed }),
    );
    const sameChannels = [keptRecord];
    const sameFeed = [keptRow];
    const emptyPlan = planImportedReplace(sameChannels, sameFeed, []);
    const junkPlan = planImportedReplace(sameChannels, sameFeed, [{ id: 'nope' }]);
    t.check(
      'an empty scan is refused and the lists are not rebuilt',
      emptyPlan.ok === false && emptyPlan.error === 'empty'
        && emptyPlan.channels === sameChannels && emptyPlan.feed === sameFeed
        && junkPlan.ok === false && junkPlan.error === 'empty',
      JSON.stringify({ empty: emptyPlan.error, junk: junkPlan.error }),
    );
    const tooMany = Array.from({ length: 2001 }, (_, i) => ({ id: `UC${String(i).padStart(22, '0')}` }));
    const overPlan = planImportedReplace([keptRecord], [keptRow], tooMany, 1);
    const capPlan = planImportedReplace([], [], tooMany.slice(0, 2000), 1);
    t.check(
      'replace refuses a result past 2,000 and keeps 2,000',
      overPlan.ok === false && overPlan.error === 'count'
        && overPlan.channels.length === 1
        && capPlan.ok === true && capPlan.channels.length === 2000 && capPlan.added === 2000,
      JSON.stringify({ over: overPlan.error, cap: capPlan.channels.length }),
    );

    function scriptedScan(onMessage) {
      let accounts = 0;
      const seen = [];
      mock.urlTabs = [{ id: 8, windowId: 4, url: 'https://www.youtube.com/feed/channels' }];
      mock.onTabMessage = async (_tabId, message) => {
        seen.push(message);
        if (message.type === 'subscriptions.accounts') {
          accounts += 1;
          if (accounts > 1) return { ok: false, error: 'done' };
          return { ok: true, index: 0, current: 0, avatar: 'https://yt3.ggpht.com/pic' };
        }
        if (message.type === 'subscriptions.download') return { ok: true };
        return onMessage(message, seen);
      };
      return seen;
    }

    await waitForIdle();
    await wipe();
    installFetch();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', handle: '@mkbhd', favorite: true, seeded: true, groups: ['Tech'] });
    const noExtraSeen = scriptedScan(async (message) => {
      if (message.type === 'subscriptions.scan') {
        return {
          ok: true,
          channels: [
            { id: MKBHD, title: 'Other', handle: '@other' },
            { id: LINUS, title: 'Linus', handle: '@Linus' },
          ],
        };
      }
      return { ok: true };
    });
    const noExtra = await handleMessage({ type: 'importFromYouTube' });
    t.check(
      'no extras adds the new channel and does not ask',
      noExtra.ok === true && noExtra.added === 1 && noExtra.removed === 0
        && !noExtraSeen.some((message) => message.type === 'subscriptions.choose'),
      JSON.stringify({ noExtra, types: noExtraSeen.map((message) => message.type) }),
    );
    await waitForIdle();

    await wipe();
    installFetch();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', handle: '@mkbhd', favorite: true, seeded: true, groups: ['Tech'] });
    await putChannel({ id: BEAST, title: 'MrBeast', handle: '@MrBeast', seeded: true });
    await handleMessage({ type: 'setMuted', id: MKBHD, on: true });
    await saveFeed([
      { v: 'keepvid0001', c: MKBHD, t: 'Keep', at: 10 },
      { v: 'dropvid0001', c: BEAST, t: 'Drop', at: 11 },
    ]);
    await writePollState({ notified: ['keepvid0001'] });
    const mergeSeen = scriptedScan(async (message) => {
      if (message.type === 'subscriptions.scan') {
        return { ok: true, channels: [{ id: LINUS, title: 'Linus', handle: '@Linus' }] };
      }
      if (message.type === 'subscriptions.choose') return { ok: true, mode: 'merge' };
      return { ok: true };
    });
    const mergedImport = await handleMessage({ type: 'importFromYouTube' });
    const mergedIds = (await readChannels()).map((ch) => ch.id);
    t.check(
      'merge adds the new channel and removes nothing',
      mergedImport.ok === true && mergedImport.added === 1 && mergedImport.removed === 0
        && mergedIds.includes(MKBHD) && mergedIds.includes(BEAST) && mergedIds.includes(LINUS)
        && mergeSeen.some((message) => message.type === 'subscriptions.choose' && message.extra === 2 && message.fresh === 1)
        && (await readFeed()).some((row) => row.c === BEAST),
      JSON.stringify({ mergedImport, mergedIds }),
    );
    await waitForIdle();

    await wipe();
    installFetch();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', handle: '@mkbhd', favorite: true, seeded: true, groups: ['Tech'] });
    await putChannel({ id: BEAST, title: 'MrBeast', handle: '@MrBeast', seeded: true });
    await handleMessage({ type: 'setMuted', id: MKBHD, on: true });
    await saveFeed([
      { v: 'keepvid0001', c: MKBHD, t: 'Keep', at: 10 },
      { v: 'dropvid0001', c: BEAST, t: 'Drop', at: 11 },
    ]);
    await writePollState({ notified: ['keepvid0001'] });
    let stillThere = null;
    const replaceSeen = scriptedScan(async (message) => {
      if (message.type === 'subscriptions.scan') {
        return {
          ok: true,
          channels: [
            { id: MKBHD, title: 'Other', handle: '@other' },
            { id: LINUS, title: 'Linus', handle: '@Linus' },
          ],
        };
      }
      if (message.type === 'subscriptions.choose') {
        if (!message.exported) return { ok: true, mode: 'export' };
        stillThere = (await readChannels()).map((ch) => ch.id);
        return { ok: true, mode: 'replace' };
      }
      return { ok: true };
    });
    const replaced = await handleMessage({ type: 'importFromYouTube' });
    const replacedList = await readChannels();
    const replacedKept = replacedList.find((ch) => ch.id === MKBHD);
    const replacedFresh = replacedList.find((ch) => ch.id === LINUS);
    const download = replaceSeen.find((message) => message.type === 'subscriptions.download');
    const parsedBackup = download ? parseBackup(download.text) : { ok: false };
    const secondChoose = replaceSeen.filter((message) => message.type === 'subscriptions.choose')[1];
    t.check(
      'export downloads a backup of the current list, then asks again',
      !!download
        && /^youtube-companion-\d{4}-\d{2}-\d{2}\.json$/.test(download.name)
        && download.text === JSON.stringify(JSON.parse(download.text), null, 2)
        && parsedBackup.ok === true
        && parsedBackup.data.channels.map((ch) => ch.id).join() === [MKBHD, BEAST].join()
        && secondChoose?.exported === true
        && stillThere.includes(BEAST)
        && !replaceSeen.some((message) => message.type === 'subscriptions.choose' && message.text),
      JSON.stringify({
        name: download && download.name,
        ids: parsedBackup.ok ? parsedBackup.data.channels.map((ch) => ch.id) : parsedBackup.error,
        exported: secondChoose?.exported,
        stillThere,
      }),
    );
    t.check(
      'replace then removes the extra channel and its videos',
      replaced.ok === true && replaced.removed === 1 && replaced.added === 1
        && !replacedList.some((ch) => ch.id === BEAST)
        && replacedKept?.favorite === true
        && replacedKept?.muted === true
        && replacedKept?.groups?.join() === 'Tech'
        && replacedFresh?.handle === '@Linus'
        && !(await readFeed()).some((row) => row.c === BEAST)
        && (await readFeed()).some((row) => row.v === 'keepvid0001')
        && (await readPollState()).notified.includes('keepvid0001')
        && replaceSeen.some((message) => message.type === 'subscriptions.result' && message.removed === 1 && message.added === 1),
      JSON.stringify({
        replaced,
        ids: replacedList.map((ch) => ch.id),
        kept: replacedKept,
        fresh: replacedFresh,
      }),
    );
    await waitForIdle();

    await wipe();
    installFetch();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true });
    await putChannel({ id: BEAST, title: 'MrBeast', seeded: true });
    const beforeDone = (await readChannels()).map((ch) => ch.id).join();
    const doneSeen = scriptedScan(async (message) => {
      if (message.type === 'subscriptions.scan') return { ok: true, channels: [{ id: LINUS, title: 'Linus' }] };
      if (message.type === 'subscriptions.choose') return { ok: false, error: 'done' };
      return { ok: true };
    });
    const doneImport = await handleMessage({ type: 'importFromYouTube' });
    t.check(
      'done changes nothing',
      doneImport.ok === false && doneImport.error === 'done'
        && (await readChannels()).map((ch) => ch.id).join() === beforeDone
        && !doneSeen.some((message) => message.type === 'subscriptions.result'),
      JSON.stringify(doneImport),
    );

    const emptySeen = scriptedScan(async (message) => {
      if (message.type === 'subscriptions.scan') return { ok: true, channels: [] };
      if (message.type === 'subscriptions.choose') return { ok: true, mode: 'replace' };
      return { ok: true };
    });
    const emptyImport = await handleMessage({ type: 'importFromYouTube' });
    t.check(
      'replace of an empty scan changes nothing',
      emptyImport.ok === false && emptyImport.error === 'empty'
        && (await readChannels()).map((ch) => ch.id).join() === beforeDone
        && emptySeen.some((message) => message.type === 'subscriptions.result' && message.error === 'empty'),
      JSON.stringify(emptyImport),
    );

    await wipe();
    installFetch();
    await putChannel({ id: MKBHD, title: 'x'.repeat(MAX_BACKUP_BYTES), seeded: true });
    await putChannel({ id: BEAST, title: 'MrBeast', seeded: true });
    let sawExportError = false;
    const hugeSeen = scriptedScan(async (message) => {
      if (message.type === 'subscriptions.scan') return { ok: true, channels: [{ id: LINUS, title: 'Linus' }] };
      if (message.type === 'subscriptions.choose') {
        if (message.exportError === true) {
          sawExportError = true;
          return { ok: false, error: 'done' };
        }
        return { ok: true, mode: 'export' };
      }
      return { ok: true };
    });
    const hugeImport = await handleMessage({ type: 'importFromYouTube' });
    t.check(
      'a backup past the size cap is not sent',
      hugeImport.ok === false && hugeImport.error === 'done'
        && sawExportError === true
        && !hugeSeen.some((message) => message.type === 'subscriptions.download')
        && (await readChannels()).length === 2,
      JSON.stringify({ hugeImport, sawExportError }),
    );

    await wipe();
    installFetch();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true });
    await putChannel({ id: BEAST, title: 'MrBeast', seeded: true });
    let exportRounds = 0;
    const capSeen = scriptedScan(async (message) => {
      if (message.type === 'subscriptions.scan') return { ok: true, channels: [{ id: LINUS, title: 'Linus' }] };
      if (message.type === 'subscriptions.choose') {
        exportRounds += 1;
        return { ok: true, mode: 'export' };
      }
      return { ok: true };
    });
    const capImport = await handleMessage({ type: 'importFromYouTube' });
    t.check(
      'export stops after five backups and deletes nothing',
      capImport.ok === false
        && capSeen.filter((message) => message.type === 'subscriptions.download').length === 5
        && exportRounds === 6
        && (await readChannels()).map((ch) => ch.id).join() === [MKBHD, BEAST].join(),
      JSON.stringify({
        capImport,
        downloads: capSeen.filter((message) => message.type === 'subscriptions.download').length,
        exportRounds,
      }),
    );

    await waitForIdle();
    mock.urlTabs = null;
    mock.onTabMessage = null;

    t.section('backup restore alerts for uploads newer than lastVideoAt');

    async function restoreBackupAndCheck(mode) {
      await waitForIdle();
      await wipe();
      const lastVideoAt = daysAgo(30);
      installFetch({
        feeds: {
          [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', [
            { v: `bk${mode}new01`, t: 'After backup', at: hoursAgo(1) },
            { v: `bk${mode}old01`, t: 'Before backup', at: lastVideoAt - 60_000 },
          ]),
        },
      });
      mock.notifications.length = 0;
      const imported = await handleMessage({
        type: 'importBackup',
        mode,
        data: backupJson([{ id: MKBHD, title: 'Marques Brownlee', lastVideoAt }]),
      });
      const replyCh = (imported.state?.channels || []).find((c) => c.id === MKBHD);
      t.check(
        `${mode} restore stored lastVideoAt and left the channel unseeded`,
        imported.ok === true
          && imported.added === 1
          && replyCh?.seeded === false
          && replyCh?.lastVideoAt === lastVideoAt,
        JSON.stringify({ ok: imported.ok, added: imported.added, ch: replyCh }),
      );
      t.check(
        `${mode} restore seeds without another message`,
        await waitUntil(async () => (await readChannels())[0]?.seeded === true),
      );
      await waitForIdle();
      return {
        notes: mock.notifications.slice(),
        feed: await readFeed(),
        channel: (await readChannels())[0],
      };
    }

    const mergedRestore = await restoreBackupAndCheck('merge');
    t.check(
      'merge restore alerts exactly once',
      mergedRestore.notes.length === 1 && mergedRestore.notes[0].message === 'After backup',
      JSON.stringify(mergedRestore.notes),
    );
    t.check(
      'merge restore kept both videos',
      mergedRestore.feed.some((row) => row.v === 'bkmergenew01')
        && mergedRestore.feed.some((row) => row.v === 'bkmergeold01'),
      JSON.stringify(mergedRestore.feed.map((row) => row.v)),
    );
    t.check('merge restore seeds the channel', mergedRestore.channel?.seeded === true);

    const replacedRestore = await restoreBackupAndCheck('replace');
    t.check(
      'replace restore alerts exactly once',
      replacedRestore.notes.length === 1 && replacedRestore.notes[0].message === 'After backup',
      JSON.stringify(replacedRestore.notes),
    );
    t.check(
      'replace restore kept both videos',
      replacedRestore.feed.some((row) => row.v === 'bkreplacenew01')
        && replacedRestore.feed.some((row) => row.v === 'bkreplaceold01'),
      JSON.stringify(replacedRestore.feed.map((row) => row.v)),
    );

    t.section('an old backup does not alert for uploads from days ago');

    await waitForIdle();
    await wipe();
    const oldBackupAt = daysAgo(30);
    installFetch({
      feeds: {
        [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', [
          { v: 'bkhour00001', t: 'An hour ago', at: hoursAgo(1) },
          { v: 'bkdays00001', t: 'Three days ago', at: daysAgo(3) },
        ]),
      },
    });
    mock.notifications.length = 0;
    const oldBackup = await handleMessage({
      type: 'importBackup',
      mode: 'replace',
      data: backupJson([{
        id: MKBHD,
        title: 'Marques Brownlee',
        lastVideoAt: oldBackupAt,
        addedAt: 1,
      }]),
    });
    t.check(
      'listing time is the import, not the file',
      oldBackup.state?.channels?.[0]?.addedAt > oldBackupAt
        && oldBackup.state?.channels?.[0]?.addedAt !== 1,
      String(oldBackup.state?.channels?.[0]?.addedAt),
    );
    t.check(
      'an old backup seeds without another message',
      await waitUntil(async () => (await readChannels())[0]?.seeded === true),
    );
    await waitForIdle();
    t.check(
      'an upload from 3 days ago after lastVideoAt stays silent',
      (await readFeed()).some((row) => row.v === 'bkdays00001')
        && !mock.notifications.some((n) => n.message === 'Three days ago'),
      JSON.stringify({
        feed: (await readFeed()).map((row) => row.v),
        notes: mock.notifications,
      }),
    );
    t.check(
      'an upload from 1 hour ago alerts once',
      mock.notifications.length === 1 && mock.notifications[0].message === 'An hour ago',
      JSON.stringify(mock.notifications),
    );

    t.section('backup restore with no lastVideoAt stays fully silent');

    await waitForIdle();
    await wipe();
    installFetch({
      feeds: {
        [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', [
          { v: 'bkzero00001', t: 'New', at: hoursAgo(1) },
          { v: 'bkzero00002', t: 'Old', at: daysAgo(3) },
        ]),
      },
    });
    mock.notifications.length = 0;
    await handleMessage({
      type: 'importBackup',
      mode: 'replace',
      data: backupJson([{ id: MKBHD, title: 'Marques Brownlee', lastVideoAt: 0 }]),
    });
    t.check(
      'a backup with no lastVideoAt seeds without another message',
      await waitUntil(async () => (await readChannels())[0]?.seeded === true),
    );
    await waitForIdle();
    t.check(
      'a backup with no lastVideoAt silent-seeds the first check',
      mock.notifications.length === 0 && (await readFeed()).length === 2,
      JSON.stringify(mock.notifications),
    );
    t.check('and then counts as seeded', (await readChannels())[0]?.seeded === true);

    t.section('backup merge keeps a live channel\'s own state');

    await waitForIdle();
    await wipe();
    await putChannel({ id: MKBHD, title: 'Live title', seeded: true, lastVideoAt: AT.older });
    const liveAddedAt = (await readChannels())[0].addedAt;
    installFetch({
      feeds: {
        [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', [
          { v: 'bklive00001', t: 'Would be quiet if the file won', at: AT.mid },
        ]),
        [BEAST]: rssXml(BEAST, 'MrBeast', [
          { v: 'bknewc00001', t: 'After backup', at: hoursAgo(1) },
          { v: 'bknewc00002', t: 'Before backup', at: AT.older },
        ]),
      },
    });
    mock.notifications.length = 0;
    await handleMessage({
      type: 'importBackup',
      mode: 'merge',
      data: backupJson([
        { id: MKBHD, title: 'File title', lastVideoAt: AT.newest },
        { id: BEAST, title: 'MrBeast', lastVideoAt: AT.mid },
      ]),
    });
    const afterMerge = await readChannels();
    const liveKept = afterMerge.find((c) => c.id === MKBHD);
    t.check(
      'the live channel keeps its stamps',
      liveKept?.title === 'Live title'
        && liveKept?.seeded === true
        && liveKept?.lastVideoAt === AT.older
        && liveKept?.addedAt === liveAddedAt,
      JSON.stringify(liveKept),
    );
    t.check('the new channel is on the list', afterMerge.some((c) => c.id === BEAST));
    t.check(
      'the newly merged channel seeds without another message',
      await waitUntil(async () => (await readChannels()).find((c) => c.id === BEAST)?.seeded === true),
    );
    await runSweep({ scope: 'all' });
    await waitForIdle();
    t.check(
      'the live channel still alerts from its own lastVideoAt',
      mock.notifications.some((n) => n.message === 'Would be quiet if the file won'),
      JSON.stringify(mock.notifications),
    );
    t.check(
      'the newly merged channel alerts only for the newer upload',
      mock.notifications.filter((n) => n.message === 'After backup').length === 1
        && !mock.notifications.some((n) => n.message === 'Before backup'),
      JSON.stringify(mock.notifications),
    );

    t.section('backup import during a running check seeds after');

    await waitForIdle();
    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true });
    let releaseBackupHang;
    const backupHang = new Promise((resolve) => { releaseBackupHang = resolve; });
    let backupInFeed = false;
    const backupQueueFetch = installFetch({
      async hook(u) {
        if (u.includes('/feeds/videos.xml')) {
          const id = decodeURIComponent((u.match(/channel_id=([^&]+)/) || [])[1] || '');
          if (id === MKBHD && !backupInFeed) {
            backupInFeed = true;
            await backupHang;
          }
        }
        return undefined;
      },
      feeds: {
        [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', []),
        [BEAST]: rssXml(BEAST, 'MrBeast', [
          { v: 'bkwait00001', t: 'After backup', at: hoursAgo(1) },
          { v: 'bkwait00002', t: 'Before backup', at: daysAgo(40) },
        ]),
      },
    });
    const hungBackupSweep = runSweep({ scope: 'all' });
    for (let i = 0; i < 80 && !backupInFeed; i++) await wait(5);
    t.check('the running check reached the feed', backupInFeed === true);
    mock.notifications.length = 0;
    const backupWhileHung = await handleMessage({
      type: 'importBackup',
      mode: 'merge',
      data: backupJson([{ id: BEAST, title: 'MrBeast', lastVideoAt: daysAgo(30) }]),
    });
    t.check(
      'backup merge stores the new channel while the check runs',
      backupWhileHung.ok === true && backupWhileHung.added === 1,
      JSON.stringify(backupWhileHung),
    );
    t.check(
      'and does not fetch it yet',
      !feedIdsOf(backupQueueFetch.calls).includes(BEAST),
      JSON.stringify(feedIdsOf(backupQueueFetch.calls)),
    );
    releaseBackupHang();
    await hungBackupSweep;
    t.check(
      'the new backup channel seeds after the check',
      await waitUntil(async () => (await readChannels()).find((c) => c.id === BEAST)?.seeded === true),
    );
    t.check(
      'and alerts only for the upload newer than lastVideoAt',
      mock.notifications.length === 1 && mock.notifications[0].message === 'After backup',
      JSON.stringify(mock.notifications),
    );
    await waitForIdle();

    t.section('clearing the watchlist');

    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true, favorite: true });
    await putChannel({ id: BEAST, title: 'MrBeast', seeded: true });
    installFetch({
      feeds: {
        [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', [{ v: 'clearmkb001', at: AT.newest }]),
        [BEAST]: rssXml(BEAST, 'MrBeast', [{ v: 'clearbst001', at: AT.mid }]),
      },
    });
    await runSweep({ scope: 'all' });
    await writePollState({ lastSeenAt: 0 });
    await handleMessage({ type: 'removeChannel', id: BEAST });
    await putChannel({ id: BEAST, title: 'MrBeast', seeded: true });
    const notifiedBeforeClear = (await readPollState()).notified;
    await saveVideoMeta({ clearmkb001: { k: 'video', d: 60, st: 0, at: AT.newest } });
    t.check('the list has channels and videos to clear', (await readFeed()).length === 1 && mock.session.lastRemovedChannel?.channel?.id === BEAST);
    const clearReply = await handleMessage({ type: 'clearChannels' });
    t.check('clearChannels reports how many channels it removed', clearReply.ok === true && clearReply.removed === 2, JSON.stringify(clearReply));
    t.check('the list is empty', (await readChannels()).length === 0);
    t.check('the feed is empty', (await readFeed()).length === 0);
    t.check('stored video details are dropped', JSON.stringify(await readVideoMeta()) === '{}', JSON.stringify(await readVideoMeta()));
    t.check('the reply carries the empty list for the popup', clearReply.state?.channels?.length === 0 && clearReply.state?.feed?.length === 0);
    t.check('the badge is cleared', mock.badgeText === '', mock.badgeText);
    t.check('an Undo for an earlier removal is dropped', !('lastRemovedChannel' in mock.session));
    t.check(
      'alert history stays, so channels added back never alert twice',
      JSON.stringify((await readPollState()).notified) === JSON.stringify(notifiedBeforeClear),
    );
    const clearedAgain = await handleMessage({ type: 'clearChannels' });
    t.check('clearing an empty list is fine', clearedAgain.ok === true && clearedAgain.removed === 0, JSON.stringify(clearedAgain));

    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true });
    let clearedMidCheck = false;
    installFetch({
      feeds: { [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', [{ v: 'midclear001', at: AT.newest }]) },
      hook: async (url) => {
        if (clearedMidCheck || !url.includes('/youtubei/v1/player')) return undefined;
        clearedMidCheck = true;
        await handleMessage({ type: 'clearChannels' });
        return undefined;
      },
    });
    await runSweep({ scope: 'all' });
    t.check('a list cleared while a check runs', clearedMidCheck);
    t.check('does not get its videos back when the check ends', (await readFeed()).length === 0, JSON.stringify(await readFeed()));
    t.check('or its channels', (await readChannels()).length === 0);
    t.check('or an alert', mock.notifications.length === 0, JSON.stringify(mock.notifications));

    t.section('clear after the listed snapshot does not restore videos');

    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true, lastVideoAt: AT.older });
    let metaWritten = false;
    let feedReadsAfterMeta = 0;
    let clearedAfterSnapshot = false;
    const origGet = globalThis.chrome.storage.local.get.bind(globalThis.chrome.storage.local);
    const origSet = globalThis.chrome.storage.local.set.bind(globalThis.chrome.storage.local);
    globalThis.chrome.storage.local.set = async (items) => {
      if (items && Object.prototype.hasOwnProperty.call(items, 'videoMeta')) metaWritten = true;
      return origSet(items);
    };
    globalThis.chrome.storage.local.get = async (keys) => {
      const names = keyNames(keys);
      if (metaWritten && names.includes('feed')) {
        feedReadsAfterMeta++;
        if (feedReadsAfterMeta >= 2 && !clearedAfterSnapshot) {
          clearedAfterSnapshot = true;
          await handleMessage({ type: 'clearChannels' });
        }
      }
      return origGet(keys);
    };
    installFetch({
      feeds: { [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', [{ v: 'aftersnap01', t: 'After snapshot', at: AT.newest }]) },
    });
    try {
      await runSweep({ scope: 'all' });
    } finally {
      globalThis.chrome.storage.local.get = origGet;
      globalThis.chrome.storage.local.set = origSet;
    }
    t.check('the list was cleared after classification', clearedAfterSnapshot);
    t.check(
      'videos written after that snapshot do not come back',
      (await readFeed()).length === 0,
      JSON.stringify(await readFeed()),
    );
    t.check('the channel list stays empty', (await readChannels()).length === 0);
    t.check('and no alert fires', mock.notifications.length === 0, JSON.stringify(mock.notifications));

    t.section('clear then re-add during a check is a new listing');

    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true, lastVideoAt: AT.older });
    const addedAtBefore = (await readChannels())[0].addedAt;
    metaWritten = false;
    feedReadsAfterMeta = 0;
    let relisted = false;
    globalThis.chrome.storage.local.set = async (items) => {
      if (items && Object.prototype.hasOwnProperty.call(items, 'videoMeta')) metaWritten = true;
      return origSet(items);
    };
    globalThis.chrome.storage.local.get = async (keys) => {
      const names = keyNames(keys);
      if (metaWritten && names.includes('feed')) {
        feedReadsAfterMeta++;
        if (feedReadsAfterMeta >= 2 && !relisted) {
          relisted = true;
          await handleMessage({ type: 'clearChannels' });
          await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: false });
        }
      }
      return origGet(keys);
    };
    installFetch({
      feeds: { [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', [{ v: 'readdvid001', t: 'Should stay quiet', at: AT.newest }]) },
    });
    mock.notifications.length = 0;
    try {
      await runSweep({ scope: 'all' });
    } finally {
      globalThis.chrome.storage.local.get = origGet;
      globalThis.chrome.storage.local.set = origSet;
    }
    const afterRelist = (await readChannels()).find((c) => c.id === MKBHD);
    t.check('the same id was added back during the check', relisted && !!afterRelist);
    t.check(
      'the new listing has a new addedAt',
      Number(afterRelist?.addedAt) > Number(addedAtBefore),
      String(afterRelist?.addedAt),
    );
    t.check(
      'this check does not write rows for the new listing',
      !(await readFeed()).some((row) => row.v === 'readdvid001'),
      JSON.stringify(await readFeed()),
    );
    t.check(
      'and does not stamp lastVideoAt or seeded',
      afterRelist?.seeded === false && !(afterRelist?.lastVideoAt > 0),
      JSON.stringify(afterRelist),
    );
    t.check('and does not alert', mock.notifications.length === 0, JSON.stringify(mock.notifications));

    t.section('clear during notify does not fire an alert');

    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true, lastVideoAt: AT.older });
    let feedWritten = false;
    let clearedAtNotify = false;
    globalThis.chrome.storage.local.set = async (items) => {
      if (items && Object.prototype.hasOwnProperty.call(items, 'feed')) feedWritten = true;
      return origSet(items);
    };
    globalThis.chrome.storage.local.get = async (keys) => {
      const names = keyNames(keys);
      if (feedWritten && names.includes('pollState') && !clearedAtNotify) {
        clearedAtNotify = true;
        await handleMessage({ type: 'clearChannels' });
      }
      return origGet(keys);
    };
    installFetch({
      feeds: { [MKBHD]: rssXml(MKBHD, 'Marques Brownlee', [{ v: 'notifysnap1', t: 'Would alert', at: AT.newest }]) },
    });
    try {
      await runSweep({ scope: 'all' });
    } finally {
      globalThis.chrome.storage.local.get = origGet;
      globalThis.chrome.storage.local.set = origSet;
    }
    t.check('the list was cleared at notify time', clearedAtNotify);
    t.check('the feed stays empty', (await readFeed()).length === 0, JSON.stringify(await readFeed()));
    t.check('no desktop alert', mock.notifications.length === 0, JSON.stringify(mock.notifications));

    t.section('only videos that can stay in the feed are looked up');

    await wipe();
    await writeSettings({ feed: { maxItems: 50 } });
    await putChannel({ id: BEAST, title: 'MrBeast', seeded: true, lastVideoAt: AT.newest });
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true });
    const beastRows = Array.from({ length: 50 }, (_, i) => ({
      v: `beastfull${String(i).padStart(2, '0')}`, c: BEAST, t: 'Beast', at: AT.newest - i * 1000, d: 600, vw: 1, k: 'video', st: 0,
    }));
    await saveFeed(beastRows);
    await saveVideoMeta(Object.fromEntries(beastRows.map((row) => [row.v, { k: 'video', d: 600, st: 0, at: row.at }])));
    const oldUploads = Array.from({ length: 15 }, (_, i) => ({ v: `mkbhdold${String(i).padStart(3, '0')}`, t: `Old ${i}`, at: AT.older - i * 60_000 }));
    const floorFeed = rssXml(MKBHD, 'Marques Brownlee', [{ v: 'mkbhdnew001', t: 'Fresh', at: AT.newest + 5000 }, ...oldUploads]);
    let floorFetch = installFetch({ feeds: { [MKBHD]: floorFeed } });
    await runSweep({ scope: 'all' });
    const floorPlayers = floorFetch.calls.filter((c) => c.url.includes('/youtubei/v1/player')).map((c) => bodyOf(c.opts).videoId);
    t.check(
      'a full feed asks only about the upload new enough to get in',
      JSON.stringify(floorPlayers) === JSON.stringify(['mkbhdnew001']),
      JSON.stringify(floorPlayers),
    );
    t.check('which lands on top and alerts', (await readFeed())[0]?.v === 'mkbhdnew001' && mock.notifications.length === 1, JSON.stringify(mock.notifications));
    t.check(
      "the channel's newest upload is recorded",
      (await readChannels()).find((ch) => ch.id === MKBHD)?.lastVideoAt === AT.newest + 5000,
    );

    t.section('old videos let back into the feed stay quiet');

    await handleMessage({ type: 'removeChannel', id: BEAST });
    floorFetch = installFetch({ feeds: { [MKBHD]: floorFeed } });
    await runSweep({ scope: 'all' });
    t.check('with room again, the older uploads are looked up', floorFetch.calls.filter((c) => c.url.includes('/youtubei/v1/player')).length === 15);
    t.check('and join the feed', (await readFeed()).length === 16, String((await readFeed()).length));
    t.check('without an alert', mock.notifications.length === 1, JSON.stringify(mock.notifications.map((n) => n.message)));
    await writeSettings({ feed: { maxItems: 500 } });

    t.section('items the cap drops do not alert');

    await wipe();
    await writeSettings({ feed: { maxItems: 50 }, ui: { locale: 'en' } });
    const capCh = [
      [MKBHD, 'Marques Brownlee', 'aaa'],
      [BEAST, 'MrBeast', 'bbb'],
      [LINUS, 'Linus Tech Tips', 'ccc'],
      [FOURTH, 'Fourth', 'ddd'],
    ];
    const capMeta = {};
    const capFeeds = {};
    for (const [id, title, prefix] of capCh) {
      await putChannel({ id, title, seeded: true, lastVideoAt: AT.older });
      const entries = Array.from({ length: 15 }, (_, i) => {
        const v = `${prefix}${String(i).padStart(8, '0')}`;
        capMeta[v] = { k: 'video', d: 600, st: 0, at: AT.newest };
        return { v, t: `${title} ${i}`, at: AT.newest };
      });
      capFeeds[id] = rssXml(id, title, entries);
    }
    await saveVideoMeta(capMeta);
    installFetch({ feeds: capFeeds });
    await runSweep({ scope: 'all' });
    const cappedFeed = await readFeed();
    t.check('the feed kept the cap', cappedFeed.length === 50, String(cappedFeed.length));
    const noted = mock.notifications.reduce((n, note) => {
      const m = String(note.message).match(/^(\d+) new videos$/);
      return n + (m ? Number(m[1]) : 1);
    }, 0);
    t.check(
      'dropped rows do not alert',
      noted === 50,
      JSON.stringify({ noted, messages: mock.notifications.map((n) => n.message) }),
    );
    await writeSettings({ feed: { maxItems: 500 } });

    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true, lastVideoAt: AT.mid });
    const retryFeed = rssXml(MKBHD, 'Marques Brownlee', [{ v: 'failfirst01', t: 'Try again', at: AT.newest }]);
    installFetch({ feeds: { [MKBHD]: retryFeed }, playerStatus: 500 });
    await runSweep({ scope: 'all' });
    t.check(
      'an upload that could not be looked up does not move the newest mark',
      (await readChannels())[0].lastVideoAt === AT.mid,
      String((await readChannels())[0].lastVideoAt),
    );
    installFetch({ feeds: { [MKBHD]: retryFeed } });
    await runSweep({ scope: 'all' });
    t.check('so it still alerts when the lookup works', mock.notifications.length === 1 && mock.notifications[0].message === 'Try again', JSON.stringify(mock.notifications));

    t.section('RSS without published uses the player time');

    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true, lastVideoAt: AT.older });
    const noPubXml = rssXml(MKBHD, 'Marques Brownlee', [
      { v: 'nopub000001', t: 'No published', at: AT.newest, omitPublished: true },
    ]);
    t.check('the test feed omits published', !noPubXml.includes('<published>'));
    installFetch({
      feeds: { [MKBHD]: noPubXml },
      players: {
        nopub000001: playerJson('nopub000001', {
          title: 'No published',
          publishDate: '2026-09-12T12:00:00+00:00',
        }),
      },
    });
    mock.notifications.length = 0;
    await runSweep({ scope: 'all' });
    const noPubRow = (await readFeed()).find((row) => row.v === 'nopub000001');
    t.check(
      'the row uses the player time',
      noPubRow?.at === AT.newest,
      JSON.stringify(noPubRow),
    );
    t.check(
      'videoMeta stored the player time, not 0',
      (await readVideoMeta()).nopub000001?.at === AT.newest,
      JSON.stringify((await readVideoMeta()).nopub000001),
    );

    t.section('a long check keeps the worker awake');

    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true });
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const intervals = [];
    const cleared = [];
    globalThis.setInterval = (fn, ms) => {
      intervals.push({ fn, ms });
      return intervals.length;
    };
    globalThis.clearInterval = (handleId) => cleared.push(handleId);
    try {
      installFetch();
      await runSweep({ scope: 'all' });
    } finally {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    }
    t.check('a check sets one timer under 30 seconds', intervals.length === 1 && intervals[0].ms < 30_000, JSON.stringify(intervals.map((i) => i.ms)));
    const pingsBefore = mock.platformInfoCalls;
    intervals[0]?.fn();
    t.check('that calls an extension API', mock.platformInfoCalls === pingsBefore + 1);
    t.check('and is cleared when the check ends', cleared.length === 1 && cleared[0] === 1, JSON.stringify(cleared));

    t.section('install and uninstall pages');

    await wipe();
    await onInstalled({ reason: 'install' });
    t.check(
      'a fresh install opens the welcome page',
      mock.tabsCreated.length === 1 && mock.tabsCreated[0].url === 'chrome-extension://youtube-companion/src/welcome/welcome.html',
      JSON.stringify(mock.tabsCreated),
    );
    t.check(
      'and has missed no release, so the popup stays quiet',
      (await readWhatsNewSeen()) === WHATS_NEW_VERSION,
      await readWhatsNewSeen(),
    );
    mock.tabsCreated.length = 0;
    await wipe();
    await onInstalled({ reason: 'update', previousVersion: '1.0.0' });
    await onInstalled({ reason: 'chrome_update' });
    t.check('an update opens nothing', mock.tabsCreated.length === 0, JSON.stringify(mock.tabsCreated));
    t.check(
      'and leaves the release unseen, so the popup offers it',
      (await readWhatsNewSeen()) === '',
      await readWhatsNewSeen(),
    );

    const unseenState = await handleMessage({ type: 'getState' });
    t.check('getState carries whatsNewSeen', unseenState.whatsNewSeen === '', JSON.stringify(unseenState.whatsNewSeen));
    const ack = await handleMessage({ type: 'whatsNew.seen' });
    t.check('whatsNew.seen reports ok', ack.ok === true);
    t.check('and stores the current release', (await readWhatsNewSeen()) === WHATS_NEW_VERSION, await readWhatsNewSeen());
    const seenState = await handleMessage({ type: 'getState' });
    t.check('getState reflects it', seenState.whatsNewSeen === WHATS_NEW_VERSION);

    await writeSettings({ ui: { locale: 'en' } });
    await syncUninstallUrl();
    t.check(
      'the uninstall page gets the language and version only',
      mock.uninstallUrl === 'https://ashahinl.github.io/Youtube-Companion/uninstall.html?lang=en&v=9.9.9',
      mock.uninstallUrl,
    );
    await writeSettings({ ui: { locale: 'ar' } });
    await wait(20);
    t.check('and follows a language change', new URL(mock.uninstallUrl).searchParams.get('lang') === 'ar', mock.uninstallUrl);
    await writeSettings({ ui: { locale: 'en' } });
    await wait(20);

    t.section('listen-later queue messages');

    const Q1 = 'qvideo00001';
    const Q2 = 'qvideo00002';
    const Q3 = 'qvideo00003';

    await wipe();
    const addedFirst = await handleMessage({
      type: 'queue.add',
      item: { v: Q1, t: 'One', c: MKBHD, ct: 'Marques', at: 10, d: 20 },
    });
    t.check('queue.add reports ok', addedFirst.ok === true && addedFirst.queue?.[0]?.v === Q1, JSON.stringify(addedFirst));
    t.check('queue.add stores the snapshot', (await readQueue())[0]?.t === 'One');
    const addedAgain = await handleMessage({ type: 'queue.add', item: { v: Q1, t: 'Dup' } });
    t.check('queue.add of a duplicate is ok and unchanged', addedAgain.ok === true && addedAgain.queue.length === 1);
    const badId = await handleMessage({ type: 'queue.add', item: { v: 'nope', t: 'Bad' } });
    t.check(
      'queue.add of a bad id is invalid',
      badId.ok === false && badId.error === 'invalid',
      JSON.stringify(badId),
    );
    await handleMessage({ type: 'queue.add', item: { v: Q2, t: 'Two' } });
    const removedOne = await handleMessage({ type: 'queue.remove', v: Q1 });
    t.check('queue.remove drops that id', removedOne.ok === true && removedOne.queue.map((row) => row.v).join() === Q2);
    const openedOk = await handleMessage({ type: 'queue.setOpen', on: true });
    t.check('queue.setOpen reports ok', openedOk.ok === true);
    const openedState = await handleMessage({ type: 'getState' });
    t.check('getState reflects queueOpen', openedState.queueOpen === true);
    const clearedQueue = await handleMessage({ type: 'queue.clear' });
    t.check('queue.clear empties', clearedQueue.ok === true && clearedQueue.queue.length === 0 && (await readQueue()).length === 0);

    const emptyPlay = await handleMessage({ type: 'queue.playAll' });
    t.check(
      'queue.playAll on empty is empty',
      emptyPlay.ok === false && emptyPlay.error === 'empty',
      JSON.stringify(emptyPlay),
    );

    await handleMessage({ type: 'queue.add', item: { v: Q1, t: 'One', k: 'short' } });
    await handleMessage({ type: 'queue.add', item: { v: Q2, t: 'Two' } });
    await handleMessage({ type: 'queue.add', item: { v: Q3, t: 'Three' } });
    mock.resetCalls();
    const played = await handleMessage({ type: 'queue.playAll' });
    t.check('queue.playAll reports ok', played.ok === true, JSON.stringify(played));
    t.check('playAll leaves item 0 in the queue', played.queue?.[0]?.v === Q1 && played.queue.length === 3);
    t.check('playAll opens one focused tab', mock.tabsCreated.length === 1 && mock.tabsCreated[0].active === true);
    t.check(
      'playAll uses the shorts URL for a short',
      mock.tabsCreated[0].url === `https://www.youtube.com/shorts/${Q1}`,
      mock.tabsCreated[0].url,
    );
    const playTabId = mock.tabsCreated[0].id;
    const playFlag = await globalThis.chrome.storage.session.get(`audioOpen:${playTabId}`);
    t.check('playAll without the audio setting stores no audioOpen flag', playFlag[`audioOpen:${playTabId}`] === undefined, JSON.stringify(playFlag));
    const playRec = await globalThis.chrome.storage.session.get('queuePlay');
    t.check(
      'playAll writes queuePlay',
      playRec.queuePlay?.tabId === playTabId && playRec.queuePlay?.v === Q1,
      JSON.stringify(playRec),
    );

    const wrongTab = await handleMessage(
      { type: 'queue.ended', v: Q1 },
      { tab: { id: playTabId + 99 } },
    );
    t.check('queue.ended from the wrong tab is ignored', wrongTab.ok === false, JSON.stringify(wrongTab));
    t.check('wrong tab does not change the queue', (await readQueue()).map((row) => row.v).join() === `${Q1},${Q2},${Q3}`);
    t.check('wrong tab does not navigate', mock.tabsUpdated.length === 0, JSON.stringify(mock.tabsUpdated));

    const wrongV = await handleMessage(
      { type: 'queue.ended', v: Q2 },
      { tab: { id: playTabId } },
    );
    t.check('queue.ended with the wrong v is ignored', wrongV.ok === false, JSON.stringify(wrongV));
    t.check('wrong v does not change the queue', (await readQueue())[0]?.v === Q1);
    t.check('wrong v does not navigate', mock.tabsUpdated.length === 0);

    const advanced = await handleMessage(
      { type: 'queue.ended', v: Q1 },
      { tab: { id: playTabId } },
    );
    t.check('the matching ended advances', advanced.ok === true && advanced.done !== true, JSON.stringify(advanced));
    t.check('the finished video left the queue', (await readQueue()).map((row) => row.v).join() === `${Q2},${Q3}`);
    t.check(
      'advance updates the same tab',
      mock.tabsUpdated.length === 1
        && mock.tabsUpdated[0].tabId === playTabId
        && mock.tabsUpdated[0].url === `https://www.youtube.com/watch?v=${Q2}`,
      JSON.stringify(mock.tabsUpdated),
    );
    const afterAdvance = await globalThis.chrome.storage.session.get('queuePlay');
    t.check(
      'queuePlay moves to the next id',
      afterAdvance.queuePlay?.tabId === playTabId && afterAdvance.queuePlay?.v === Q2,
      JSON.stringify(afterAdvance),
    );

    await handleMessage({ type: 'queue.ended', v: Q2 }, { tab: { id: playTabId } });
    mock.tabsUpdated.length = 0;
    const last = await handleMessage({ type: 'queue.ended', v: Q3 }, { tab: { id: playTabId } });
    t.check('the last item reports done', last.ok === true && last.done === true, JSON.stringify(last));
    t.check('the queue is empty after the last item', (await readQueue()).length === 0);
    t.check('the last item does not navigate', mock.tabsUpdated.length === 0);
    const afterDone = await globalThis.chrome.storage.session.get('queuePlay');
    t.check('the last item clears queuePlay', afterDone.queuePlay === undefined, JSON.stringify(afterDone));

    await wipe();
    await handleMessage({ type: 'queue.add', item: { v: Q1, t: 'One' } });
    const playedAgain = await handleMessage({ type: 'queue.playAll' });
    const liveTab = mock.tabsCreated[mock.tabsCreated.length - 1].id;
    t.check('second playAll opened a tab', playedAgain.ok === true && liveTab != null);
    mock.fireTabRemoved(liveTab);
    await wait(20);
    const afterClose = await globalThis.chrome.storage.session.get('queuePlay');
    t.check('closing the play tab clears queuePlay', afterClose.queuePlay === undefined, JSON.stringify(afterClose));
    t.check('closing the tab leaves the queue', (await readQueue())[0]?.v === Q1);

    await wipe();
    await writeSettings({ audio: { openFeedInAudioMode: true } });
    await handleMessage({ type: 'queue.add', item: { v: Q1, t: 'One', k: 'short' } });
    await handleMessage({ type: 'queue.add', item: { v: Q2, t: 'Two' } });
    mock.resetCalls();
    const audioPlay = await handleMessage({ type: 'queue.playAll' });
    const audioTabId = mock.tabsCreated[0]?.id;
    t.check('audio playAll reports ok', audioPlay.ok === true);
    t.check(
      'audio playAll uses the watch URL',
      mock.tabsCreated[0]?.url === `https://www.youtube.com/watch?v=${Q1}`,
      mock.tabsCreated[0]?.url,
    );
    const audioFlag = await globalThis.chrome.storage.session.get(`audioOpen:${audioTabId}`);
    t.check('audio playAll sets audioOpen', audioFlag[`audioOpen:${audioTabId}`] === true, JSON.stringify(audioFlag));
    await handleMessage({ type: 'queue.ended', v: Q1 }, { tab: { id: audioTabId } });
    t.check(
      'audio advance updates the same tab on the watch URL',
      mock.tabsUpdated[0]?.tabId === audioTabId
        && mock.tabsUpdated[0]?.url === `https://www.youtube.com/watch?v=${Q2}`,
      JSON.stringify(mock.tabsUpdated),
    );
    const nextFlag = await globalThis.chrome.storage.session.get(`audioOpen:${audioTabId}`);
    t.check('audio advance sets audioOpen again', nextFlag[`audioOpen:${audioTabId}`] === true, JSON.stringify(nextFlag));

    await wipe();
    for (let i = 0; i < QUEUE_CAP; i++) {
      await addToQueue({ v: `f${String(i).padStart(10, '0')}`, t: 'x' });
    }
    const full = await handleMessage({ type: 'queue.add', item: { v: Q1, t: 'Nope' } });
    t.check(
      'queue.add at the cap is full',
      full.ok === false && full.error === 'full' && full.queue.length === QUEUE_CAP,
      JSON.stringify({ ok: full.ok, error: full.error, n: full.queue?.length }),
    );

    t.section('renaming and deleting a group');

    await wipe();
    await putChannel({ id: MKBHD, title: 'Marques Brownlee', seeded: true, groups: ['Music', 'tech'] });
    await putChannel({ id: BEAST, title: 'MrBeast', seeded: true, groups: ['music'] });
    await writeSettings({ feed: { group: 'music' } });
    await saveFeed([{ v: 'badgevid001', c: MKBHD, t: 'Badge', at: AT.newest, d: 60, vw: 1, k: 'video', st: 0 }]);
    await writePollState({ lastSeenAt: 0 });
    mock.badgeText = 'stale';

    const renamed = await handleMessage({ type: 'renameGroup', from: 'MUSIC', to: '  Audio  ' });
    t.check('rename replies ok', renamed.ok === true, JSON.stringify(renamed));
    const afterRename = await readChannels();
    const mkbhdRenamed = afterRename.find((c) => c.id === MKBHD);
    const beastRenamed = afterRename.find((c) => c.id === BEAST);
    t.check(
      'the new spelling reaches every channel with the group',
      mkbhdRenamed.groups.includes('Audio') && beastRenamed.groups.includes('Audio')
        && !mkbhdRenamed.groups.some((g) => g.toLowerCase() === 'music'),
      JSON.stringify(afterRename.map((c) => c.groups)),
    );
    t.check('the other group is untouched', mkbhdRenamed.groups.includes('tech'));
    t.check(
      'the feed filter follows the rename',
      (await handleMessage({ type: 'getState' })).settings.feed.group === 'Audio',
      (await handleMessage({ type: 'getState' })).settings.feed.group,
    );
    t.check('the badge is refreshed', mock.badgeText === '1', mock.badgeText);

    const merged = await handleMessage({ type: 'renameGroup', from: 'Audio', to: 'TECH' });
    t.check('rename onto an existing name replies ok', merged.ok === true, JSON.stringify(merged));
    const afterJoin = await readChannels();
    t.check(
      'a merge leaves one copy with the existing spelling',
      afterJoin.every((c) => c.groups.length === 1 && c.groups[0] === 'tech'),
      JSON.stringify(afterJoin.map((c) => c.groups)),
    );
    t.check(
      'the feed filter follows into the surviving spelling',
      (await handleMessage({ type: 'getState' })).settings.feed.group === 'tech',
    );

    const unknownRename = await handleMessage({ type: 'renameGroup', from: 'Gone', to: 'Else' });
    t.check(
      'renaming an unknown group is refused',
      unknownRename.ok === false && unknownRename.error === 'missing',
      JSON.stringify(unknownRename),
    );
    const emptyRename = await handleMessage({ type: 'renameGroup', from: 'tech', to: '   ' });
    t.check(
      'renaming to an empty name is refused',
      emptyRename.ok === false && emptyRename.error === 'empty',
      JSON.stringify(emptyRename),
    );

    await writeSettings({ feed: { group: 'tech' } });
    mock.badgeText = 'stale';
    const deleted = await handleMessage({ type: 'deleteGroup', name: 'TECH' });
    t.check('delete replies ok', deleted.ok === true, JSON.stringify(deleted));
    const afterDelete = await readChannels();
    t.check(
      'the group is gone from every channel and the channels stay',
      afterDelete.length === 2 && afterDelete.every((c) => c.groups.length === 0),
      JSON.stringify(afterDelete.map((c) => c.groups)),
    );
    t.check(
      'the feed filter resets to All',
      (await handleMessage({ type: 'getState' })).settings.feed.group === '',
    );
    t.check('the badge is refreshed after delete', mock.badgeText === '1', mock.badgeText);

    await handleMessage({ type: 'setChannelGroup', id: MKBHD, name: 'News', on: true });
    await writeSettings({ feed: { group: 'Other' } });
    const otherDelete = await handleMessage({ type: 'deleteGroup', name: 'News' });
    t.check('deleting with the filter elsewhere replies ok', otherDelete.ok === true, JSON.stringify(otherDelete));
    t.check(
      'a filter on another name is untouched',
      (await handleMessage({ type: 'getState' })).settings.feed.group === 'Other',
    );
    const unknownDelete = await handleMessage({ type: 'deleteGroup', name: 'Gone' });
    t.check(
      'deleting an unknown group is refused',
      unknownDelete.ok === false && unknownDelete.error === 'missing',
      JSON.stringify(unknownDelete),
    );

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

    const WELCOME_SENDER = { ...POPUP_SENDER, url: 'chrome-extension://youtube-companion/src/welcome/welcome.html' };
    const fromWelcome = await viaListenerAs({ type: 'getState' }, WELCOME_SENDER);
    t.check('the welcome page may send what the popup sends', Array.isArray(fromWelcome.res.channels), JSON.stringify(fromWelcome.res));

    for (const type of ['getState', 'popupOpened', 'sweep', 'addChannel', 'removeChannel',
      'clearChannels', 'setFavorite', 'setMuted', 'updateSettings', 'openInAudioMode',
      'importBackup', 'importTakeout', 'importFromYouTube', 'undoRemove', 'renameGroup', 'deleteGroup',
      'queue.add', 'queue.remove', 'queue.clear', 'queue.playAll', 'queue.setOpen',
      'whatsNew.seen', 'subscriptions.scan']) {
      const res = await viaListenerAs({ type }, PAGE_SENDER);
      t.check(`a YouTube page cannot send ${type}`, res.res.error === 'not allowed', JSON.stringify(res.res));
    }

    t.check('renameGroup is not a content-script message', !CONTENT_SCRIPT_MESSAGES.has('renameGroup'));
    t.check('deleteGroup is not a content-script message', !CONTENT_SCRIPT_MESSAGES.has('deleteGroup'));

    t.check('queue.ended is in CONTENT_SCRIPT_MESSAGES', CONTENT_SCRIPT_MESSAGES.has('queue.ended'));
    t.check('queue.add is not a content-script message', !CONTENT_SCRIPT_MESSAGES.has('queue.add'));
    t.check('queue.remove is not a content-script message', !CONTENT_SCRIPT_MESSAGES.has('queue.remove'));
    t.check('queue.clear is not a content-script message', !CONTENT_SCRIPT_MESSAGES.has('queue.clear'));
    t.check('queue.playAll is not a content-script message', !CONTENT_SCRIPT_MESSAGES.has('queue.playAll'));
    t.check('queue.setOpen is not a content-script message', !CONTENT_SCRIPT_MESSAGES.has('queue.setOpen'));
    t.check('whatsNew.seen is not a content-script message', !CONTENT_SCRIPT_MESSAGES.has('whatsNew.seen'));
    t.check('subscriptions.close is a content-script message', CONTENT_SCRIPT_MESSAGES.has('subscriptions.close'));
    t.check('importFromYouTube is not a content-script message', !CONTENT_SCRIPT_MESSAGES.has('importFromYouTube'));
    t.check('subscriptions.scan is not a content-script message', !CONTENT_SCRIPT_MESSAGES.has('subscriptions.scan'));

    const pageClose = await viaListenerAs({ type: 'subscriptions.close' }, PAGE_SENDER);
    t.check(
      'a YouTube page may close its own tab',
      pageClose.res.ok === true && mock.tabsRemoved.includes(42),
      JSON.stringify(pageClose.res),
    );
    const foreignClose = await viaListenerAs({ type: 'subscriptions.close' }, {
      ...PAGE_SENDER,
      url: 'https://example.com/',
      tab: { id: 99, url: 'https://example.com/' },
    });
    t.check(
      'subscriptions.close refuses a tab that is not YouTube',
      foreignClose.res.ok === false && !mock.tabsRemoved.includes(99),
      JSON.stringify(foreignClose.res),
    );

    const pageEnded = await viaListenerAs({ type: 'queue.ended', v: 'abcdefghijk' }, PAGE_SENDER);
    t.check(
      'a YouTube page may send queue.ended',
      pageEnded.res.error !== 'not allowed',
      JSON.stringify(pageEnded.res),
    );

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
