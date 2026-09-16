/**
 * Backup export / import: file shape, parse rejections, merge vs replace.
 * Pure — no chrome, no network.
 */

import { DEFAULT_SETTINGS, clampSettings } from '../src/lib/settings.js';
import {
  buildBackup,
  parseBackup,
  mergeBackup,
  backupSizeError,
  MAX_BACKUP_BYTES,
  MAX_BACKUP_CHANNELS,
} from '../src/lib/backup.js';

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
    muted: !!extra.muted,
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
    channel(MKBHD, { title: 'Marques Brownlee', handle: '@mkbhd', favorite: true, muted: true, addedAt: 111 }),
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
  t.check('export has no audioCover', !('audioCover' in built) && !('audioCover' in (built.settings || {})));
  t.check('export has no imageUrl', !('imageUrl' in (built.settings?.audio || {})));

  t.section('channel fields on export');

  const row = built.channels[0];
  t.check('favorite survives', row.favorite === true, String(row.favorite));
  t.check('muted survives', row.muted === true && built.channels[1].muted === false, JSON.stringify(built.channels));
  t.check('addedAt survives', row.addedAt === 111, String(row.addedAt));
  t.check('lastVideoAt survives', row.lastVideoAt === 50, String(row.lastVideoAt));
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

  for (const [label, id] of [
    ['a handle', '@mkbhd'],
    ['a channel URL', `https://www.youtube.com/channel/${MKBHD}`],
    ['a short UC id', 'UCgone'],
    ['a 24-character id without UC', `XX${MKBHD.slice(2)}`],
    ['a number', 12345],
  ]) {
    const res = parseBackup(JSON.stringify({ app: 'youtube-companion', version: 1, channels: [{ id }] }));
    t.check(`${label} as the id rejects the file`, res.ok === false && res.error === noId.error, JSON.stringify(res));
  }
  const oneBad = parseBackup(JSON.stringify({
    app: 'youtube-companion',
    version: 1,
    channels: [{ id: MKBHD }, { id: 'not-a-channel' }, { id: BEAST }],
  }));
  t.check('one bad id among good ones rejects the whole file', oneBad.ok === false, JSON.stringify(oneBad));

  const manyIds = Array.from({ length: MAX_BACKUP_CHANNELS + 1 }, (_, i) => ({
    id: `UC${String(i).padStart(22, '0')}`,
  }));
  const tooMany = parseBackup(JSON.stringify({ app: 'youtube-companion', version: 1, channels: manyIds }));
  t.check(`more than ${MAX_BACKUP_CHANNELS} channels is not ok`, tooMany.ok === false, JSON.stringify(tooMany).slice(0, 120));
  const atLimit = parseBackup(JSON.stringify({
    app: 'youtube-companion',
    version: 1,
    channels: manyIds.slice(0, MAX_BACKUP_CHANNELS),
  }));
  t.check(`exactly ${MAX_BACKUP_CHANNELS} channels parses`, atLimit.ok === true, String(atLimit.error));

  const huge = parseBackup(JSON.stringify({
    app: 'youtube-companion',
    version: 1,
    channels: [{ id: MKBHD, title: 'x'.repeat(MAX_BACKUP_BYTES) }],
  }));
  t.check('a file over the size limit is not ok', huge.ok === false, String(huge.error));
  t.check('the size check does not need valid JSON', parseBackup('{'.repeat(MAX_BACKUP_BYTES + 1)).error === huge.error);
  t.check('backupSizeError is empty at the limit', backupSizeError(MAX_BACKUP_BYTES) === '');
  t.check('backupSizeError names one byte over', backupSizeError(MAX_BACKUP_BYTES + 1) === huge.error);

  const seven = [
    notJson.error, wrongApp.error, badVersion.error, noChannels.error, noId.error, tooMany.error, huge.error,
  ];
  t.check(
    'the seven parse errors are pairwise distinct',
    new Set(seven).size === 7,
    JSON.stringify(seven),
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
  t.check('round trip keeps muted', gotMk?.muted === true, JSON.stringify(gotMk));
  t.check(
    'round trip addedAt is the import time, not the file\'s',
    gotMk?.addedAt >= Date.now() - 5_000 && gotMk?.addedAt <= Date.now(),
    String(gotMk?.addedAt),
  );
  t.check('round trip keeps lastVideoAt', gotMk?.lastVideoAt === 50, String(gotMk?.lastVideoAt));
  t.check(
    'round trip second addedAt is also the import time',
    gotBeast?.addedAt >= Date.now() - 5_000 && gotBeast?.addedAt <= Date.now(),
    String(gotBeast?.addedAt),
  );
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
  t.check(
    'addedAt is the import time, not the file\'s',
    fresh.addedAt >= Date.now() - 5_000 && fresh.addedAt <= Date.now(),
    String(fresh.addedAt),
  );

  t.section('imported avatars load only from YouTube');

  const avatarCases = [
    ['yt3.ggpht.com', 'https://yt3.ggpht.com/abc=s88-c-k-c0x00ffffff-no-rj', true],
    ['yt3.googleusercontent.com', 'https://yt3.googleusercontent.com/abc=s120-c-k-c0x00ffffff-no-rj', true],
    ['another host', 'https://tracker.example/pixel.gif', false],
    ['a look-alike host', 'https://yt3.ggpht.com.example/a.png', false],
    ['plain http', 'http://yt3.ggpht.com/a', false],
    ['a data: URL', 'data:image/png;base64,iVBORw0KGgo=', false],
    ['javascript:', 'javascript:alert(1)', false],
    ['not a string', 42, false],
  ];
  const withAvatars = mergeBackup(emptyState(), {
    channels: avatarCases.map(([, avatar], i) => ({ id: `UC${String(i).padStart(22, '0')}`, avatar })),
  }, 'replace');
  avatarCases.forEach(([label, avatar, keep], i) => {
    const got = withAvatars.channels[i]?.avatar;
    t.check(
      keep ? `${label} avatar is kept` : `${label} avatar is dropped`,
      keep ? got === avatar : got === '',
      JSON.stringify(got),
    );
  });
  t.check('a dropped avatar still imports the channel', withAvatars.channels.length === avatarCases.length);

  t.section('cover picture stays out of backups');

  const withUrl = buildBackup({
    settings: {
      ...DEFAULT_SETTINGS,
      audio: { ...DEFAULT_SETTINGS.audio, imageUrl: 'data:image/png;base64,aaa', backgroundType: 'image' },
      audioCover: 'data:image/jpeg;base64,shouldNotExport',
      rateNoteDone: true,
    },
    channels: [],
  });
  t.check('a leftover imageUrl is stripped on export', !('imageUrl' in (withUrl.settings?.audio || {})));
  t.check('audioCover stuffed into settings is stripped on export', !('audioCover' in withUrl.settings));
  t.check('rateNoteDone is stripped on export', !('rateNoteDone' in withUrl.settings));
  t.check('backgroundType image still exports', withUrl.settings?.audio?.backgroundType === 'image');

  const importedCover = mergeBackup(emptyState(), {
    app: 'youtube-companion',
    version: 1,
    settings: {
      audio: {
        backgroundType: 'image',
        imageUrl: 'https://example.com/bg.jpg',
      },
    },
    channels: [],
  }, 'replace');
  t.check(
    'import ignores imageUrl',
    !('imageUrl' in (importedCover.settings?.audio || {})),
    JSON.stringify(importedCover.settings?.audio),
  );
  t.check(
    'import still takes backgroundType image',
    importedCover.settings.audio.backgroundType === 'image',
  );

  t.section('merge refuses when live plus file would pass the cap');

  const liveMany = {
    settings: {},
    channels: Array.from({ length: 1500 }, (_, i) => channel(`UC${String(i).padStart(22, '0')}`)),
  };
  const fileMany = {
    channels: Array.from({ length: 1500 }, (_, i) => ({
      id: `UC${String(i + 1500).padStart(22, '0')}`,
    })),
  };
  const overMerge = mergeBackup(liveMany, fileMany, 'merge');
  t.check('merge over the cap is not ok', !!overMerge.error, JSON.stringify({ error: overMerge.error, added: overMerge.added }));
  t.check('merge over the cap adds none', overMerge.added === 0, String(overMerge.added));
  t.check(
    'merge over the cap leaves the live list',
    overMerge.channels.length === 1500,
    String(overMerge.channels.length),
  );
  t.check(
    'the merge error is not the file-too-many parse error',
    overMerge.error !== tooMany.error,
    String(overMerge.error),
  );
  t.check(
    'the merge error names the cap',
    typeof overMerge.error === 'string' && overMerge.error.includes(String(MAX_BACKUP_CHANNELS)),
    String(overMerge.error),
  );

  const atCap = mergeBackup(
    { settings: {}, channels: Array.from({ length: 1000 }, (_, i) => channel(`UC${String(i).padStart(22, '0')}`)) },
    { channels: Array.from({ length: 1000 }, (_, i) => ({ id: `UC${String(i + 1000).padStart(22, '0')}` })) },
    'merge',
  );
  t.check(
    `merge of exactly ${MAX_BACKUP_CHANNELS} is ok`,
    !atCap.error && atCap.channels.length === MAX_BACKUP_CHANNELS && atCap.added === 1000,
    JSON.stringify({ error: atCap.error, length: atCap.channels.length, added: atCap.added }),
  );

  const overReplace = mergeBackup(liveMany, fileMany, 'replace');
  t.check(
    'replace does not use the merge cap',
    !overReplace.error && overReplace.channels.length === 1500 && overReplace.added === 1500,
    JSON.stringify({ error: overReplace.error, length: overReplace.channels.length }),
  );
}
