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
} from '../src/lib/settings.js';

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

    t.section('writeSettings');

    await globalThis.chrome.storage.local.clear();
    await writeSettings({ alerts: { enabled: false } });
    const patched = await readSettings();
    t.check('deep partial patch applies', patched.alerts.enabled === false);
    t.check('siblings in the same group survive',
      patched.alerts.notifyNormal === true && patched.alerts.useAvatarIcon === true);
    t.check('other groups survive', patched.poll.enabled === true && patched.feed.maxItems === 500);

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
