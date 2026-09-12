/**
 * Canonical settings object and its chrome.storage.local persistence.
 * Settings sit on their own key so a reset cannot wipe channels or the feed.
 */

export const DEFAULT_SETTINGS = {
  poll: {
    enabled: true,
    // Chrome silently floors alarm periods under a minute. The RSS
    // cache-control is 15 minutes, so a faster poll only helps because
    // the fetch passes cache:'no-cache'.
    intervalMinutes: 30,
    // Own alarm for starred channels. 0 turns that alarm off.
    favoriteIntervalMinutes: 10,
  },
  alerts: {
    enabled: true,
    notifyNormal: true,
    // Starred channels always alert while the master switch is on.
    useAvatarIcon: true,
  },
  feed: {
    maxItems: 500,
    showShorts: false,
    favoritesOnly: false,
  },
  ui: {
    // 'auto' follows the browser; 'en' | 'ar' pin a language.
    locale: 'auto',
  },
  audio: {
    // Fallback only. A captured 720p/1080p/4K still wins on switch-off.
    restoreQuality: 'hd720',
  },
};

const LOCALES = new Set(['auto', 'en', 'ar']);

// Same strings as the player API / DESIGN.md §13.6.
const PLAYBACK_QUALITIES = new Set([
  'tiny',
  'small',
  'medium',
  'large',
  'hd720',
  'hd1080',
  'hd1440',
  'hd2160',
  'highres',
  'auto',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Overlay `stored` onto `defaults`. Unknown keys are ignored so a removed
 * setting cannot haunt the object after it leaves the defaults.
 */
function merge(defaults, stored) {
  if (!isPlainObject(stored)) return structuredClone(defaults);
  const out = structuredClone(defaults);
  for (const [key, value] of Object.entries(stored)) {
    if (!(key in out)) continue;
    if (value === undefined) continue;
    const base = out[key];
    if (isPlainObject(base) && isPlainObject(value)) {
      out[key] = merge(base, value);
    } else if (!isPlainObject(base)) {
      out[key] = value;
    }
  }
  return out;
}

function clampMinutes(value, fallback, allowZero) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (allowZero && n === 0) return 0;
  // Chrome silently clamps alarm periods below a minute.
  if (n < 1) return 1;
  if (n > 1440) return 1440;
  return n;
}

function clampRange(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function boolOf(obj, key, fallback) {
  return key in obj ? !!obj[key] : fallback;
}

export function clampSettings(s) {
  const src = isPlainObject(s) ? s : {};
  const poll = isPlainObject(src.poll) ? src.poll : {};
  const alerts = isPlainObject(src.alerts) ? src.alerts : {};
  const feed = isPlainObject(src.feed) ? src.feed : {};
  const ui = isPlainObject(src.ui) ? src.ui : {};
  const audio = isPlainObject(src.audio) ? src.audio : {};
  const d = DEFAULT_SETTINGS;

  return {
    poll: {
      enabled: boolOf(poll, 'enabled', d.poll.enabled),
      intervalMinutes: clampMinutes(poll.intervalMinutes, d.poll.intervalMinutes, false),
      // 0 is a real setting (the favourite alarm is off), not a missing value.
      favoriteIntervalMinutes: clampMinutes(
        poll.favoriteIntervalMinutes,
        d.poll.favoriteIntervalMinutes,
        true,
      ),
    },
    alerts: {
      enabled: boolOf(alerts, 'enabled', d.alerts.enabled),
      notifyNormal: boolOf(alerts, 'notifyNormal', d.alerts.notifyNormal),
      useAvatarIcon: boolOf(alerts, 'useAvatarIcon', d.alerts.useAvatarIcon),
    },
    feed: {
      // Below 50 the feed feels empty; 5000 is still a few hundred KB.
      maxItems: clampRange(feed.maxItems, 50, 5000, d.feed.maxItems),
      showShorts: boolOf(feed, 'showShorts', d.feed.showShorts),
      favoritesOnly: boolOf(feed, 'favoritesOnly', d.feed.favoritesOnly),
    },
    ui: {
      // Anything outside the shipped locales follows the browser language.
      locale: LOCALES.has(ui.locale) ? ui.locale : 'auto',
    },
    audio: {
      restoreQuality: PLAYBACK_QUALITIES.has(audio.restoreQuality)
        ? audio.restoreQuality
        : d.audio.restoreQuality,
    },
  };
}

export async function readSettings() {
  const { settings } = await globalThis.chrome.storage.local.get('settings');
  return clampSettings(merge(DEFAULT_SETTINGS, settings));
}

export async function writeSettings(patch) {
  const current = await readSettings();
  const next = clampSettings(merge(current, patch));
  await globalThis.chrome.storage.local.set({ settings: next });
  return next;
}

export function onSettingsChanged(callback) {
  const listener = (changes, area) => {
    if (area !== 'local' || !changes || !changes.settings) return;
    callback(clampSettings(merge(DEFAULT_SETTINGS, changes.settings.newValue)));
  };
  globalThis.chrome.storage.onChanged.addListener(listener);
  return () => globalThis.chrome.storage.onChanged.removeListener(listener);
}
