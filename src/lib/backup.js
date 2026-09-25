/**
 * Export and import of settings plus the channel list. Pure: no chrome,
 * no DOM, never throws on bad input.
 *
 * The feed, the classification cache, and the listen-later queue are
 * not in the file — the feed rebuilds from the channel list, restoring
 * a stale feed would walk it backwards, and the queue is a local
 * playback list.
 */

import { DEFAULT_SETTINGS, clampSettings } from './settings.js';
import { isChannelId, isAvatarUrl } from './yt.js';
import { sanitizeChannelGroups, sanitizeListGroups } from './view.js';

// The file format's id predates the extension's current name. Changing it
// would make every backup already on someone's disk unreadable.
const APP = 'youtube-companion';
const VERSION = 1;

// Every channel is one ~21 KB feed request per check, from the user's own IP,
// so 2,000 channels is already about 42 MB a check. A file asking for more
// would have the extension hammer YouTube in the user's name. A real
// 2,000-channel export is under 1 MB; 2 MB leaves room without letting a
// huge file stall the popup.
export const MAX_BACKUP_CHANNELS = 2000;
export const MAX_BACKUP_BYTES = 2_000_000;

// Codes, not sentences: the popup turns each into a message in the
// person's language (backupImportMessage in view.js).
const ERR = {
  json: 'json',
  app: 'app',
  version: 'version',
  channels: 'channels',
  id: 'id',
  size: 'size',
  count: 'count',
  merge: 'merge',
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(error) {
  return { ok: false, error };
}

function usableId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// The same cleaning Takeout and the YouTube import give a file's text:
// titles are shown as text, never markup, so control characters are the
// only thing that could still upset a row.
function cleanTitle(value) {
  return typeof value === 'string'
    ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200)
    : '';
}

// A bad handle is left blank; the next check reads it from the channel.
function cleanHandle(value) {
  const handle = typeof value === 'string' ? value.trim() : '';
  return /^@[^\s/?#@]{1,100}$/.test(handle) ? handle : '';
}

function cloneData(value) {
  try {
    return structuredClone(value);
  } catch {
    return {};
  }
}

/**
 * Overlay `patch` onto `base`. Unknown keys are ignored so a removed
 * setting cannot haunt the object after it leaves the defaults.
 */
function overlay(base, patch) {
  if (!isPlainObject(patch)) return structuredClone(base);
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in out)) continue;
    if (value === undefined) continue;
    const current = out[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      out[key] = overlay(current, value);
    } else if (!isPlainObject(current)) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * lastFetchAt, lastError, and seeded describe a moment on the machine
 * that wrote the file. Carrying them across would skip the silent seed
 * or keep a stale error, so they are left out and reset on import.
 */
function exportChannel(raw) {
  const id = usableId(raw?.id);
  if (!id) return null;
  const addedAt = Number(raw.addedAt);
  const lastVideoAt = Number(raw.lastVideoAt);
  return {
    id,
    handle: typeof raw.handle === 'string' ? raw.handle : '',
    title: typeof raw.title === 'string' ? raw.title : '',
    avatar: typeof raw.avatar === 'string' ? raw.avatar : '',
    favorite: !!raw.favorite,
    muted: !!raw.muted,
    groups: sanitizeChannelGroups(raw.groups),
    addedAt: Number.isFinite(addedAt) ? addedAt : 0,
    lastVideoAt: Number.isFinite(lastVideoAt) ? lastVideoAt : 0,
  };
}

/**
 * A restore is a new listing, so addedAt is the import time — the first
 * check quiets uploads older than 24 hours before that. lastVideoAt is
 * kept so rows the file already knew stay quiet.
 */
function normalizeChannel(raw, now) {
  const id = usableId(raw?.id);
  if (!isChannelId(id)) return null;
  const lastVideoAt = Number(raw.lastVideoAt);
  return {
    id,
    handle: cleanHandle(raw.handle),
    title: cleanTitle(raw.title),
    // The popup shows it as an <img> and alerts use it as their icon, so an
    // address from a file would be fetched. Only YouTube's own hosts load.
    avatar: isAvatarUrl(raw.avatar) ? raw.avatar : '',
    favorite: !!raw.favorite,
    muted: !!raw.muted,
    groups: sanitizeChannelGroups(raw.groups),
    addedAt: now,
    // A date past now, from a wrong clock or an edited file, would keep
    // every upload before it quiet until that day comes.
    lastVideoAt: Number.isFinite(lastVideoAt) && lastVideoAt > 0 ? Math.min(lastVideoAt, now) : 0,
    lastFetchAt: 0,
    lastError: null,
    seeded: false,
  };
}

function exportSettings(settings) {
  const cloned = isPlainObject(settings) ? cloneData(settings) : {};
  // The cover lives on its own storage key and is never in this file. A
  // leftover imageUrl from 1.x would re-introduce a third-party fetch.
  if (isPlainObject(cloned.audio) && 'imageUrl' in cloned.audio) {
    delete cloned.audio.imageUrl;
  }
  delete cloned.audioCover;
  delete cloned.rateNoteDone;
  delete cloned.whatsNewSeen;
  return cloned;
}

export function buildBackup({ settings, channels } = {}) {
  const list = Array.isArray(channels) ? channels : [];
  const exported = [];
  for (const ch of list) {
    const row = exportChannel(ch);
    if (row) exported.push(row);
  }
  return {
    app: APP,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    settings: exportSettings(settings),
    channels: exported,
  };
}

/** The error for a file of `size` bytes or characters, or '' when it fits. */
export function backupSizeError(size) {
  return Number(size) > MAX_BACKUP_BYTES ? ERR.size : '';
}

export function parseBackup(text) {
  if (typeof text !== 'string') return fail(ERR.json);
  if (backupSizeError(text.length)) return fail(ERR.size);

  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail(ERR.json);
  }

  if (!isPlainObject(raw)) return fail(ERR.app);
  if (raw.app !== APP) return fail(ERR.app);
  if (Number(raw.version) !== VERSION) return fail(ERR.version);
  if (!Array.isArray(raw.channels)) return fail(ERR.channels);
  if (raw.channels.length > MAX_BACKUP_CHANNELS) return fail(ERR.count);

  // One bad id rejects the whole file: the extension only ever exports real
  // ids, so a file with anything else was edited or made elsewhere.
  for (const entry of raw.channels) {
    if (!isChannelId(usableId(entry?.id))) return fail(ERR.id);
  }

  return { ok: true, data: raw };
}

export function mergeBackup(current, incoming, mode) {
  const src = isPlainObject(current) ? current : {};
  const file = isPlainObject(incoming) ? incoming : {};
  const replace = mode === 'replace';
  const now = Date.now();

  const incomingList = Array.isArray(file.channels) ? file.channels : [];
  const currentList = Array.isArray(src.channels) ? src.channels : [];

  let settings;
  if (replace) {
    settings = clampSettings(overlay(DEFAULT_SETTINGS, file.settings));
  } else {
    const live = overlay(DEFAULT_SETTINGS, src.settings);
    settings = clampSettings(overlay(live, file.settings));
  }

  const next = [];
  const seen = new Set();
  let added = 0;
  let skipped = 0;

  if (!replace) {
    // The live record is newer than a file, so an id already present
    // keeps its favourite and mute flags and stamps instead of the file's.
    for (const ch of currentList) {
      const id = usableId(ch?.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      next.push({ ...ch });
    }
  }

  for (const raw of incomingList) {
    const row = normalizeChannel(raw, now);
    if (!row) continue;
    if (seen.has(row.id)) {
      skipped++;
      continue;
    }
    seen.add(row.id);
    next.push(row);
    added++;
  }

  // Replace is already capped by parseBackup. Merge keeps every live
  // channel, so live + new can pass the ceiling even when the file itself
  // is under it. Refuse the whole file; adding a prefix would hide that.
  if (!replace && next.length > MAX_BACKUP_CHANNELS) {
    return {
      settings,
      channels: currentList.slice(),
      added: 0,
      skipped: 0,
      error: ERR.merge,
    };
  }

  return { settings, channels: sanitizeListGroups(next), added, skipped };
}
