/**
 * Canonical settings object and its chrome.storage.local persistence.
 * Settings sit on their own key so a reset cannot wipe channels or the feed.
 */

import { AUDIO_COVER_KEY, planAudioCoverMigration } from './cover.js';
import { normalizeGroupName } from './view.js';

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
    // '' is All. A name that is not on any channel is treated as All.
    group: '',
    // Chips on youtube.com/feed/subscriptions. Off leaves that page alone.
    groupsOnYouTube: true,
  },
  ui: {
    // 'auto' follows the browser; 'en' | 'ar' pin a language.
    locale: 'auto',
    // 'system' follows the OS; 'light' | 'dark' pin the extension pages.
    theme: 'system',
  },
  audio: {
    // Off: the row opens normally and its button opens in audio mode. On: those swap.
    openFeedInAudioMode: false,
    // Fallback only. A captured 720p/1080p/4K still wins on switch-off.
    restoreQuality: 'hd720',
    // Overlay look. The six named presets match overlay.css; custom
    // uses customColor (midnight's from-stop when unset).
    preset: 'midnight',
    backgroundType: 'color',
    customColor: '#0f0f14',
  },
};

const LOCALES = new Set(['auto', 'en', 'ar']);
const THEMES = new Set(['system', 'light', 'dark']);

// Same strings as the player API; see docs/youtube.md.
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

const AUDIO_PRESETS = new Set([
  'midnight',
  'slate',
  'ember',
  'amber',
  'forest',
  'sunset',
  'custom',
]);

const AUDIO_BG_TYPES = new Set(['color', 'image']);

function clampHexColor(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const v = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return '#' + v.slice(1).toLowerCase();
  return fallback;
}

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
      group: typeof feed.group === 'string' ? normalizeGroupName(feed.group) : d.feed.group,
      groupsOnYouTube: boolOf(feed, 'groupsOnYouTube', d.feed.groupsOnYouTube),
    },
    ui: {
      // Anything outside the shipped locales follows the browser language.
      locale: LOCALES.has(ui.locale) ? ui.locale : 'auto',
      // Anything outside the shipped themes follows the OS.
      theme: THEMES.has(ui.theme) ? ui.theme : 'system',
    },
    audio: {
      openFeedInAudioMode: boolOf(audio, 'openFeedInAudioMode', d.audio.openFeedInAudioMode),
      restoreQuality: PLAYBACK_QUALITIES.has(audio.restoreQuality)
        ? audio.restoreQuality
        : d.audio.restoreQuality,
      preset: AUDIO_PRESETS.has(audio.preset) ? audio.preset : d.audio.preset,
      backgroundType: AUDIO_BG_TYPES.has(audio.backgroundType)
        ? audio.backgroundType
        : d.audio.backgroundType,
      customColor: clampHexColor(audio.customColor, d.audio.customColor),
    },
  };
}

export async function readSettings() {
  const { settings } = await globalThis.chrome.storage.local.get('settings');
  return clampSettings(merge(DEFAULT_SETTINGS, settings));
}

/**
 * Move a leftover settings.audio.imageUrl onto audioCover (data URLs only)
 * and drop the field. An https leftover is discarded on purpose so the
 * YouTube page never fetches a third-party picture.
 */
export async function migrateAudioCover() {
  const got = await globalThis.chrome.storage.local.get(['settings', AUDIO_COVER_KEY]);
  const plan = planAudioCoverMigration(got.settings, got[AUDIO_COVER_KEY]);
  const writes = {};
  if (plan.writeCover) writes[AUDIO_COVER_KEY] = plan.cover;
  if (plan.stripImageUrl) {
    writes.settings = clampSettings(merge(DEFAULT_SETTINGS, got.settings));
  }
  if (Object.keys(writes).length) await globalThis.chrome.storage.local.set(writes);
  return plan;
}

export async function writeSettings(patch) {
  await migrateAudioCover();
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
