/**
 * Settings storage: defaults, deep merge, clamp, and the onChanged
 * subscription.
 */

import { installChromeMock } from './helpers/chrome-mock.js';
import {
  DEFAULT_SETTINGS,
  readSettings,
  writeSettings,
  clampSettings,
  onSettingsChanged,
  migrateAudioCover,
} from '../src/lib/settings.js';
import { AUDIO_COVER_KEY } from '../src/lib/cover.js';

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function withPoll(intervalMinutes) {
  return clampSettings({
    ...DEFAULT_SETTINGS,
    poll: { ...DEFAULT_SETTINGS.poll, intervalMinutes },
  });
}

export default async function run(t) {
  const previous = globalThis.chrome;
  const mock = installChromeMock();

  try {
    t.section('chrome mock');

    await globalThis.chrome.storage.local.set({ a: { n: 1 }, b: 2 });
    const all = await globalThis.chrome.storage.local.get(null);
    t.check('get(null) returns everything', all.a.n === 1 && all.b === 2);
    const missing = await globalThis.chrome.storage.local.get('nope');
    t.check('get(string) for a missing key is {}', same(missing, {}));
    const some = await globalThis.chrome.storage.local.get(['a', 'missing']);
    t.check('get(array) keeps only present keys', some.a.n === 1 && some.missing === undefined);
    const withDefaults = await globalThis.chrome.storage.local.get({ a: { n: 0 }, z: 9 });
    t.check(
      'get(object) uses stored values and defaults',
      withDefaults.a.n === 1 && withDefaults.z === 9,
    );

    const held = { n: 1 };
    await globalThis.chrome.storage.local.set({ held });
    held.n = 99;
    t.check('set deep-clones on the way in', mock.storage.held.n === 1, String(mock.storage.held.n));
    const got = await globalThis.chrome.storage.local.get('held');
    got.held.n = 77;
    t.check('get deep-clones on the way out', mock.storage.held.n === 1, String(mock.storage.held.n));

    await globalThis.chrome.storage.local.remove('a');
    t.check('remove drops a key', mock.storage.a === undefined);
    await globalThis.chrome.storage.local.clear();
    t.check('clear empties the store', Object.keys(mock.storage).length === 0);

    t.section('defaults');

    const empty = await readSettings();
    t.check(
      'empty store returns exactly DEFAULT_SETTINGS',
      same(empty, DEFAULT_SETTINGS),
      JSON.stringify(empty),
    );
    t.check(
      'clamp of the defaults is a no-op',
      same(clampSettings(DEFAULT_SETTINGS), DEFAULT_SETTINGS),
    );

    t.section('partial merge');

    mock.storage.settings = { alerts: { enabled: false } };
    const partial = await readSettings();
    t.check('setting only alerts.enabled applies', partial.alerts.enabled === false);
    t.check('other alerts fields stay at their defaults',
      partial.alerts.notifyNormal === true && partial.alerts.useAvatarIcon === true);
    t.check('unrelated groups stay at their defaults',
      partial.poll.intervalMinutes === 30 && partial.feed.maxItems === 500);

    t.section('unknown keys');

    mock.storage.settings = {
      notAThing: 1,
      poll: { enabled: true, ghost: 9 },
      alerts: { enabled: true },
    };
    const dropped = await readSettings();
    t.check('unknown top-level key is dropped', dropped.notAThing === undefined);
    t.check('unknown nested key is dropped', dropped.poll.ghost === undefined);
    t.check('known keys alongside unknowns still apply', dropped.poll.enabled === true);

    t.section('clamp: poll.intervalMinutes');

    t.check('intervalMinutes 1 is kept', clampSettings(withPoll(1)).poll.intervalMinutes === 1);
    t.check('intervalMinutes 1440 is kept', clampSettings(withPoll(1440)).poll.intervalMinutes === 1440);
    t.check('intervalMinutes 0 clamps up to 1',
      clampSettings(withPoll(0)).poll.intervalMinutes === 1);
    t.check('intervalMinutes 1441 clamps down to 1440',
      clampSettings(withPoll(1441)).poll.intervalMinutes === 1440);
    t.check('intervalMinutes NaN falls back to the default',
      clampSettings(withPoll(NaN)).poll.intervalMinutes === 30);
    t.check('intervalMinutes Infinity falls back to the default',
      clampSettings(withPoll(Infinity)).poll.intervalMinutes === 30);
    t.check('intervalMinutes missing falls back to the default',
      clampSettings({ ...DEFAULT_SETTINGS, poll: { ...DEFAULT_SETTINGS.poll, intervalMinutes: undefined } })
        .poll.intervalMinutes === 30);

    t.section('clamp: poll.favoriteIntervalMinutes');

    const fav = (n) =>
      clampSettings({
        ...DEFAULT_SETTINGS,
        poll: { ...DEFAULT_SETTINGS.poll, favoriteIntervalMinutes: n },
      }).poll.favoriteIntervalMinutes;
    t.check('favoriteIntervalMinutes 0 is preserved', fav(0) === 0);
    t.check('favoriteIntervalMinutes 1 is kept', fav(1) === 1);
    t.check('favoriteIntervalMinutes 1440 is kept', fav(1440) === 1440);
    t.check('favoriteIntervalMinutes 1441 clamps down to 1440', fav(1441) === 1440);
    t.check('favoriteIntervalMinutes NaN falls back to the default', fav(NaN) === 10);
    t.check('favoriteIntervalMinutes -1 clamps up to 1', fav(-1) === 1);

    t.section('clamp: feed.maxItems');

    const maxItems = (n) =>
      clampSettings({
        ...DEFAULT_SETTINGS,
        feed: { ...DEFAULT_SETTINGS.feed, maxItems: n },
      }).feed.maxItems;
    t.check('maxItems 50 is kept', maxItems(50) === 50);
    t.check('maxItems 5000 is kept', maxItems(5000) === 5000);
    t.check('maxItems 49 clamps up to 50', maxItems(49) === 50);
    t.check('maxItems 5001 clamps down to 5000', maxItems(5001) === 5000);
    t.check('maxItems NaN falls back to the default', maxItems(NaN) === 500);

    t.section('clamp: dropped groups');

    t.check(
      'a leftover channelWindow group is dropped',
      !('channelWindow' in clampSettings({
        ...DEFAULT_SETTINGS,
        channelWindow: { refreshMinutes: 10, width: 480, height: 760 },
      })),
    );

    t.section('clamp: locale and booleans');

    const loc = (locale) =>
      clampSettings({ ...DEFAULT_SETTINGS, ui: { locale } }).ui.locale;
    t.check("locale 'auto' is kept", loc('auto') === 'auto');
    t.check("locale 'en' is kept", loc('en') === 'en');
    t.check("locale 'ar' is kept", loc('ar') === 'ar');
    t.check("locale 'fr' falls back to 'auto'", loc('fr') === 'auto');
    t.check("locale '' falls back to 'auto'", loc('') === 'auto');
    t.check('theme defaults to system', DEFAULT_SETTINGS.ui.theme === 'system');
    const theme = (value) =>
      clampSettings({ ...DEFAULT_SETTINGS, ui: { theme: value } }).ui.theme;
    t.check("theme 'system' is kept", theme('system') === 'system');
    t.check("theme 'light' is kept", theme('light') === 'light');
    t.check("theme 'dark' is kept", theme('dark') === 'dark');
    t.check("theme 'neon' falls back to 'system'", theme('neon') === 'system');
    t.check("theme '' falls back to 'system'", theme('') === 'system');
    t.check("theme 'Light' falls back to 'system'", theme('Light') === 'system');
    t.check('theme 1 falls back to system', theme(1) === 'system');
    t.check(
      'missing theme falls back to system',
      clampSettings({ ui: {} }).ui.theme === 'system',
    );
    t.check(
      'a theme patch keeps the locale',
      clampSettings({ ui: { locale: 'ar', theme: 'dark' } }).ui.locale === 'ar',
    );
    t.check('boolean 1 coerces to true',
      clampSettings({ ...DEFAULT_SETTINGS, alerts: { ...DEFAULT_SETTINGS.alerts, enabled: 1 } })
        .alerts.enabled === true);
    t.check('boolean 0 coerces to false',
      clampSettings({ ...DEFAULT_SETTINGS, alerts: { ...DEFAULT_SETTINGS.alerts, enabled: 0 } })
        .alerts.enabled === false);
    t.check(
      'favoritesOnly defaults off',
      DEFAULT_SETTINGS.feed.favoritesOnly === false,
    );
    t.check(
      'favoritesOnly 1 coerces to true',
      clampSettings({
        ...DEFAULT_SETTINGS,
        feed: { ...DEFAULT_SETTINGS.feed, favoritesOnly: 1 },
      }).feed.favoritesOnly === true,
    );
    t.check(
      'feed.group defaults to All',
      DEFAULT_SETTINGS.feed.group === '',
    );
    t.check(
      'feed.group keeps a trimmed name',
      clampSettings({
        ...DEFAULT_SETTINGS,
        feed: { ...DEFAULT_SETTINGS.feed, group: '  Music  ' },
      }).feed.group === 'Music',
    );
    t.check(
      'feed.group junk becomes All',
      clampSettings({
        ...DEFAULT_SETTINGS,
        feed: { ...DEFAULT_SETTINGS.feed, group: 1 },
      }).feed.group === '',
    );
    t.check(
      'groupsOnYouTube defaults on',
      DEFAULT_SETTINGS.feed.groupsOnYouTube === true,
    );
    t.check(
      'groupsOnYouTube 0 coerces to false',
      clampSettings({
        ...DEFAULT_SETTINGS,
        feed: { ...DEFAULT_SETTINGS.feed, groupsOnYouTube: 0 },
      }).feed.groupsOnYouTube === false,
    );
    t.check(
      'groupsOnYouTube 1 coerces to true',
      clampSettings({
        ...DEFAULT_SETTINGS,
        feed: { ...DEFAULT_SETTINGS.feed, groupsOnYouTube: 1 },
      }).feed.groupsOnYouTube === true,
    );
    t.check(
      'groupsOnYouTube false stays false',
      clampSettings({
        ...DEFAULT_SETTINGS,
        feed: { ...DEFAULT_SETTINGS.feed, groupsOnYouTube: false },
      }).feed.groupsOnYouTube === false,
    );
    t.check(
      'a missing groupsOnYouTube stays on',
      clampSettings({ feed: { showShorts: true } }).feed.groupsOnYouTube === true,
    );

    t.section('clamp: audio.restoreQuality');

    t.check(
      'audio.restoreQuality defaults to hd720',
      DEFAULT_SETTINGS.audio.restoreQuality === 'hd720',
    );
    const rq = (q) =>
      clampSettings({
        ...DEFAULT_SETTINGS,
        audio: { ...DEFAULT_SETTINGS.audio, restoreQuality: q },
      }).audio.restoreQuality;
    t.check("restoreQuality 'hd720' is kept", rq('hd720') === 'hd720');
    t.check("restoreQuality 'hd1080' is kept", rq('hd1080') === 'hd1080');
    t.check("restoreQuality 'hd1440' is kept", rq('hd1440') === 'hd1440');
    t.check("restoreQuality 'hd2160' is kept", rq('hd2160') === 'hd2160');
    t.check("restoreQuality 'highres' is kept", rq('highres') === 'highres');
    t.check("restoreQuality 'auto' is kept", rq('auto') === 'auto');
    t.check("restoreQuality 'medium' is kept", rq('medium') === 'medium');
    t.check("restoreQuality 'large' is kept", rq('large') === 'large');
    t.check("restoreQuality 'tiny' is kept", rq('tiny') === 'tiny');
    t.check("restoreQuality 'small' is kept", rq('small') === 'small');
    t.check("restoreQuality 'unknown' falls back to hd720", rq('unknown') === 'hd720');
    t.check("restoreQuality '' falls back to hd720", rq('') === 'hd720');
    t.check('restoreQuality 720 falls back to hd720', rq(720) === 'hd720');
    t.check(
      'missing audio group is filled from defaults',
      clampSettings({ ...DEFAULT_SETTINGS, audio: undefined }).audio.restoreQuality === 'hd720',
    );
    t.check(
      'partial audio merge keeps restoreQuality at default',
      clampSettings({ audio: {} }).audio.restoreQuality === 'hd720',
    );

    t.section('clamp: audio look');

    t.check('preset defaults to midnight', DEFAULT_SETTINGS.audio.preset === 'midnight');
    t.check('backgroundType defaults to color', DEFAULT_SETTINGS.audio.backgroundType === 'color');
    t.check(
      'customColor defaults to the midnight from-stop',
      DEFAULT_SETTINGS.audio.customColor === '#0f0f14',
    );
    t.check('imageUrl is not a setting', !('imageUrl' in DEFAULT_SETTINGS.audio));
    t.check(
      'openFeedInAudioMode defaults to false',
      DEFAULT_SETTINGS.audio.openFeedInAudioMode === false,
    );

    const audioOf = (over) =>
      clampSettings({
        ...DEFAULT_SETTINGS,
        audio: { ...DEFAULT_SETTINGS.audio, ...over },
      }).audio;

    t.check(
      'openFeedInAudioMode true is kept',
      audioOf({ openFeedInAudioMode: true }).openFeedInAudioMode === true,
    );
    t.check(
      'openFeedInAudioMode false is kept',
      audioOf({ openFeedInAudioMode: false }).openFeedInAudioMode === false,
    );
    t.check(
      'missing openFeedInAudioMode coerces to false',
      clampSettings({ audio: {} }).audio.openFeedInAudioMode === false,
    );

    for (const p of ['midnight', 'slate', 'ember', 'amber', 'forest', 'sunset', 'custom']) {
      t.check(`preset '${p}' is kept`, audioOf({ preset: p }).preset === p);
    }
    t.check("preset 'neon' falls back to midnight", audioOf({ preset: 'neon' }).preset === 'midnight');
    t.check("preset '' falls back to midnight", audioOf({ preset: '' }).preset === 'midnight');
    t.check("preset 'Midnight' falls back to midnight", audioOf({ preset: 'Midnight' }).preset === 'midnight');
    t.check('preset 1 falls back to midnight', audioOf({ preset: 1 }).preset === 'midnight');

    t.check(
      "backgroundType 'color' is kept",
      audioOf({ backgroundType: 'color' }).backgroundType === 'color',
    );
    t.check(
      "backgroundType 'image' is kept",
      audioOf({ backgroundType: 'image' }).backgroundType === 'image',
    );
    t.check(
      "backgroundType 'gradient' falls back to color",
      audioOf({ backgroundType: 'gradient' }).backgroundType === 'color',
    );
    t.check(
      "backgroundType '' falls back to color",
      audioOf({ backgroundType: '' }).backgroundType === 'color',
    );

    t.check(
      'customColor #112233 is kept',
      audioOf({ customColor: '#112233' }).customColor === '#112233',
    );
    t.check(
      'customColor is lowercased',
      audioOf({ customColor: '#AABBCC' }).customColor === '#aabbcc',
    );
    t.check(
      '3-digit customColor falls back to midnight',
      audioOf({ customColor: '#fff' }).customColor === '#0f0f14',
    );
    t.check(
      'named customColor falls back to midnight',
      audioOf({ customColor: 'red' }).customColor === '#0f0f14',
    );
    t.check(
      'empty customColor falls back to midnight',
      audioOf({ customColor: '' }).customColor === '#0f0f14',
    );
    t.check(
      'non-string customColor falls back to midnight',
      audioOf({ customColor: 1 }).customColor === '#0f0f14',
    );

    t.check(
      'https imageUrl is dropped',
      !('imageUrl' in audioOf({ imageUrl: 'https://example.com/bg.jpg' })),
    );
    t.check(
      'data:image imageUrl is dropped from settings',
      !('imageUrl' in audioOf({ imageUrl: 'data:image/png;base64,aaa' })),
    );
    t.check(
      'javascript imageUrl is dropped',
      !('imageUrl' in audioOf({ imageUrl: 'javascript:alert(1)' })),
    );

    const fullLook = {
      openFeedInAudioMode: false,
      restoreQuality: 'hd1080',
      preset: 'forest',
      backgroundType: 'image',
      customColor: '#14763a',
    };
    t.check(
      'a full audio group round-trips',
      same(clampSettings({ audio: fullLook }).audio, fullLook),
    );
    const partialLook = clampSettings({ audio: { restoreQuality: 'tiny' } }).audio;
    t.check(
      'partial audio merge keeps look defaults',
      partialLook.restoreQuality === 'tiny'
        && partialLook.preset === 'midnight'
        && partialLook.backgroundType === 'color'
        && partialLook.customColor === '#0f0f14'
        && !('imageUrl' in partialLook),
    );
    t.check(
      'junk look keys fall back without dropping restoreQuality',
      same(clampSettings({
        audio: {
          restoreQuality: 'large',
          preset: 'nope',
          backgroundType: 'nope',
          customColor: 'blue',
          imageUrl: 'ftp://x',
        },
      }).audio, {
        openFeedInAudioMode: false,
        restoreQuality: 'large',
        preset: 'midnight',
        backgroundType: 'color',
        customColor: '#0f0f14',
      }),
    );

    t.section('audio cover migration');

    const dataUrl = 'data:image/jpeg;base64,aaa';
    await globalThis.chrome.storage.local.clear();
    await globalThis.chrome.storage.local.set({
      settings: {
        ...DEFAULT_SETTINGS,
        audio: { ...DEFAULT_SETTINGS.audio, imageUrl: dataUrl },
      },
    });
    const moved = await migrateAudioCover();
    t.check('data imageUrl is moved onto audioCover', moved.writeCover === true && moved.cover === dataUrl);
    const afterMove = await globalThis.chrome.storage.local.get(['settings', AUDIO_COVER_KEY]);
    t.check('audioCover holds the data URL', afterMove[AUDIO_COVER_KEY] === dataUrl);
    t.check(
      'imageUrl is gone from stored settings after a data move',
      !('imageUrl' in (afterMove.settings?.audio || {})),
    );

    await globalThis.chrome.storage.local.clear();
    await globalThis.chrome.storage.local.set({
      settings: {
        ...DEFAULT_SETTINGS,
        audio: { ...DEFAULT_SETTINGS.audio, imageUrl: 'https://example.com/bg.jpg' },
      },
    });
    const httpsGone = await migrateAudioCover();
    t.check('https imageUrl is not copied onto audioCover', httpsGone.writeCover === false);
    const afterDrop = await globalThis.chrome.storage.local.get(['settings', AUDIO_COVER_KEY]);
    t.check('https leftover does not create audioCover', afterDrop[AUDIO_COVER_KEY] === undefined);
    t.check(
      'https imageUrl is gone from stored settings',
      !('imageUrl' in (afterDrop.settings?.audio || {})),
    );

    t.section('writeSettings');

    await globalThis.chrome.storage.local.clear();
    await writeSettings({ alerts: { enabled: false } });
    const patched = await readSettings();
    t.check('deep partial patch applies', patched.alerts.enabled === false);
    t.check('siblings in the same group survive',
      patched.alerts.notifyNormal === true && patched.alerts.useAvatarIcon === true);
    t.check('other groups survive', patched.poll.enabled === true && patched.feed.maxItems === 500);

    await writeSettings({ feed: { group: 'Podcasts' } });
    const grouped = await readSettings();
    t.check('feed.group survives a write', grouped.feed.group === 'Podcasts');
    await writeSettings({ feed: { showShorts: true } });
    const keptGroup = await readSettings();
    t.check(
      'a later feed patch keeps group',
      keptGroup.feed.group === 'Podcasts' && keptGroup.feed.showShorts === true,
    );
    t.check(
      'groupsOnYouTube stays on across a feed patch',
      keptGroup.feed.groupsOnYouTube === true,
    );

    await writeSettings({ poll: { intervalMinutes: 45 } });
    const later = await readSettings();
    t.check('a later patch does not flatten an earlier one',
      later.alerts.enabled === false && later.poll.intervalMinutes === 45);
    t.check('poll siblings survive a nested patch', later.poll.enabled === true);

    t.section('onSettingsChanged');

    await globalThis.chrome.storage.local.clear();
    const seen = [];
    const stop = onSettingsChanged((s) => seen.push(s));
    await writeSettings({ feed: { showShorts: true } });
    t.check('fires with merged settings',
      seen.length === 1
        && seen[0].feed.showShorts === true
        && seen[0].feed.maxItems === 500
        && seen[0].poll.intervalMinutes === 30,
      JSON.stringify(seen[0]?.feed));
    stop();
    await writeSettings({ feed: { showShorts: false } });
    t.check('unsubscribe actually stops it', seen.length === 1, String(seen.length));
  } finally {
    mock.restore();
  }

  t.check('restore puts chrome back', globalThis.chrome === previous);
}
