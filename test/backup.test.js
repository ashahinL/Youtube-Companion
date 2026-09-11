/**
 * Backup export / import: file shape, parse rejections, merge vs replace.
 * Pure — no chrome, no network.
 */

import { DEFAULT_SETTINGS, clampSettings } from '../src/lib/settings.js';
import { buildBackup, parseBackup, mergeBackup } from '../src/lib/backup.js';

const MKBHD = 'UCBJycsmduvYEL83R_U4JriQ';
const BEAST = 'UCX6OQ3DkcsbYNE6H8uQQuVA';

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function channel(id, extra = {}) {
  return {
    id,
    handle: extra.handle ?? `@${id.slice(0, 6)}`,
    title: extra.title ?? id,
    avatar: extra.avatar ?? 'https://yt3.ggpht.com/a',
    favorite: !!extra.favorite,
    addedAt: extra.addedAt ?? 1_700_000_000_000,
    lastFetchAt: extra.lastFetchAt ?? 99,
    lastVideoAt: extra.lastVideoAt ?? 50,
    lastError: extra.lastError === undefined ? { at: 1, message: 'stale' } : extra.lastError,
    seeded: extra.seeded === undefined ? true : extra.seeded,
  };
}

function emptyState() {
  return { settings: {}, channels: [] };
}

export default async function run(t) {
  t.section('buildBackup shape');

  const settings = clampSettings({
    ...DEFAULT_SETTINGS,
    feed: { ...DEFAULT_SETTINGS.feed, showShorts: true, maxItems: 200 },
  });
  const channels = [
    channel(MKBHD, { title: 'Marques Brownlee', handle: '@mkbhd', favorite: true, addedAt: 111 }),
    channel(BEAST, { title: 'MrBeast', handle: '@MrBeast', favorite: false, addedAt: 222 }),
  ];
  const built = buildBackup({
    settings,
    channels,
    feed: [{ v: 'shouldNotExport' }],
    videoMeta: { shouldNotExport: { k: 'video' } },
  });

  t.check('app is youtube-companion', built.app === 'youtube-companion', String(built.app));
  t.check('version is 1', built.version === 1, String(built.version));
  t.check(
    'exportedAt is an ISO string',
    typeof built.exportedAt === 'string' && Number.isFinite(Date.parse(built.exportedAt)),
    String(built.exportedAt),
  );
  t.check('settings are present', same(built.settings, settings));
  t.check('channels length matches', built.channels.length === 2, String(built.channels.length));
  t.check('feed is absent', !('feed' in built));
  t.check('videoMeta is absent', !('videoMeta' in built));

  t.section('channel fields on export');

  const row = built.channels[0];
  t.check('favorite survives', row.favorite === true, String(row.favorite));
  t.check('addedAt survives', row.addedAt === 111, String(row.addedAt));
  t.check('lastFetchAt is omitted', !('lastFetchAt' in row));
  t.check('lastError is omitted', !('lastError' in row));
  t.check('seeded is omitted', !('seeded' in row));
  t.check('id is kept', row.id === MKBHD, String(row.id));

  t.section('parseBackup rejections');

  const notJson = parseBackup('not json {');
  t.check('non-JSON is not ok', notJson.ok === false);
  t.check('non-JSON has an error', typeof notJson.error === 'string' && notJson.error.length > 0);

  const wrongApp = parseBackup(JSON.stringify({
    app: 'poppo-companion',
    version: 1,
    channels: [],
  }));
  t.check('wrong app is not ok', wrongApp.ok === false);
  t.check(
    'wrong-app error is distinct from non-JSON',
    wrongApp.error !== notJson.error,
    String(wrongApp.error),
  );

  const badVersion = parseBackup(JSON.stringify({
    app: 'youtube-companion',
    version: 99,
    channels: [],
  }));
  t.check('unknown version is not ok', badVersion.ok === false);
  t.check(
    'version error is distinct from app and JSON',
    badVersion.error !== notJson.error && badVersion.error !== wrongApp.error,
    String(badVersion.error),
  );

  const noChannels = parseBackup(JSON.stringify({
    app: 'youtube-companion',
    version: 1,
    settings: {},
  }));
  t.check('missing channels is not ok', noChannels.ok === false);
  t.check(
    'missing-channels error is distinct',
    noChannels.error !== notJson.error
      && noChannels.error !== wrongApp.error
      && noChannels.error !== badVersion.error,
    String(noChannels.error),
  );

  const notArray = parseBackup(JSON.stringify({
    app: 'youtube-companion',
    version: 1,
    channels: { id: MKBHD },
  }));
  t.check('non-array channels is not ok', notArray.ok === false);
  t.check(
    'non-array channels uses the channels error',
    notArray.error === noChannels.error,
    String(notArray.error),
  );

  const noId = parseBackup(JSON.stringify({
    app: 'youtube-companion',
    version: 1,
    channels: [{ title: 'Nameless', handle: '@x' }],
  }));
  t.check('channel without id is not ok', noId.ok === false);
  t.check(
    'missing-id error is distinct',
    noId.error !== notJson.error
      && noId.error !== wrongApp.error
      && noId.error !== badVersion.error
      && noId.error !== noChannels.error,
    String(noId.error),
  );

  const blankId = parseBackup(JSON.stringify({
    app: 'youtube-companion',
    version: 1,
    channels: [{ id: '   ', title: 'Blank' }],
  }));
  t.check('blank id is not ok', blankId.ok === false);
  t.check('blank id uses the id error', blankId.error === noId.error, String(blankId.error));

  const five = [notJson.error, wrongApp.error, badVersion.error, noChannels.error, noId.error];
  t.check(
    'the five parse errors are pairwise distinct',
    new Set(five).size === 5,
    JSON.stringify(five),
  );

  t.check('parseBackup(null) does not throw', parseBackup(null).ok === false);
  t.check('parseBackup(undefined) does not throw', parseBackup(undefined).ok === false);

  t.section('round trip');

  const pretty = JSON.stringify(built, null, 2);
  const parsed = parseBackup(pretty);
  t.check('pretty-printed export parses', parsed.ok === true, parsed.error);
  t.check('parsed app matches', parsed.data?.app === 'youtube-companion');

  const restored = mergeBackup(emptyState(), parsed.data, 'merge');
  t.check('round trip added both channels', restored.added === 2, String(restored.added));
  t.check('round trip skipped none', restored.skipped === 0, String(restored.skipped));
  t.check('round trip channel count', restored.channels.length === 2, String(restored.channels.length));

  const gotMk = restored.channels.find((c) => c.id === MKBHD);
  const gotBeast = restored.channels.find((c) => c.id === BEAST);
  t.check('round trip keeps favourite', gotMk?.favorite === true, JSON.stringify(gotMk));
  t.check('round trip keeps addedAt', gotMk?.addedAt === 111, String(gotMk?.addedAt));
  t.check('round trip keeps second addedAt', gotBeast?.addedAt === 222, String(gotBeast?.addedAt));
  t.check('round trip keeps titles', gotMk?.title === 'Marques Brownlee' && gotBeast?.title === 'MrBeast');
  t.check(
    'round trip settings showShorts from the file',
    restored.settings.feed.showShorts === true,
    JSON.stringify(restored.settings.feed),
  );
  t.check(
    'round trip settings maxItems from the file',
    restored.settings.feed.maxItems === 200,
    String(restored.settings.feed.maxItems),
  );

  t.section('merge keeps the live favourite');

  const live = {
    settings: clampSettings({
      alerts: { enabled: false, notifyNormal: false, useAvatarIcon: false },
    }),
    channels: [
      channel(MKBHD, { favorite: true, addedAt: 111, title: 'Live title' }),
      channel('UCgone', { title: 'Gone' }),
    ],
  };
  const fileDisagrees = {
    app: 'youtube-companion',
    version: 1,
    settings: { alerts: { enabled: true }, feed: { showShorts: true } },
    channels: [
      { id: MKBHD, favorite: false, addedAt: 999, title: 'File title' },
      { id: BEAST, favorite: true, addedAt: 222, title: 'MrBeast' },
    ],
  };
  const merged = mergeBackup(live, fileDisagrees, 'merge');
  const kept = merged.channels.find((c) => c.id === MKBHD);
  t.check('existing favourite flag wins', kept?.favorite === true, JSON.stringify(kept));
  t.check('existing addedAt wins', kept?.addedAt === 111, String(kept?.addedAt));
  t.check('existing title wins', kept?.title === 'Live title', String(kept?.title));
  t.check('new channel is added', merged.channels.some((c) => c.id === BEAST));
  t.check(
    'merge keeps a channel the file does not mention',
    merged.channels.some((c) => c.id === 'UCgone'),
  );
  t.check('merge added count is 1', merged.added === 1, String(merged.added));
  t.check('merge skipped count is 1', merged.skipped === 1, String(merged.skipped));
  t.check(
    'merge puts the file settings on top',
    merged.settings.alerts.enabled === true && merged.settings.feed.showShorts === true,
    JSON.stringify(merged.settings),
  );
  t.check(
    'merge keeps settings the file did not mention',
    merged.settings.alerts.notifyNormal === false && merged.settings.alerts.useAvatarIcon === false,
    JSON.stringify(merged.settings.alerts),
  );

  t.section('replace');

  const replaced = mergeBackup(live, fileDisagrees, 'replace');
  t.check(
    'replace drops a channel the file does not mention',
    !replaced.channels.some((c) => c.id === 'UCgone'),
  );
  t.check('replace has exactly the file channels', replaced.channels.length === 2, String(replaced.channels.length));
  t.check(
    'replace takes the file favourite',
    replaced.channels.find((c) => c.id === MKBHD)?.favorite === false,
  );
  t.check(
    'replace takes the file title',
    replaced.channels.find((c) => c.id === MKBHD)?.title === 'File title',
  );
  t.check('replace added is the file size', replaced.added === 2, String(replaced.added));
  t.check('replace skipped is 0', replaced.skipped === 0, String(replaced.skipped));
  t.check(
    'replace does not keep live-only settings',
    replaced.settings.alerts.notifyNormal === DEFAULT_SETTINGS.alerts.notifyNormal,
    JSON.stringify(replaced.settings.alerts),
  );
  t.check(
    'replace applies the file settings',
    replaced.settings.alerts.enabled === true && replaced.settings.feed.showShorts === true,
  );

  t.section('imported records reset volatile fields');

  const imported = [
    ...restored.channels,
    merged.channels.find((c) => c.id === BEAST),
    ...replaced.channels,
  ].filter(Boolean);
  for (const rec of imported) {
    t.check(
      `${rec.id} lastFetchAt is 0`,
      rec.lastFetchAt === 0,
      String(rec.lastFetchAt),
    );
    t.check(
      `${rec.id} lastError is null`,
      rec.lastError === null,
      JSON.stringify(rec.lastError),
    );
    t.check(
      `${rec.id} seeded is false`,
      rec.seeded === false,
      String(rec.seeded),
    );
  }

  const fromStale = mergeBackup(emptyState(), {
    channels: [channel(MKBHD, { lastFetchAt: 88, lastError: { at: 1, message: 'nope' }, seeded: true })],
  }, 'replace');
  const fresh = fromStale.channels[0];
  t.check('stale lastFetchAt was reset', fresh.lastFetchAt === 0, String(fresh.lastFetchAt));
  t.check('stale lastError was reset', fresh.lastError === null, JSON.stringify(fresh.lastError));
  t.check('stale seeded was reset', fresh.seeded === false, String(fresh.seeded));
  t.check('favorite still rode along', fresh.favorite === false);
  t.check('addedAt still rode along', fresh.addedAt === 1_700_000_000_000, String(fresh.addedAt));
}
